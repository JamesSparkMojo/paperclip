import { Users, UserMinus, UserRound, type LucideIcon } from "lucide-react";
import { ISSUE_REVIEW_POLICIES, type IssueReviewPolicy } from "@paperclipai/shared";

/**
 * Copy + affordances for an issue's `reviewPolicy` (PAP-16506 P4).
 *
 * `in_review` means the work needs a review verdict before it is done — from
 * anyone. By default each person *and each agent* with write access can
 * approve, including the agent that did the work. `reviewPolicy` is the
 * per-issue opt-in constraint on that default, and there are exactly two:
 *
 * - `not_creator` — the reviewer must not be the one who asked for the review.
 * - `human_only` — only a person can approve.
 *
 * A `null` column means "anyone", which is the default for every new *and*
 * existing issue — there is no backfill. Everything that renders the policy
 * routes through here so the settings control, the review card, and the
 * activity receipt never drift from each other or from the server's 403 copy
 * in `server/src/services/issue-review-policy.ts`.
 */

const DEFAULT_ISSUE_REVIEW_POLICY: IssueReviewPolicy = "anyone";

export interface IssueReviewPolicyCopy {
  value: IssueReviewPolicy;
  /** Short label for the settings trigger. */
  label: string;
  /** Mid-sentence wording for activity lines and change receipts. */
  valueLabel: string;
  /** One line explaining the rule, shown under the label in the picker. */
  description: string;
  /** Who may give the verdict — the review card's line. */
  approverCopy: string;
  Icon: LucideIcon;
}

const COPY: Record<IssueReviewPolicy, IssueReviewPolicyCopy> = {
  anyone: {
    value: "anyone",
    label: "Anyone can approve",
    valueLabel: "anyone",
    description: "Each person and each agent with write access can approve, including the agent that did the work.",
    approverCopy: "Anyone with write access can approve — people and agents alike.",
    Icon: Users,
  },
  not_creator: {
    value: "not_creator",
    label: "Not the requester",
    valueLabel: "not the requester",
    description: "The reviewer must not be the one who asked for the review.",
    approverCopy: "Requires a reviewer other than the requester.",
    Icon: UserMinus,
  },
  human_only: {
    value: "human_only",
    label: "People only",
    valueLabel: "people only",
    description: "Only a person can approve. Agents cannot give the verdict.",
    approverCopy: "Requires a human. Agents cannot approve this review.",
    Icon: UserRound,
  },
};

/** `null`/unknown → the board's default, so callers never branch on absence. */
export function resolveIssueReviewPolicy(
  policy: IssueReviewPolicy | null | undefined,
): IssueReviewPolicy {
  if (policy && policy in COPY) return policy as IssueReviewPolicy;
  return DEFAULT_ISSUE_REVIEW_POLICY;
}

export function issueReviewPolicyCopy(
  policy: IssueReviewPolicy | null | undefined,
): IssueReviewPolicyCopy {
  return COPY[resolveIssueReviewPolicy(policy)];
}

/**
 * Mid-sentence wording for an activity line or a field-change receipt, where a
 * cleared column must read "anyone" rather than "none".
 */
export function formatReviewPolicyValue(value: unknown): string {
  if (typeof value === "string" && !(value in COPY)) {
    // Forward-compatible: a policy this build does not know reads as itself.
    return value.replace(/_/g, " ");
  }
  return issueReviewPolicyCopy(value as IssueReviewPolicy | null | undefined).valueLabel;
}

/**
 * Read the policy off an untyped `AttentionSubject.metadata` bag. Absent or
 * unrecognised → `null`, which every consumer resolves to the default.
 */
export function readIssueReviewPolicyMetadata(
  metadata: Record<string, unknown> | null | undefined,
): IssueReviewPolicy | null {
  const raw = metadata?.reviewPolicy;
  if (typeof raw !== "string") return null;
  return (ISSUE_REVIEW_POLICIES as readonly string[]).includes(raw)
    ? (raw as IssueReviewPolicy)
    : null;
}

/** Picker options in "loosest first" order so the default reads as the baseline. */
export const ISSUE_REVIEW_POLICY_OPTIONS: readonly IssueReviewPolicyCopy[] =
  ISSUE_REVIEW_POLICIES.map((policy) => COPY[policy]);
