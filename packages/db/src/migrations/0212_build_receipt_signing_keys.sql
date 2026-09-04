-- SPA-5177 R3: persist the Ed25519 signing keypair server-side.
--
-- R3 mints a keypair on first use. The FATAL-4 gap in the first submission
-- was that the key lived only in process memory and was re-minted every
-- restart, so no detector could verify a real receipt against a stable
-- public key. This table persists the keypair: the public side is served to
-- detectors via the signing-key route, the private side NEVER leaves the
-- server (stored here + held in process memory for signing). Rotation adds
-- a new row and flips is_active; old rows stay so historic receipts still
-- verify against the key that signed them.

CREATE TABLE "build_receipt_signing_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key_id" text NOT NULL,
  "alg" text NOT NULL DEFAULT 'ed25519',
  "public_key_pem" text NOT NULL,
  "public_key_der" text NOT NULL,
  "private_key_pem" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX "build_receipt_signing_keys_key_id_unique"
  ON "build_receipt_signing_keys" USING btree ("key_id");--> statement-breakpoint

-- At most one active key at a time. Partial unique index is the correct
-- shape (multiple inactive rows allowed, only one active) but paperclip's
-- Postgres target supports uniqueIndex; we enforce the single-active
-- invariant in the data layer (getActiveSigningKey) as well.
CREATE UNIQUE INDEX "build_receipt_signing_keys_active_unique"
  ON "build_receipt_signing_keys" USING btree ("is_active");--> statement-breakpoint
