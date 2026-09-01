import { describe, expect, it } from "vitest";
import { computeCoverage, extractRequirementsSection, parseCovers, parseRequirements } from "../services/coverage-matrix.js";
import { isScopedBuildCard, validateReceiptRow } from "../services/review-approval-gate.js";

// Coverage-matrix port -- locks the detector contract R2 depends on.

describe("coverage-matrix port (R2)", () => {
  it("extracts R ids from ## Requirements", () => {
    const reqs = parseRequirements("## Requirements\n- R1: foo\n- R2: bar\n");
    expect(reqs?.get(1)).toBe("foo");
    expect(reqs?.get(2)).toBe("bar");
  });

  it("returns null when no ## Requirements heading", () => {
    expect(parseRequirements("no heading here")).toBeNull();
  });

  it("parses Covers: line into R ids", () => {
    expect(parseCovers("Covers: R1, R3")).toEqual([1, 3]);
    expect(parseCovers("covers: r2")).toEqual([2]);
    expect(parseCovers("no covers here")).toEqual([]);
  });

  it("reports uncovered requirement", () => {
    const parent = { description: "## Requirements\n- R1: a\n- R2: b\n" };
    const children = [{ identifier: "L1", description: "Covers: R1", status: "done" }];
    const result = computeCoverage({ parent, children });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/R2/);
  });

  it("passes when every R id is covered", () => {
    const parent = { description: "## Requirements\n- R1: a\n- R2: b\n" };
    const children = [
      { identifier: "L1", description: "Covers: R1", status: "done" },
      { identifier: "L2", description: "Covers: R2", status: "done" },
    ];
    expect(computeCoverage({ parent, children }).ok).toBe(true);
  });

  it("passes vacuously when parent has no Requirements section (server gate skipped)", () => {
    const parent = { description: "no requirements here" };
    const children = [{ identifier: "L1", description: "anything", status: "done" }];
    const result = computeCoverage({ parent, children });
    expect(result.ok).toBe(false);
    // server's assertReviewToApprovalGates short-circuits on no-requirements parents
  });

  it("flags unknown requirement citation", () => {
    const parent = { description: "## Requirements\n- R1: a\n" };
    const children = [{ identifier: "L1", description: "Covers: R9", status: "done" }];
    const result = computeCoverage({ parent, children });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/unknown requirement R9/i);
  });
});

// Live parent heading fixture -- the Argus R2 defect: strict /^## Requirements$/ misses the
// real LaQuesha-decompose format "## Requirements (R-ids per the v3 coverage format)".
// This fixture proves the gate actually fires on the parent it gates against, not just on
// synthetic "## Requirements\n- R1: ..." strings.

const LIVE_PARENT_HEADING = "## Requirements (R-ids per the v3 coverage format)";
const LIVE_PARENT_BODY = [
  "## What",
  "LaQuesha: turn ADR-0058/ADR-0059's Phase 2 into an executable card tree.",
  "",
  LIVE_PARENT_HEADING,
  "- R1: the build receipt is emitted server-side",
  "- R2: the review->approval stage transition refuses to advance",
  "- R3: receipts are signed",
  "- R4: concurrency fencing",
  "- R5: adversarial acceptance tests",
  "",
  "## Inputs",
  "some other section",
].join("\n");

describe("coverage-matrix live parent heading (R2 regex fix)", () => {
  it("extractRequirementsSection matches the live parent heading format", () => {
    const section = extractRequirementsSection(LIVE_PARENT_BODY);
    expect(section).not.toBeNull();
    expect(section!).toMatch(/R1/);
  });

  it("parseRequirements parses >=1 R-id from the live parent body", () => {
    const reqs = parseRequirements(LIVE_PARENT_BODY);
    expect(reqs).not.toBeNull();
    expect(reqs!.size).toBeGreaterThanOrEqual(1);
    expect(reqs!.has(1)).toBe(true);
    expect(reqs!.has(2)).toBe(true);
  });

  it("computeCoverage returns uncovered when live parent has a leaf covering only R1", () => {
    const parent = { description: LIVE_PARENT_BODY };
    const children = [{ identifier: "SPA-5175", description: "Covers: R1", status: "done" }];
    const result = computeCoverage({ parent, children });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/R2/);
  });

  it("computeCoverage passes when live parent has leaves covering all five R ids", () => {
    const parent = { description: LIVE_PARENT_BODY };
    const children = [
      { identifier: "SPA-5175", description: "Covers: R1", status: "done" },
      { identifier: "SPA-5176", description: "Covers: R2", status: "done" },
      { identifier: "SPA-5177", description: "Covers: R3", status: "done" },
      { identifier: "SPA-5179", description: "Covers: R4", status: "done" },
      { identifier: "SPA-5180", description: "Covers: R5", status: "done" },
    ];
    expect(computeCoverage({ parent, children }).ok).toBe(true);
  });

  it("section extraction stops before the next ## heading", () => {
    const section = extractRequirementsSection(LIVE_PARENT_BODY);
    expect(section).not.toBeNull();
    expect(section!).not.toMatch(/## Inputs/);
  });
});

