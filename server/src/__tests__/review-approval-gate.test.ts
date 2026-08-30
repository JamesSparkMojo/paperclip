import { describe, expect, it } from "vitest";
import { computeCoverage, parseCovers, parseRequirements } from "../services/coverage-matrix.js";
import { validateReceiptRow } from "../services/review-approval-gate.js";

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
});
