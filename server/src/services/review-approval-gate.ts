// server/src/services/review-approval-gate.ts
//
// R2 -- server-enforced review -> approval stage transition gate.
//
// ADR-0058 Decision 5 Phase 2: the review-to-approval transition refuses to
// advance when the receipt gate or coverage gate fails. The reviewer cannot
// override; the server returns 422. This file owns the two gates; the route
// layer calls `assertReviewToApprovalGates` before advancing.
//
// Receipt gate (R1): a build_receipts row must exist for the issue and carry
// the five binding fields (issueId, attemptId, runId, generation, treeSha)
// plus the trust signals (remote_verified, gates, exit). We check the row
// itself; field-level nulls are caught even though the columns are NOT NULL
// in the schema -- a forged row inserted outside the emitter would still
// fail the SHA/remote/gates shape checks.
//
// Coverage gate: when the parent carries a `## Requirements` section with
// `- R<n>:` lines, every R-id must be covered by some leaf's `Covers:` line.
// Uses the ported coverage-matrix detector (coverage-matrix.ts). Parents
// without a Requirements section are vacuous and pass.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { buildReceipts, issues } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { getLatestBuildReceiptForIssue } from "./build-receipts.js";
import { computeCoverage, parseRequirements } from "./coverage-matrix.js";

const SHA40_RE = /^[0-9a-f]{40}$/i;

export interface ReceiptGateResult {
  ok: boolean;
  reasons: string[];
}

export function validateReceiptRow(row: {
  treeSha?: string | null;
  remoteVerified?: string | null;
  gates?: { met?: number; unmet?: number; abandoned?: number } | null;
  exit?: string | null;
  branch?: string | null;
  heartbeatRunId?: string | null;
  attemptId?: string | null;
  generation?: number | null;
  metadata?: Record<string, unknown> | null;
} | null): ReceiptGateResult {
  const reasons: string[] = [];
  if (!row) {
    return { ok: false, reasons: ["no build receipt row for this issue"] };
  }
  if (!row.treeSha || !SHA40_RE.test(row.treeSha)) {
    reasons.push("receipt tree_sha missing or not 40-hex");
  }
  if (!row.heartbeatRunId || typeof row.heartbeatRunId !== "string" || row.heartbeatRunId.length === 0) {
    reasons.push("receipt run_id missing");
  }
  if (!row.attemptId || typeof row.attemptId !== "string" || row.attemptId.length === 0) {
    reasons.push("receipt attempt_id missing");
  }
  if (row.generation === null || row.generation === undefined || typeof row.generation !== "number") {
    reasons.push("receipt generation missing");
  }
  if (!row.remoteVerified || !["verified", "unverified", "unknown"].includes(row.remoteVerified)) {
    reasons.push("receipt remote_verified missing or not tri-state");
  }
  if (!row.gates || typeof row.gates.met !== "number" || typeof row.gates.unmet !== "number" || typeof row.gates.abandoned !== "number") {
    reasons.push("receipt gates missing or malformed");
  }
  if (!row.exit || typeof row.exit !== "string" || row.exit.length === 0) {
    reasons.push("receipt exit missing");
  }
  // R1 stores the raw ledger parse outcome in `metadata.ledger_status`.
  // A value of "malformed" means the file was present but empty/unparseable;
  // the receipt exists but its backing ledger cannot be trusted. Treat as a
  // gate failure so R5/Dex merge-gate-2 can distinguish the row from "no
  // receipt". Flag for SPA-5180; this intentionally fails-closed.
  if (row.metadata && (row.metadata as Record<string, unknown>)["ledger_status"] === "malformed") {
    reasons.push("receipt ledger_status is malformed");
  }
  // branch is nullable in schema but for R2 we require it to be a non-empty string
  // when present -- a null branch still indicates the emitter ran but lacked
  // workspace context; treat as field-level fail.
  if (row.branch !== null && row.branch !== undefined && typeof row.branch !== "string") {
    reasons.push("receipt branch malformed");
  }
  if (row.branch !== null && row.branch !== undefined && row.branch.trim().length === 0) {
    reasons.push("receipt branch empty");
  }
  // Require branch to be non-null for the five-field view (treeSha, remoteVerified, gates, exit, branch)
  if (row.branch === null || row.branch === undefined) {
    reasons.push("receipt branch missing");
  }

  return { ok: reasons.length === 0, reasons };
}