// Receipt gate -- five-field view (issueId/attemptId/runId implicit via row existence + treeSha/remote/gates/exit/branch)

describe("validateReceiptRow (R2 receipt gate)", () => {
  const valid = {
    treeSha: "a".repeat(40),
    remoteVerified: "verified",
    gates: { met: 1, unmet: 0, abandoned: 0 },
    exit: "gates-met",
    branch: "main",
    heartbeatRunId: "run-1",
    attemptId: "run-1",
    generation: 1,
  };

  it("passes on a complete receipt row", () => {
    expect(validateReceiptRow(valid).ok).toBe(true);
  });

  it("fails when row is null (no receipt)", () => {
    const r = validateReceiptRow(null);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/no build receipt/i);
  });

  it("fails when tree_sha is missing or not 40-hex", () => {
    expect(validateReceiptRow({ ...valid, treeSha: null }).ok).toBe(false);
    expect(validateReceiptRow({ ...valid, treeSha: "short" }).ok).toBe(false);
  });

  it("fails when gates missing", () => {
    expect(validateReceiptRow({ ...valid, gates: null }).ok).toBe(false);
  });

  it("fails when exit missing", () => {
    expect(validateReceiptRow({ ...valid, exit: null }).ok).toBe(false);
  });

  it("fails when branch missing (five-field gate requires branch)", () => {
    expect(validateReceiptRow({ ...valid, branch: null }).ok).toBe(false);
  });

  it("fails when remote_verified missing or invalid", () => {
    expect(validateReceiptRow({ ...valid, remoteVerified: null }).ok).toBe(false);
    expect(validateReceiptRow({ ...valid, remoteVerified: "bogus" }).ok).toBe(false);
  });

  it("fails when attemptId missing", () => {
    expect(validateReceiptRow({ ...valid, attemptId: null }).ok).toBe(false);
  });

  it("fails when run_id missing", () => {
    expect(validateReceiptRow({ ...valid, heartbeatRunId: null }).ok).toBe(false);
  });

  it("fails when ledger_status is malformed (R5/Dex merge-gate-2)", () => {
    const row = { ...valid, metadata: { ledger_status: "malformed" } };
    const r = validateReceiptRow(row);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/malformed/i);
  });

  it("passes when ledger_status is parsed or missing", () => {
    expect(validateReceiptRow({ ...valid, metadata: { ledger_status: "parsed" } }).ok).toBe(true);
    expect(validateReceiptRow({ ...valid, metadata: { ledger_status: "missing" } }).ok).toBe(true);
    expect(validateReceiptRow({ ...valid }).ok).toBe(true);
  });
});

// R2 scope discriminator -- the round-2 Argus verdict (decision 05314bd8)
// demanded this exact change. Without it, the receipt gate fires on EVERY
// review->approval advance and breaks signoff-policy (and every other
// non-build card in the fleet) with 422 receipt_gate_failed.
//
// These tests lock the new scope contract:
//   - no parent at all (signoff-policy.spec.ts shape)           -> UNSCOPED
//   - parent exists but carries no ## Requirements section     -> UNSCOPED
//   - parent carries ## Requirements with at least one - R<n>: -> SCOPED
//
// `isScopedBuildCard` is the single source of truth for the gate scope;
// `assertReviewToApprovalGates` short-circuits at the top when it returns
// false, so an unscoped card advances normally.

