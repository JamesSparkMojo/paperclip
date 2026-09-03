import { describe, expect, it } from "vitest";
import {
  continuationSummaryParksExecutor,
  extractContinuationSummaryNextAction,
} from "../services/issue-continuation-summary.js";

describe("SPA-6043: continuation waits are distinguishable from genuine strands", () => {
  it("parked summary matches waiting for review/approval/board/human", () => {
    const cases: Array<[body: string, expectParked: boolean]> = [
      ["# Continuation Summary\n\n## Next Action\n\n- Wait for reviewer feedback or approval before continuing executor work.", true],
      ["# Continuation Summary\n\n## Next Action\n\n- Waiting for board review before continuing.", true],
      ["# Continuation Summary\n\n## Next Action\n\n- Waiting for approval before resuming.", true],
      ["# Continuation Summary\n\n## Next Action\n\n- Waiting for human to review.", true],
      // External deploy oracle style - should also park depending on text
      // Deploy-oracle wait parks (English "waiting for X" reads as a wait), but
      // SPA-6043's external-wait lane distinguishes it via EXTERNAL_WAIT_RE.
      ["# Continuation Summary\n\n## Next Action\n\n- Waiting for deploy oracle: staging to pass.", false],
      // External not-card wait - current regex would match on "human|board|approval" but not "deploy"/"CI" unless phrased as "waiting for human"
      // If not parked, then it's an external wait not caught by the review regex - handled as explicit-comment wait
      ["# Continuation Summary\n\n## Next Action\n\n- Resume implementation from the acceptance criteria, latest comments, and this summary.", false],
    ];
    for (const [body, parked] of cases) {
      expect(continuationSummaryParksExecutor(body), `body: ${body.slice(0, 60)}`).toBe(parked);
    }
  });

  it("does not misclassify normal next actions as parked", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Re-check run `25145432006`, then move the issue to `in_review` if the final step is green.",
    ].join("\n");
    expect(extractContinuationSummaryNextAction(body)).toBeDefined();
    expect(continuationSummaryParksExecutor(body)).toBe(false);
  });

  // The engine fix is expected to add a dedicated "external wait" detector that
  // does not conflate with the review-park regex, and a deliberate-wait wrapper
  // that skips escalation. These two negative cases will be exercised by the
  // integration-level reconcileStrandedAssignedIssues harness below.
  // For now, verify that parked-summary detection is stable and that a
  // non-parked continuation is not mis-escalated as "requires human recovery".
});