// R2 scope discriminator (exported for tests).
//
// A "build card" subject to the BUILD MODEL v3 Phase 2 hardening is a leaf
// whose parent carries a `## Requirements` matrix with `- R<n>: ...` lines.
// That matrix is what LaQuesha authors when decomposing a hardened plan
// (see ADR-0058 Decision 5) and is the contract R3/R4/R5 will build on. A
// card without that scope -- a signoff-policy exercise, a one-off feature
// card, an ad-hoc operational task -- is OUT OF SCOPE: neither the receipt
// gate nor the coverage gate should fire, and the review->approval advance
// must proceed as it did pre-R2.
//
// This is the discriminator Argus required at round 2 -- both gates share
// it, so an unscoped card can never be 422-blocked again (SPA-5506 class
// stall) while a scoped card is still gated on both receipts and coverage.
export function isScopedBuildCard(parent: { description?: string | null } | null | undefined): boolean {
  if (!parent) return false;
  const reqs = parseRequirements(parent.description ?? null);
  return reqs !== null && reqs.size > 0;
}

function isParentWithRequirements(parent: { description?: string | null } | null): boolean {
  if (!parent) return false;
  const reqs = parseRequirements(parent.description ?? null);
  return reqs !== null && reqs.size > 0;
}

export async function assertReviewToApprovalGates(input: {
  db: Db;
  companyId: string;
  issue: { id: string; parentId: string | null };
  activeStageType: string;
  nextStageType: string | null;
}): Promise<void> {
  if (input.activeStageType !== "review" || input.nextStageType !== "approval") {
    return;
  }

  // R2 scope: only cards whose parent carries a `## Requirements` matrix
  // are subject to the receipt + coverage gates. A card without a parent,
  // or with a parent that has no Requirements section, is OUT OF SCOPE and
  // advances normally. See `isScopedBuildCard` above for the rationale and
  // ADR-0058 Decision 5 for the parent-matrix contract.
  let parent: { id: string; description?: string | null } | null = null;
  if (input.issue.parentId) {
    const parentRows = await input.db
      .select({ id: issues.id, description: issues.description })
      .from(issues)
      .where(and(eq(issues.id, input.issue.parentId), eq(issues.companyId, input.companyId)))
      .limit(1);
    parent = parentRows[0] ?? null;
  }
  if (!isScopedBuildCard(parent)) {
    return;
  }

  // Receipt gate -- fires only for scoped build cards.
  const receipt = await getLatestBuildReceiptForIssue({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issue.id,
  });
  const receiptCheck = validateReceiptRow(
    receipt
      ? {
          treeSha: (receipt as unknown as { treeSha: string }).treeSha,
          remoteVerified: (receipt as unknown as { remoteVerified: string }).remoteVerified,
          gates: (receipt as unknown as { gates: { met: number; unmet: number; abandoned: number } }).gates,
          exit: (receipt as unknown as { exit: string }).exit,
          branch: (receipt as unknown as { branch: string | null }).branch,
          heartbeatRunId: (receipt as unknown as { heartbeatRunId: string }).heartbeatRunId,
          attemptId: (receipt as unknown as { attemptId: string }).attemptId,
          generation: (receipt as unknown as { generation: number }).generation,
          metadata: (receipt as unknown as { metadata: Record<string, unknown> | null }).metadata,
        }
      : null,
  );
  if (!receiptCheck.ok) {
    throw unprocessable("Review -> Approval blocked: receipt gate failed", {
      code: "receipt_gate_failed",
      reasons: receiptCheck.reasons,
    });
  }

  // Coverage gate -- only when the parent (now known to carry Requirements)
  // exists. We re-use `isScopedBuildCard` to keep the scope in lock-step
  // with the receipt gate; this means an unscoped card short-circuits at
  // the top and never reaches either gate.
  if (!parent) return;

  const siblings = await input.db
    .select({ id: issues.id, identifier: issues.identifier, description: issues.description, status: issues.status })
    .from(issues)
    .where(and(eq(issues.parentId, parent.id), eq(issues.companyId, input.companyId)));

  const coverage = computeCoverage({ parent, children: siblings });
  if (!coverage.ok) {
    throw unprocessable("Review -> Approval blocked: coverage gate failed", {
      code: "coverage_gate_failed",
      reasons: coverage.reasons,
      requirementCount: coverage.requirementCount,
      uncovered: coverage.reasons,
    });
  }
}
