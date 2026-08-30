// server/src/services/coverage-matrix.ts
//
// Port of platform/pm-team/process-reviews/detectors/coverage-matrix.mjs
// pure helpers (extractRequirementsSection, parseRequirements, parseCovers,
// computeCoverage). The server cannot import the detector (CLI+HTTP) directly;
// this is a TS port of the dependency-free functions, ~60 LoC.

export interface CoverageRow {
  id: number;
  text: string;
  children: string[];
  statuses: string[];
}

export interface CoverageResult {
  ok: boolean;
  reasons: string[];
  rows: CoverageRow[];
  requirementCount: number;
  leafCount: number;
}

export function extractRequirementsSection(description: string | null | undefined): string | null {
  if (typeof description !== "string") return null;
  const m = description.match(/^## Requirements\s*$/m);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const rest = description.slice(start);
  const next = rest.match(/\n## /);
  return next && next.index !== undefined ? rest.slice(0, next.index) : rest;
}

const REQ_LINE_RE = /^-\s*\*{0,2}R(\d+)\*{0,2}\s*[:—-]\s*(.+?)\s*$/;

export function parseRequirements(description: string | null | undefined): Map<number, string> | null {
  const section = extractRequirementsSection(description);
  if (section === null) return null;
  const reqs = new Map<number, string>();
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(REQ_LINE_RE);
    if (m) {
      const id = Number(m[1]);
      reqs.set(id, m[2]);
    }
  }
  return reqs;
}

export function parseCovers(description: string | null | undefined): number[] {
  if (typeof description !== "string") return [];
  const m = description.match(/Covers:\s*(.+)/i);
  if (!m) return [];
  const ids: number[] = [];
  for (const t of m[1].matchAll(/R(\d+)/gi)) {
    ids.push(Number(t[1]));
  }
  return ids;
}

function childLabel(child: { identifier?: string | null; id?: string | null }): string {
  return child.identifier ?? child.id ?? "(unknown child)";
}

export function computeCoverage(
  input: { parent: { description?: string | null } | null | undefined; children: Array<{ identifier?: string | null; id?: string | null; description?: string | null; status?: string | null }> | null | undefined },
  opts: { requireDone?: boolean } = {},
): CoverageResult {
  const reasons: string[] = [];
  const requireDone = opts.requireDone ?? false;

  if (!input.parent || typeof input.parent !== "object") {
    return { ok: false, reasons: ["parent is missing or not an object"], rows: [], requirementCount: 0, leafCount: 0 };
  }
  if (!Array.isArray(input.children)) {
    return { ok: false, reasons: ["children is missing or not an array"], rows: [], requirementCount: 0, leafCount: 0 };
  }

  const requirements = parseRequirements(input.parent.description ?? null);
  if (requirements === null) {
    reasons.push("no requirements section -- decomposition did not author requirement IDs");
    return { ok: false, reasons, rows: [], requirementCount: 0, leafCount: 0 };
  }
  if (requirements.size === 0) {
    reasons.push("## Requirements section present but no `- R<n>: ...` lines parsed");
    return { ok: false, reasons, rows: [], requirementCount: 0, leafCount: 0 };
  }

  const coverageByReq = new Map<number, Array<(typeof input.children)[number]>>(
    [...requirements.keys()].map((id) => [id, []]),
  );
  const unknownRefs: Array<{ child: (typeof input.children)[number]; reqId: number }> = [];

  for (const child of input.children) {
    const covers = parseCovers(child?.description ?? null);
    for (const reqId of covers) {
      if (requirements.has(reqId)) {
        coverageByReq.get(reqId)!.push(child);
      } else {
        unknownRefs.push({ child, reqId });
      }
    }
  }

  if (unknownRefs.length > 0) {
    for (const { child, reqId } of unknownRefs) {
      reasons.push(`${childLabel(child)} cites unknown requirement R${reqId}`);
    }
  }

  const uncovered = [...requirements.keys()].filter((id) => (coverageByReq.get(id)?.length ?? 0) === 0);
  if (uncovered.length > 0) {
    reasons.push(`uncovered requirement(s): ${uncovered.map((id) => `R${id}`).join(", ")}`);
  }

  const coveringChildren = new Set<(typeof input.children)[number]>();
  for (const list of coverageByReq.values()) {
    for (const child of list) coveringChildren.add(child);
  }

  if (requireDone) {
    for (const child of coveringChildren) {
      if (child.status !== "done") {
        reasons.push(`${childLabel(child)} covers a requirement but status is "${child.status}", not "done"`);
      }
    }
  }

  const rows: CoverageRow[] = [...requirements.entries()].map(([id, text]) => {
    const covering = coverageByReq.get(id) ?? [];
    return {
      id,
      text,
      children: covering.map(childLabel),
      statuses: covering.map((c) => c.status ?? "(no status)"),
    };
  });

  return {
    ok: reasons.length === 0,
    reasons,
    rows,
    requirementCount: requirements.size,
    leafCount: coveringChildren.size,
  };
}
