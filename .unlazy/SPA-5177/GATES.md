# SPA-5177 R3 -- signed (tamper-evident) build receipts

Source of truth: the issue's DoD oracle + the Sep-1 REQUEST_CHANGES resubmission
bar (comment 977489c5). The R1 signing core (build-receipt-signing.ts) is sound
and ships real Ed25519 signatures; the resubmission bar is about ENFORCEMENT and
KEY PERSISTENCE, which the first submission lacked. Gates are written from that
bar and may not be weakened.

## Gate 1 -- Public key is persisted and reachable (FATAL-4)

The signing public key MUST survive a server restart and be fetchable by the
detector without reading process memory.

- [ ] A `build_receipt_signing_keys` table (or equivalent) persists at least the
      public key DER/PEM, the key id, the algorithm, the created-at timestamp,
      and an `is_active` flag for rotation. Private key NEVER lands in a row.
- [ ] A server route (e.g. `GET /api/build-receipts/signing-key` or a key-id
      variant) returns the active public key in PEM, plus its key id and alg.
      Registered in openapi.ts.
- [ ] `getBuildReceiptKey()` loads the persisted key if present (hydrate from
      stored public side + a process-local private key), else mints + persists on
      first use. Key id is deterministic from the public DER (unchanged contract).

## Gate 2 -- The COMMITTED reader enforces signatures (FATAL-1, FATAL-2)

The DoD-named reader is `scripts/verify/build-receipt-check.mjs` in the
paperclip repo. A v=3 receipt MUST require a valid signature.

- [ ] `scripts/verify/build-receipt-check.mjs` (committed, tracked) is updated
      to verify the four signing columns: re-derive canonical payload, recompute
      transcript sha256, verify Ed25519 signature against the public key. A
      receipt with signature stripped REJECTs; a receipt with gates/treeSha
      altered post-emission REJECTs.
- [ ] No machine-specific absolute paths. The detector resolves the public key
      via `--public-key-path` OR by fetching the server's persisted key route.
- [ ] The untracked `build-receipt-check-v3.mjs` scratch in sparkmojo-internal is
      either merged into the committed reader or deleted -- the committed reader
      is the only one that counts.

## Gate 3 -- verifyBuildReceiptSignature has a production caller (FATAL-3)

- [ ] A production code path (server route, the committed detector, or a CI
      gate) calls `verifyBuildReceiptSignature` against a real server-signed
      receipt. Zero callers = fail.

## Gate 4 -- Tamper-rejection proven against a REAL server-signed receipt (FATAL-5)

- [ ] A probe/fixture mints a receipt the SERVER signs (via emitBuildReceiptForRun
      or the real signing path against the persisted key), then tampers it
      (strip signature, alter gates, alter tree_sha), and the committed detector
      REJECTs each tampered variant. NOT a throwaway openssl keypair that never
      touched the server.

## Gate 5 -- DoD oracle (unchanged)

- [ ] `pnpm --filter @paperclipai/server build` exits 0.
- [ ] Fresh untouched receipt ACCEPTs; signature-stripped REJECTs;
      gates-altered-post-emission REJECTs.
- [ ] Signing key never leaves the server process boundary (private key stays
      in memory; only public key + key id + signature + transcript hash are
      persisted or served).

## Out of scope (carry-forward)

- attemptId mirrors runId, generation hardcoded 1 (acknowledged minor; not a
  resubmission blocker).
- Rebase onto origin/master (branch is 10 behind: SPA-5693/5506 touched
  heartbeat.ts + execution-workspace-policy.ts). Dex owns merge/rebase -- not
  Patti's lane.