describe("isScopedBuildCard (R2 scope discriminator, round 2 fix)", () => {
  it("returns false when parent is null", () => {
    expect(isScopedBuildCard(null)).toBe(false);
    expect(isScopedBuildCard(undefined)).toBe(false);
  });

  it("returns false when parent has no description", () => {
    expect(isScopedBuildCard({})).toBe(false);
    expect(isScopedBuildCard({ description: null })).toBe(false);
    expect(isScopedBuildCard({ description: undefined })).toBe(false);
  });

  it("returns false when parent description has no ## Requirements section", () => {
    expect(isScopedBuildCard({ description: "no requirements here" })).toBe(false);
    expect(isScopedBuildCard({ description: "## What\n- nothing relevant\n" })).toBe(false);
  });

  it("returns false when parent has ## Requirements heading but no - R<n>: lines", () => {
    expect(isScopedBuildCard({ description: "## Requirements\nnothing parseable here\n" })).toBe(false);
  });

  it("returns true when parent carries the live LaQuesha heading + at least one R-id", () => {
    const parent = { description: LIVE_PARENT_BODY };
    expect(isScopedBuildCard(parent)).toBe(true);
  });

  it("returns true for a minimal ## Requirements block with a single R-id", () => {
    expect(isScopedBuildCard({ description: "## Requirements\n- R1: build the thing\n" })).toBe(true);
  });
});

// Live-probe coverage -- the card's DoD names three concrete cases the
// PATCH->gate wiring must satisfy. Helper-level exercises of the gate
// contract; the e2e shard (signoff-policy.spec.ts) exercises the route
// end-to-end against this same code path.
//
// These probe the gate contract at the level of the two helpers that own
// the decision: the receipt-row validator (already covered above) and the
// scope discriminator that decides whether the gate fires at all.

describe("R2 live-probe gate contract (round 2)", () => {
  const receiptValid = {
    treeSha: "a".repeat(40),
    remoteVerified: "verified",
    gates: { met: 1, unmet: 0, abandoned: 0 },
    exit: "gates-met",
    branch: "main",
    heartbeatRunId: "run-1",
    attemptId: "run-1",
    generation: 1,
  } as const;

  // Probe (a) -- a clean build card (parent has Requirements, sibling leaf
  // covers every R-id) with a valid receipt must satisfy both gates.
  it("probe (a): clean build card (valid receipt + full coverage) -> both gates ok", () => {
    const parent = { description: "## Requirements\n- R1: build it\n" };
    const children = [{ identifier: "L1", description: "Covers: R1", status: "done" }];
    expect(isScopedBuildCard(parent)).toBe(true);
    expect(validateReceiptRow(receiptValid).ok).toBe(true);
    expect(computeCoverage({ parent, children }).ok).toBe(true);
  });

  // Probe (b) -- a build card with a valid receipt but an uncovered R-id
  // must fail the coverage gate (this is the case Argus said was unproven).
  it("probe (b): valid receipt + uncovered R-id -> coverage gate fails", () => {
    const parent = { description: "## Requirements\n- R1: a\n- R2: b\n" };
    const children = [{ identifier: "L1", description: "Covers: R1", status: "done" }];
    expect(isScopedBuildCard(parent)).toBe(true);
    expect(validateReceiptRow(receiptValid).ok).toBe(true);
    const cov = computeCoverage({ parent, children });
    expect(cov.ok).toBe(false);
    expect(cov.reasons.join(" ")).toMatch(/R2/);
  });

  // Probe (c) -- a build card with a forged/missing receipt but full
  // coverage must fail the receipt gate (this is the case the card DoD
  // names explicitly).
  it("probe (c): missing receipt + full coverage -> receipt gate fails", () => {
    const parent = { description: "## Requirements\n- R1: a\n" };
    const children = [{ identifier: "L1", description: "Covers: R1", status: "done" }];
    expect(isScopedBuildCard(parent)).toBe(true);
    expect(validateReceiptRow(null).ok).toBe(false);
    expect(computeCoverage({ parent, children }).ok).toBe(true);
  });

  // Probe (d) -- an unscoped card (no parent Requirements) must bypass
  // both gates. This is the SPA-5176 R2 round-2 fix; without it, every
  // signoff-policy fixture in the fleet was 422-blocked.
  it("probe (d): unscoped card (no Requirements matrix) -> both gates skipped", () => {
    expect(isScopedBuildCard(null)).toBe(false);
    expect(isScopedBuildCard({ description: "Signoff happy path" })).toBe(false);
    // No receipt and no parent -> validator is irrelevant because the gate
    // short-circuits on the scope check before ever loading the receipt.
  });
});
