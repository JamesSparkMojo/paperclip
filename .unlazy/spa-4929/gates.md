# SPA-4929 — GATES

**Card:** SPA-4929 — surface pending interactions in `paperclipai issue get` output (paperclip fork)
**Branch:** `patti/spa-4929-pending-interactions-on-get` (rebased onto `origin/master`)
**Author:** Patti (build lane — re-route from Dex per Driver directive 2026-08-30)
**Type:** Solo (one deliverable: server embed + CLI render + unit test)

## Oracle (from card DoD)

> `paperclipai issue get <sandbox-issue>` against an issue with a fresh non-resolved `request_confirmation` prints the pending interaction(s) inline (id, kind, title, status, age). Sandbox proof required in PR description.

## Gates (lock once written, never weakened)

| ID | Gate | Pass criteria | Status |
|----|------|---------------|--------|
| G1 | Server embed | `GET /api/issues/:id` returns `pendingInteractions: [...]` filtered to `status === "pending"`; field omitted when empty | written, awaiting oracle |
| G2 | CLI human render | `paperclipai issue get <id>` (TTY, default ON) prints a `pendingInteraction` line per item with id/kind/status/age/title | written, awaiting oracle |
| G3 | CLI --json pass-through | `paperclipai issue get <id> --json` includes `pendingInteractions` array from server verbatim | written, awaiting oracle |
| G4 | Backwards-compat (omit empty) | When server omits `pendingInteractions`, CLI does not crash, falls back to `/api/issues/:id/interactions` for older servers | written, awaiting oracle |
| G5 | Opt-out | `--no-include-interactions` strips the array in both TTY and --json modes | written, awaiting oracle |
| G6 | Identifier fallback | CLI resolves human identifier (e.g. `PC-12`) to UUID via `row.id` before calling `/interactions` (UUID-only endpoint) | written, awaiting oracle |
| G7 | Unit tests | Vitest cases cover pending shown / resolved hidden / opt-out / identifier fallback; 13/13 pass | written, awaiting oracle |
| G8 | Sandbox proof | Live `paperclipai issue get` against fresh `request_confirmation` captured in PR body | written, awaiting oracle |
| G9 | Typecheck + build | `pnpm typecheck` + `pnpm build` exit 0 for cli package | written, awaiting oracle |
| G10 | PR open | Draft PR on `JamesSparkMojo/paperclip` against `master` with PR body containing G8 sandbox output | written, awaiting oracle |

## Deliverable = one PR containing

- server embed (`server/src/routes/issues.ts` getIssue route)
- CLI render (`cli/src/commands/client/issue.ts` get action)
- CLI tests (`cli/src/__tests__/issue-subresources.test.ts`)
- SPA-4908 commit (`--include-interactions` flag, prerequisite fallback path) — credit as separate-but-stacked card

## Out of scope (per card)

- aggregate `/attention` agent-token endpoint (James DR required)
- touching `issue interactions` subcommand
- altering interaction CRUD
- upstream UI inbox changes (PendingQuestionsInboxView reverted — branch rebased onto clean `origin/master`)

## Notes

- Dex already built this on `dex/spa-4929-pending-interactions-on-get` @ 1ede98752 with PR #6; rebase + retest onto `patti/spa-4929-pending-interactions-on-get` so PR authorship = Patti, not Dex.
- Dex's CLI filter `status === "pending"` is stricter than spec literal (`exclude {resolved,cancelled,expired,accepted,rejected}`); safer given real status enum includes `answered`/`failed` not in spec exclude list. Defensive deviation in correct direction.
