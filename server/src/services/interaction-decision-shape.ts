// SPA-6051: board-only confirmations must carry the machine-law-16 decision
// shape (MACHINE-ORG-TEMPLATE.md §7 law 16: ELI5, options, impact of each,
// recommended default, what happens if the board stays silent — with a date).
// Evidence: SPA-6006 2026-09-03 — Patti's "Codex review pending on PR #27"
// confirmation landed in James's decisions list and stalled the card until a
// session declined it. A wait/status note is not a decision; the create path
// rejects it with a 422 that names the two sanctioned alternatives
// (executionPolicy.monitor, or the review stage).

/**
 * True when a prompt reads as a wait/status note rather than a decision ask:
 * it names a pending/waiting state, a gate actor (CI, Codex, deploy, merge,
 * review), or a PR/issue/run reference while carrying no decision options.
 * Deliberately broad — a shaped decision with options is accepted even when it
 * mentions these words (SPA-6051 spec: only option-less asks are rejected).
 */
export function isWaitShapedPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const waitWordRe = /\b(?:pending|waiting(?:\s+for)?|awaits?|awaiting|in\s+review|under\s+review|queued|running|blocked\s+on)\b/;
  const waitContextRe = /\b(?:ci|codex|deploy(?:ment)?|merge|review)\b/;
  const referenceRe = /\b(?:pr|issue|run)\s*#?\s*\d+\b|#\d+/;
  return waitWordRe.test(text)
    || (waitContextRe.test(text) && referenceRe.test(text));
}

const RECOMMENDED_DEFAULT_RE = /(?:^|[\n.;])\s*(?:[-*]\s*)?(?:\*\*)?recommended(?:\s+default)?(?:\*\*)?\s*[:\-]/i;
const SILENCE_CONSEQUENCE_RE = /if\s+(?:the\s+board\s+)?(?:stays?\s+)?silent|if\s+you\s+stay\s+silent|if\s+silent|no\s+response(?:\s+by)?|silence(?:\s+by)?/i;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\/\d{1,2}\b/i;

const DECISION_DIRECTIVE =
  "Arm executionPolicy.monitor or submit the work into the review stage instead of asking the board to confirm this.";

export const WAIT_SHAPED_CONFIRMATION_MESSAGE =
  "Board-only confirmations must be real decisions. This prompt reads as a wait or status note and carries no options. "
  + "A decision ask must offer two or more options with the impact of each, name a recommended default, and state what happens if the board stays silent (with a date). "
  + DECISION_DIRECTIVE;

export const UNDERSPECIFIED_CONFIRMATION_MESSAGE =
  "Board-only confirmations must be real decisions shaped per machine law 16: offer two or more options with the impact of each, "
  + "name a recommended default (a \"Recommended default:\" line), and state what happens if the board stays silent (with a date) — in the prompt or detailsMarkdown. "
  + DECISION_DIRECTIVE;

export type DecisionShapeConfirmationPayload = {
  prompt?: unknown;
  detailsMarkdown?: unknown;
  options?: unknown;
  toolAction?: unknown;
  target?: unknown;
};

function readOptions(payload: DecisionShapeConfirmationPayload): Array<{ label?: unknown; description?: unknown }> {
  const options = payload.options;
  return Array.isArray(options) ? options : [];
}

const DETAILS_OPTION_ENTRY_RE = /\boption\s+\S+/gi;

/**
 * Validates the law-16 decision shape for a board-only confirmation payload.
 * Returns null when the payload carries a decision, or a rejection message
 * naming what is missing. request_checkbox_confirmation carries its options
 * structurally; a request_confirmation payload has no options field, so the
 * two-plus-options-with-impact requirement is proven by enumerating "Option"
 * entries in detailsMarkdown. Either way a recommended default line and a
 * dated silence consequence are required.
 */
export function evaluateDecisionShape(
  payload: DecisionShapeConfirmationPayload,
): typeof WAIT_SHAPED_CONFIRMATION_MESSAGE | typeof UNDERSPECIFIED_CONFIRMATION_MESSAGE | null {
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const details = typeof payload.detailsMarkdown === "string" ? payload.detailsMarkdown : "";
  const options = readOptions(payload);
  const haystack = `${prompt}\n${details}`;

  if (options.length === 0) {
    if (isWaitShapedPrompt(prompt)) return WAIT_SHAPED_CONFIRMATION_MESSAGE;
    const optionEntries = details.match(DETAILS_OPTION_ENTRY_RE)?.length ?? 0;
    if (optionEntries < 2) return UNDERSPECIFIED_CONFIRMATION_MESSAGE;
  } else {
    if (options.length < 2) return UNDERSPECIFIED_CONFIRMATION_MESSAGE;
    const everyOptionDescribed = options.every(
      (option) => typeof option.description === "string" && option.description.trim().length > 0,
    );
    if (!everyOptionDescribed && !/\bimpact\b/i.test(haystack)) {
      return UNDERSPECIFIED_CONFIRMATION_MESSAGE;
    }
  }

  if (!RECOMMENDED_DEFAULT_RE.test(details)) return UNDERSPECIFIED_CONFIRMATION_MESSAGE;
  if (!SILENCE_CONSEQUENCE_RE.test(haystack) || !DATE_RE.test(haystack)) {
    return UNDERSPECIFIED_CONFIRMATION_MESSAGE;
  }
  return null;
}

export type BoardOnlyDecisionShapeInput = {
  kind: string;
  payload: unknown;
};

/**
 * Gate for SPA-6051. Returns null when the create may proceed, or
 * { message, details } for a 422. Scope: the confirmation kinds resolving to
 * board_only from an agent actor — the path whose pending card lands in the
 * board's decisions feed. request_item_verdicts is deliberately out of scope:
 * its items carry approve/reject/defer choices by construction, so it always
 * presents a real decision. Tool-action confirmations (machine flows) and
 * plan/document targets (server-validated approval flow) are exempt.
 */
export function evaluateBoardOnlyDecisionShape(
  input: BoardOnlyDecisionShapeInput,
): { message: string; details: Record<string, unknown> } | null {
  const payload = (input.payload ?? {}) as DecisionShapeConfirmationPayload;
  if (payload.toolAction !== undefined) return null;
  if (payload.target !== undefined && payload.target !== null) return null;
  const message = evaluateDecisionShape(payload);
  if (!message) return null;
  return {
    message,
    details: {
      code: "board_only_decision_shape_required",
      kind: input.kind,
      resolution: "Arm executionPolicy.monitor to wait on CI/review state, or submit the work into the review stage.",
    },
  };
}
