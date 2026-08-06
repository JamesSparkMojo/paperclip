import { describe, expect, it } from "vitest";

import {
  ISSUE_REVIEW_POLICY_OPTIONS,
  formatReviewPolicyValue,
  issueReviewPolicyCopy,
  readIssueReviewPolicyMetadata,
  resolveIssueReviewPolicy,
} from "./review-policy";

describe("resolveIssueReviewPolicy", () => {
  it("treats a cleared column as the board default, not as an absent setting", () => {
    expect(resolveIssueReviewPolicy(null)).toBe("anyone");
    expect(resolveIssueReviewPolicy(undefined)).toBe("anyone");
  });

  it("passes the two opt-in constraints through", () => {
    expect(resolveIssueReviewPolicy("not_creator")).toBe("not_creator");
    expect(resolveIssueReviewPolicy("human_only")).toBe("human_only");
  });

  it("falls back to the default for a policy this build does not know", () => {
    expect(resolveIssueReviewPolicy("board_only" as never)).toBe("anyone");
  });
});

describe("policy copy", () => {
  it("labels every policy without leaking the enum value", () => {
    expect(issueReviewPolicyCopy(null).label).toBe("Anyone can approve");
    expect(issueReviewPolicyCopy("not_creator").label).toBe("Not the requester");
    expect(issueReviewPolicyCopy("human_only").label).toBe("People only");
  });

  // The settings row is narrow, so its value is a noun fragment that leans on
  // the row label. None of the three may truncate at phone width.
  it("keeps every row value short enough for a narrow panel", () => {
    expect(issueReviewPolicyCopy(null).triggerLabel).toBe("Anyone");
    for (const option of ISSUE_REVIEW_POLICY_OPTIONS) {
      expect(option.triggerLabel.length).toBeLessThanOrEqual("Not the requester".length);
    }
  });

  it("states who may give the verdict on each policy", () => {
    expect(issueReviewPolicyCopy(null).approverCopy).toContain("Anyone with write access");
    expect(issueReviewPolicyCopy("not_creator").approverCopy).toContain("other than the requester");
    expect(issueReviewPolicyCopy("human_only").approverCopy).toContain("Requires a human");
  });

  it("offers exactly the three states the board defined, default first", () => {
    expect(ISSUE_REVIEW_POLICY_OPTIONS.map((option) => option.value)).toEqual([
      "anyone",
      "not_creator",
      "human_only",
    ]);
  });

  it("gives every policy a distinct icon so the row is scannable", () => {
    const icons = ISSUE_REVIEW_POLICY_OPTIONS.map((option) => option.Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("formatReviewPolicyValue", () => {
  it("reads a cleared policy as 'anyone', never as 'none'", () => {
    expect(formatReviewPolicyValue(null)).toBe("anyone");
    expect(formatReviewPolicyValue(undefined)).toBe("anyone");
    expect(formatReviewPolicyValue("anyone")).toBe("anyone");
  });

  it("uses mid-sentence wording for the constraints", () => {
    expect(formatReviewPolicyValue("not_creator")).toBe("not the requester");
    expect(formatReviewPolicyValue("human_only")).toBe("people only");
  });

  it("humanizes an unknown policy rather than hiding it", () => {
    expect(formatReviewPolicyValue("board_only")).toBe("board only");
  });
});

describe("readIssueReviewPolicyMetadata", () => {
  it("reads the policy off an attention subject's metadata bag", () => {
    expect(readIssueReviewPolicyMetadata({ reviewPolicy: "human_only" })).toBe("human_only");
  });

  it("returns null when the subject carries no policy", () => {
    expect(readIssueReviewPolicyMetadata(null)).toBeNull();
    expect(readIssueReviewPolicyMetadata(undefined)).toBeNull();
    expect(readIssueReviewPolicyMetadata({ priority: "high" })).toBeNull();
  });

  it("rejects a value outside the enum instead of trusting the wire", () => {
    expect(readIssueReviewPolicyMetadata({ reviewPolicy: "board_only" })).toBeNull();
    expect(readIssueReviewPolicyMetadata({ reviewPolicy: 3 })).toBeNull();
  });
});
