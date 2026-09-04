# Fork patch list — JamesSparkMojo/paperclip

This fork carries no `patches/*.patch` files of its own. Its deltas from
upstream are in-repo source changes; this file is the durable record of those
changes (the "fork patch list"). When a change here is superseded by an
upstream equivalent, move its row to "Superseded" with a pointer — do not
delete it.

Each row: what changed, where, why, and the verification receipt. SPA-6051
adds the journal-drift check (below) that runs before any rebuild.

## Active patches

| # | Change | Files | Why | Receipt |
|---|--------|-------|-----|---------|
| 1 | SPA-6051 board-only decision-shape gate — agent-created `request_confirmation` / `request_checkbox_confirmation` interactions resolving to `board_only` must carry the machine-law-16 shape (options + impact, recommended default, dated silence clause); wait-shaped or free-text asks are rejected 422 with a message naming `executionPolicy.monitor` or review-stage submission | `server/src/services/interaction-decision-shape.ts`, `server/src/services/issue-thread-interactions.ts` (create gate), `server/src/__tests__/interaction-decision-shape.test.ts`, fixtures in `server/src/__tests__/issue-thread-interactions-service.test.ts` | SPA-6006 evidence: Patti's "Codex review pending on PR #27" confirmation (interaction `9b4e96b1-dd8f-497c-bd8b-49b6ab59b108`, verbatim prompt in tests) landed in James's decisions feed and stalled the card until a session declined it | `npx vitest run src/__tests__/issue-thread-interactions-service.test.ts src/__tests__/interaction-decision-shape.test.ts` — 53/53; full 7-suite regression sweep 248/248 (2026-09-03) |
| 2 | SPA-6055 review reconciler honours a recorded stage decision — `reconcileStrandedAssignedIssues`' in_review branch consults `issue_execution_decisions` for the current stage before declaring "no completed decision"; a `changes_requested`/`approved` row with a still-pending executionState is repaired by replaying the canonical `applyIssueExecutionPolicyTransition` (status/assignee/executionState land, next actor woken) instead of the card being requeued then blocked. Newer-round guards prevent repairing a legitimate round-2 pending state (a review/approval wake armed after the decision, or a participant run started after it). Escalation comments name the looked-for decision id/stage id; result gains `reviewParticipantRepaired` | `server/src/services/recovery/service.ts` (helper `maybeRepairStuckReviewDecision`, comment builders, in_review branch wiring), `server/src/__tests__/heartbeat-process-recovery.test.ts` (SPA-6055 cases) | SPA-6031/F30: Argus recorded REQUEST_CHANGES (decision `cc57a29b`, 17:33 EDT); the card stayed `in_review`/pending and 36 min later the reconciler blocked it with "no completed decision or live reviewer run" though the decision row existed. Same reconciler also blocked on comment-only request-changes (F17) and recorded another card's verdict (F29/SPA-6054) — every review round on that card needed a hand | `node packages/db/src/check-migration-numbering.ts` → NUMBERING_OK; migration-safety → "20 historical finding(s) covered by baseline" (2026-09-03, worktree branch `SPA-6055-…`); unit tests — see the SPA-6055 cases in `heartbeat-process-recovery.test.ts` run receipt on the SPA-6055 PR |

## Superseded patches

(none)

## Journal-drift check (run before rebuilding)

The drizzle journal must always match the migration files on disk, or a
stale/mis-ordered migration set gets baked into the build:

```bash
node packages/db/src/check-migration-numbering.ts          # journal ↔ files, ordering, duplicates
TMPDIR=/tmp server/node_modules/.bin/tsx packages/db/src/check-migration-safety.ts   # safety rules vs baseline
```

Both run automatically as part of `pnpm --filter @paperclipai/db build`
(`check:migrations` script). The numbering check fails the build on any
journal/file count or order mismatch, so no separate drift script is needed —
the drift check IS the db build gate. Note: `tsx` inside a Paperclip run
sandbox fails with `listen EINVAL` on its IPC pipe; run it with `TMPDIR=/tmp`
(`TMPDIR=/tmp ./node_modules/.bin/tsx ...`).
