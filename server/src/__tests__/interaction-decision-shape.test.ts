import { describe, expect, it } from "vitest";
import {
  evaluateBoardOnlyDecisionShape,
  evaluateDecisionShape,
  isWaitShapedPrompt,
  UNDERSPECIFIED_CONFIRMATION_MESSAGE,
  WAIT_SHAPED_CONFIRMATION_MESSAGE,
} from "../services/interaction-decision-shape.js";

// SPA-6006 evidence, captured verbatim from interaction 9b4e96b1-dd8f-497c-bd8b-49b6ab59b108
// (kind request_confirmation, requestedResolverPolicy board_only, live-fetched 2026-09-03).
const SPA_6006_PROMPT =
  "Codex review pending on PR #27 head a0b804012 — SPA-6006 fix (recovery backoff + workspace-inheritance disable + explicit-null clear). Gate history: 21/21 SUCCESS.";

describe("isWaitShapedPrompt", () => {
  it("flags the SPA-6006 prompt verbatim", () => {
    expect(isWaitShapedPrompt(SPA_6006_PROMPT)).toBe(true);
  });

  it("flags wait and status phrasing", () => {
    for (const prompt of [
      "Waiting for CI to finish before merge.",
      "Deploy is pending.",
      "Merge blocked on review.",
      "PR #123 awaiting Codex review.",
      "Run 88 is queued.",
    ]) {
      expect(isWaitShapedPrompt(prompt), prompt).toBe(true);
    }
  });

  it("does not flag a plain decision ask", () => {
    expect(isWaitShapedPrompt("Apply this plan? Recommended default: apply.")).toBe(false);
  });
});

describe("evaluateDecisionShape", () => {
  it("rejects the SPA-6006 prompt verbatim as wait-shaped", () => {
    expect(evaluateDecisionShape({
      version: 1,
      prompt: SPA_6006_PROMPT,
      allowDeclineReason: true,
      supersedeOnUserComment: true,
    })).toBe(WAIT_SHAPED_CONFIRMATION_MESSAGE);
  });

  it("rejects a free-text ask with no options and no details", () => {
    expect(evaluateDecisionShape({ prompt: "Proceed?" })).toBe(UNDERSPECIFIED_CONFIRMATION_MESSAGE);
  });

  it("accepts a law-16 shaped request carried in detailsMarkdown", () => {
    const payload = {
      prompt: "Promote the engine release to the staging fleet?",
      detailsMarkdown: [
        "Option A — promote now: unblocks the Willow UAT tenants tomorrow.",
        "Option B — hold one day: zero risk of hitting the open migration window.",
        "Impact: A exposes staging to the new indexer; B delays client onboarding by a day.",
        "Recommended default: A (promote now).",
        "If the board stays silent by 2026-09-05 17:00, we proceed with A.",
      ].join("\n"),
    };
    expect(evaluateDecisionShape(payload)).toBeNull();
  });

  it("rejects an optionless ask whose details lack a recommended default", () => {
    const payload = {
      prompt: "Should we promote?",
      detailsMarkdown: "Impact: some. If the board stays silent by 2026-09-05 we promote.",
    };
    expect(evaluateDecisionShape(payload)).toBe(UNDERSPECIFIED_CONFIRMATION_MESSAGE);
  });

  it("rejects an optionless ask whose details lack a dated silence clause", () => {
    const payload = {
      prompt: "Should we promote?",
      detailsMarkdown: "Impact: some. Recommended default: promote. Silence means we proceed eventually.",
    };
    expect(evaluateDecisionShape(payload)).toBe(UNDERSPECIFIED_CONFIRMATION_MESSAGE);
  });

  it("rejects checkbox payloads with fewer than two options", () => {
    const payload = {
      prompt: "Pick one.",
      options: [{ id: "only", label: "Only choice" }],
    };
    expect(evaluateDecisionShape(payload)).toBe(UNDERSPECIFIED_CONFIRMATION_MESSAGE);
  });

  it("rejects checkbox payloads whose options carry no impact in the prompt", () => {
    const payload = {
      prompt: "Promote now or hold?",
      options: [
        { id: "promote", label: "Promote now" },
        { id: "hold", label: "Hold one day" },
      ],
    };
    expect(evaluateDecisionShape(payload)).toBe(UNDERSPECIFIED_CONFIRMATION_MESSAGE);
  });

  it("accepts a checkbox payload with two options and a shaped summary", () => {
    const payload = {
      prompt: "Promote now or hold? Impact: promote exposes staging tonight; hold delays UAT by a day.",
      options: [
        { id: "promote", label: "Promote now", description: "Recommended default." },
        { id: "hold", label: "Hold one day" },
      ],
      detailsMarkdown: "Recommended default: promote now. If the board stays silent by 2026-09-05, promote happens.",
    };
    expect(evaluateDecisionShape(payload)).toBeNull();
  });
});

describe("evaluateBoardOnlyDecisionShape", () => {
  it("rejects the SPA-6006 wait-shaped confirmation with the routing resolution", () => {
    const error = evaluateBoardOnlyDecisionShape({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: SPA_6006_PROMPT,
        allowDeclineReason: true,
        supersedeOnUserComment: true,
      },
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("executionPolicy.monitor");
    expect(error?.details).toMatchObject({
      code: "board_only_decision_shape_required",
      kind: "request_confirmation",
    });
  });

  it("exempts tool-action confirmations", () => {
    expect(evaluateBoardOnlyDecisionShape({
      kind: "request_confirmation",
      payload: { prompt: SPA_6006_PROMPT, toolAction: { toolName: "shell" } },
    })).toBeNull();
  });

  it("exempts plan/document targets", () => {
    expect(evaluateBoardOnlyDecisionShape({
      kind: "request_confirmation",
      payload: { prompt: SPA_6006_PROMPT, target: { type: "issue_document", documentId: "d", revisionId: "r" } },
    })).toBeNull();
  });
});
