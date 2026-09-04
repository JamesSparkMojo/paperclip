import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// build_receipt_signing_keys -- SPA-5177 R3 key persistence.
//
// R3 mints an Ed25519 keypair on first use and (the FATAL-4 gap) must persist
// it so the key id is stable across server restarts -- otherwise the detector
// cannot know which public key to verify a receipt against. The private key is
// stored server-side only (DB + process memory) and is NEVER returned by any
// route; only the public side is served via the signing-key route. Rotation
// adds a new row and flips is_active; old rows stay so past receipts still
// verify against the key that signed them.
export const buildReceiptSigningKeys = pgTable(
  "build_receipt_signing_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // key_id is the public, stable fingerprint (sha256(publicDer).slice(0,16)
    // hex). Unique so the detector can fetch the exact key a receipt names.
    keyId: text("key_id").notNull(),
    // "ed25519" today. The detector refuses algorithms it does not recognize.
    alg: text("alg").notNull().default("ed25519"),
    // Public key, SPKI PEM -- the only column a route ever returns.
    publicKeyPem: text("public_key_pem").notNull(),
    // Public key DER (base64) -- redundant with the PEM but lets the detector
    // re-derive the key id without PEM parse, and indexes stay lean.
    publicKeyDer: text("public_key_der").notNull(),
    // Private key, PKCS8 PEM. Server-side only. Never serialized to a client.
    privateKeyPem: text("private_key_pem").notNull(),
    // Exactly one active key at a time. The active key signs new receipts;
    // inactive ones are retained for verifying historic receipts.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdUnique: uniqueIndex("build_receipt_signing_keys_key_id_unique").on(table.keyId),
    activeUnique: uniqueIndex("build_receipt_signing_keys_active_unique").on(table.isActive),
  }),
);

export type BuildReceiptSigningKeyRow = typeof buildReceiptSigningKeys.$inferSelect;
