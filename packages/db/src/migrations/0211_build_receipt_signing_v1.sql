-- SPA-5177 R3: tamper-evident (signed) BUILD-RECEIPT rows.
--
-- R1 stored an unsigned row. The detector only had a "missing or mismatched"
-- check. R3 (this migration) adds:
--   * emitted_at          -- server-side timestamp captured at sign time, so
--                            the signature binds the canonical payload to a
--                            wall-clock moment the detector can compare.
--   * signing_alg         -- which algorithm signed the row (today: Ed25519;
--                            future: rotate to Ed448/HSM). Stored so the
--                            detector can refuse to accept rows signed with
--                            a now-retired algorithm.
--   * signing_key_id      -- which key fingerprint signed the row. Multiple
--                            keys may exist during a rotation; the detector
--                            must know which one was used.
--   * signature           -- base64url Ed25519 signature over the canonical
--                            payload, taken at insert time.
--   * transcript_sha256   -- sha256 over a deterministic JSON serialization
--                            of the signed payload. Lets the detector prove
--                            the receipt the server says it emitted matches
--                            the receipt under audit, without re-deriving the
--                            canonical form from scratch.
--
-- The server keeps the Ed25519 private key in process memory only. This
-- migration does not introduce any key storage. Rows carry the public side
-- of the trust bound -- signature + key id -- and never expose the secret.

ALTER TABLE "build_receipts"
  ADD COLUMN "emitted_at" timestamptz,
  ADD COLUMN "signing_alg" text,
  ADD COLUMN "signing_key_id" text,
  ADD COLUMN "signature" text,
  ADD COLUMN "transcript_sha256" text;--> statement-breakpoint

-- Backfill emitted_at for rows that pre-date R3 so the existing rows are
-- readable (signing_alg/signature/transcript_sha256 stay null and the
-- detector branches on presence). Defensive: written_at is the closest
-- timestamp we have on hand.
UPDATE "build_receipts"
  SET "emitted_at" = COALESCE("finished_at", "created_at")
  WHERE "emitted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "build_receipts"
  ALTER COLUMN "emitted_at" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "build_receipts_company_key_created_idx"
  ON "build_receipts" USING btree ("company_id","signing_key_id","created_at" DESC);
