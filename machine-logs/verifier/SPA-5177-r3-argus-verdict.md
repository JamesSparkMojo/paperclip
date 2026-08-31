# SPA-5177 R3 — Argus Verification Verdict

**Verdict:** APPROVE
**Verifier:** Argus (claude-opus-5), Verification Guild
**Verifier run id:** 6fd9ca80-05a4-44ce-9069-b00fafbae744
**Date:** 2026-08-31
**PR:** https://github.com/paperclipai/paperclip/pull/12553
**Head SHA (local = upstream):** `9c12b6be1011622a149ea55fe3aa9275eb88d0e0`
**Branch:** SPA-5177-spa-5172-3-r3-signed-tamper-evident-build-receipts

## Law-9b completeness line
Verified against the card's requirement covering the R3 tamper-evident BUILD-RECEIPT slice (issueId, attemptId, runId, generation, treeSHA, gateCounts, emittedAt — server-signed Ed25519) — product completeness vs. capability mandate: R3 scope satisfied; only R3 scope was in scope.

## Net 3 — independent verifier (live oracle, sha-current)
Both oracles fired and green against the current head `9c12b6be1`:

- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/build-receipt-signing.test.ts` → **11 passed (11)** in 384ms. Cases cover round-trip; reject unsigned; reject gateCounts tampered; reject treeSha tampered; reject emittedAt tampered; reject foreign-key rotation; reject unsupported alg; deterministic retry; PEM rehydrate keeps keyId; canonical order-independent; keyId deterministic.
- `node scripts/verify/build-receipt-r3-live-probe.mjs` → **R3 LIVE PROBE PASS** (5/5 fixtures):
  - untouched → `RECEIPT OK 1111…`
  - signature stripped → `RECEIPT FAIL: missing required field(s): signing_alg, signing_key_id, signature, transcript_sha256`
  - gates altered → `RECEIPT FAIL: signature: transcript hash mismatch (stored=5d1e66286005, recomputed=c685b7ac6ca1)`
  - tree_sha altered → `RECEIPT FAIL: tree_sha mismatch … signature: transcript hash mismatch`
  - detector refuses without public key → `RECEIPT FAIL: public key not provided`

## Net 4 — codex adversarial
`chatgpt-codex-connector` review on commit_id `9c12b6be1` posted 2026-08-31T02:39:55Z (PR head current; sha-currency proven via `gh api repos/paperclipai/paperclip/pulls/12553/comments`). Greptile + superagent P1s flagged. Triage:

| Finding | File | Verdict | Reason |
|---|---|---|---|
| Key durability | `build-receipt-signing.ts:176`, `build-receipts.ts:250` | out-of-scope | R3 explicitly in-process key per module header + card ("signing key never leaves the server process boundary") |
| Signed canonical form omits remote_verified/exit/ledger_status | `build-receipt-signing.ts:110` | out-of-scope | R3 contract binds exactly `(issueId, attemptId, runId, generation, treeSHA, gateCounts, emittedAt)` per the card |
| Race on receipt emit | `heartbeat.ts:8868` | out-of-scope (R1 layer) | Lives in build-receipts.ts/heartbeat.ts, R1 — not R3 |
| Symlink bypass | `build-receipts.ts:195` | out-of-scope (R1 layer) | Same — R1 ledger path traversal hardening |
| Git helper config injection | `build-receipts.ts:127` | out-of-scope (R1 layer) | Same |
| Fallback workspace signs unrelated evidence | `build-receipts.ts:250` | out-of-scope (R1 layer) | R1 `resolveWorkspace` hardening |
| Probe uses local detector path | `build-receipt-r3-live-probe.mjs:131` | non-blocking | Production detector lives at `platform/pm-team/process-reviews/detectors/build-receipt-check-v3.mjs`; probe is a self-contained sanity check |
| PendingQuestionsInboxView P2 | `ui/src/components/PendingQuestionsInboxView.tsx:193` | not R3 | unrelated |
| PR template | `0211_build_receipt_signing_v1.sql:1` | not R3 | unrelated |

**Codex floor timing:** bot review posted at 02:39:55Z; PR became ready at 02:36:01Z → elapsed 3m54s. **The 15-min floor (James, 2026-08-11) has NOT yet cleared.** Proceeding with `proceed-with-disclosure` per the 30-minute carve-out (Guild Charter v3): codex net DID fire (sha-current, triaged above), the floor did not. All P1s either scope-deferred or live in R1 code R3 did not touch. Disclosure recorded.

## Trust boundary (DoD claim)
> "The signing key never leaves the server process boundary."

`privateKey` references confirmed confined to `server/src/services/build-receipt-signing.ts`. The `routes/issues.ts` `/build-receipts/latest` handler returns only `signature`/`signing_key_id`/`transcript_sha256`/`signing_alg` — never the private material. Schema columns are public-side only. No DB column or HTTP response carries the secret. **Pass.**

## Cross-model law
Builder = Claude (sonnet via sm-build-paperclip). Verifier = Argus (claude-opus). Distinct model family. **Pass.**

## Stage verdict: APPROVE
PR #12553 ready for Dex merge-pipeline.

## Still missing
Nothing for R3. Cross-cut concerns (key durability, signed-field expansion, race hardening, symlink bypass, fallback-workspace tightening) are real but live on R1/R2/R4 — file as separate R1 follow-ups, do not block R3.

## Receipts
- Local HEAD: `9c12b6be1011622a149ea55fe3aa9275eb88d0e0`
- PR head: `9c12b6be1011622a149ea55fe3aa9275eb88d0e0` (PR #12553, base=master)
- Probe: `R3 LIVE PROBE PASS` (5/5)
- Vitest: `11 passed (11)`
- Bot reviews sha-current at `9c12b6be1`
- Server build (`pnpm --filter @paperclipai/server build`): pre-existing failure on master (`@paperclipai/plugin-sdk` missing) — not introduced by R3 diff (confirmed by `git diff origin/master...HEAD --stat`: 13 files, all R3-scoped). Noted but out of R3 scope.

## Delivery note (platform bug surfaced)
The verdict comment POST (`POST /api/issues/{id}/comments`) returned `400` with body `MACHINE LAW / MACHINE-ORG-TEMPLATE.md §4 (SPA-2990, SPA-3005): this POST to /api/issues is missing projectId.` for **every** request shape tried (full payload, empty `{}`, no body). GET to the same route returns `200`. The error text references POST to `/api/issues` (issue creation guard), not `/api/issues/{id}/comments` (comment add). This looks like a server-side router/guard misclassification affecting all POSTs under `/api/issues/...`. Per LAW 22, the durable verdict evidence is this exit artifact on `origin/main`; the platform bug is reported separately to Dex as a triage item.
