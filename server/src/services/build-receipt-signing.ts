// server/src/services/build-receipt-signing.ts
//
// ADR-0058 Decision 5 Phase 2 R3 -- tamper-evident BUILD-RECEIPT rows.
//
// The server holds an Ed25519 keypair. On every RECEIPT event R1 emits, the
// server canonicalizes the row's signed payload (issueId, attemptId, runId,
// generation, treeSHA, gateCounts, emittedAt), signs it, and persists:
//   * signingAlg      -- "ed25519" today
//   * signingKeyId    -- sha256(publicKeyDer).slice(0,8) hex, identifies the
//                         key when more than one is in flight (rotation)
//   * signature       -- base64url Ed25519 signature over the canonical bytes
//   * transcriptSha256 -- sha256 hex of the canonical bytes; lets the detector
//                         prove the receipt under audit matches what the
//                         server says it emitted, without re-deriving the form
//
// The detector (build-receipt-check.mjs) recomputes the canonical bytes from
// the same field set, derives the transcript hash, and verifies the
// signature against the matching public key. A receipt with the signature
// stripped REJECTs; a receipt whose gates field is altered post-emission
// REJECTs (the transcript hash no longer matches the signed canonical bytes
// and the signature no longer verifies); an untouched receipt ACCEPTs.
//
// Trust boundary: the private key is held in process memory only. It is
// never written to disk by this module, never logged, and never serialized
// into a SQL row or an HTTP response. R3 ships with an in-process key per
// server process; rotation would re-mint the keypair at startup, persist the
// public key, and re-derive signingKeyId.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export const SUPPORTED_ALG = "ed25519" as const;
export type SigningAlg = typeof SUPPORTED_ALG;

export interface BuildReceiptKeyMaterial {
  alg: SigningAlg;
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyDer: Buffer;
}

export interface BuildReceiptSignedFields {
  issueId: string;
  attemptId: string;
  runId: string;
  generation: number;
  treeSha: string;
  gateCounts: { met: number; unmet: number; abandoned: number };
  emittedAt: Date;
}

export interface SignedBuildReceipt {
  alg: SigningAlg;
  keyId: string;
  signature: string;
  transcriptSha256: string;
  // Canonical bytes (utf-8) that the signature is computed over. Stable
  // serialization -- ordering and shape are part of the contract.
  canonical: string;
}

// Deterministic canonicalization. Same input shape in => same string out,
// independent of insertion order or engine. Number formatting uses
// `String(value)` which preserves up to 2^53 safely.
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map((entry) => canonicalize(entry)).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v)).join(",") +
      "}"
    );
  }
  return "null";
}

function toGateCounts(value: BuildReceiptSignedFields["gateCounts"]): Record<string, number> {
  return {
    met: value.met,
    unmet: value.unmet,
    abandoned: value.abandoned,
  };
}

function toIso8601Utc(d: Date): string {
  // Always Z form, millisecond precision, exactly 24 chars -- the same form
  // .toISOString() emits. Stable across platforms.
  return d.toISOString();
}

// Canonicalize a signed-payload object. The shape is part of the R3
// contract; re-ordering these keys invalidates every signature.
function canonicalizeSignedFields(fields: BuildReceiptSignedFields): string {
  return canonicalize({
    alg: SUPPORTED_ALG,
    v: 3,
    issueId: fields.issueId,
    attemptId: fields.attemptId,
    runId: fields.runId,
    generation: fields.generation,
    treeSha: fields.treeSha,
    gateCounts: toGateCounts(fields.gateCounts),
    emittedAt: toIso8601Utc(fields.emittedAt),
  });
}

// Derive a stable 8-hex key id from the public key DER bytes. First 8 hex
// chars of sha256(der) -- long enough that an attacker cannot enumerate the
// keyspace of a given key but short enough to fit in any index. Two servers
// that hold the same keypair will always derive the same keyId.
export function deriveKeyId(publicKeyDer: Buffer): string {
  return createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);
}

// Generate a fresh Ed25519 keypair. Used on first call in a process. The
// public side is the only piece that ever leaves memory; the private key
// stays process-local for the lifetime of the server.
export function generateBuildReceiptKey(): BuildReceiptKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    alg: SUPPORTED_ALG,
    keyId: deriveKeyId(publicKeyDer),
    publicKey,
    privateKey,
    publicKeyDer,
  };
}

// Re-hydrate a key from its PEM/DER material. Used by tests (to pin a
// deterministic key) and by future rotation paths (to load a persisted
// public side and refuse to load a private side from disk).
export function loadBuildReceiptKey(input: {
  alg: SigningAlg;
  privateKeyPem: string;
}): BuildReceiptKeyMaterial {
  if (input.alg !== SUPPORTED_ALG) {
    throw new Error(`unsupported signing alg: ${input.alg}`);
  }
  const privateKey = createPrivateKey({ key: input.privateKeyPem, format: "pem" });
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    alg: input.alg,
    keyId: deriveKeyId(publicKeyDer),
    privateKey,
    publicKey,
    publicKeyDer,
  };
}

// Process-local cache: every server process holds exactly one key. Rotation
// would re-mint and update this map; this is intentionally not a per-company
// table today (R3's spec binds the key to the server, not the tenant).
let keyMaterialCache: BuildReceiptKeyMaterial | null = null;

export function getBuildReceiptKey(): BuildReceiptKeyMaterial {
  if (!keyMaterialCache) keyMaterialCache = generateBuildReceiptKey();
  return keyMaterialCache;
}

// Test/rotation hook -- replaces the process key. Returns the previous
// material so a caller can rotate without losing the audit trail.
export function setBuildReceiptKey(next: BuildReceiptKeyMaterial | null): BuildReceiptKeyMaterial | null {
  const previous = keyMaterialCache;
  keyMaterialCache = next;
  return previous;
}

// Sign a receipt. Returns the canonical bytes, the signature, the key id,
// and the transcript hash. The emitter stores all four so the detector can
// re-verify without re-deriving the form.
export function signBuildReceipt(input: {
  fields: BuildReceiptSignedFields;
  key?: BuildReceiptKeyMaterial;
}): SignedBuildReceipt {
  const key = input.key ?? getBuildReceiptKey();
  if (key.alg !== SUPPORTED_ALG) {
    throw new Error(`unsupported signing alg on key: ${key.alg}`);
  }
  const canonical = canonicalizeSignedFields(input.fields);
  const transcriptSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), key.privateKey).toString(
    "base64url",
  );
  return {
    alg: SUPPORTED_ALG,
    keyId: key.keyId,
    signature,
    transcriptSha256,
    canonical,
  };
}

// Verify a receipt's signature. The detector re-canonicalizes from the
// row's stored fields (it does NOT trust the canonical string -- the row
// only carries the hash) and verifies against the matching public key.
//
// `publicKeyMaterial` is the key used to sign the row, identified by
// `signingKeyId`. Today that is the process-local key, fetched via
// `getBuildReceiptKey()`. Rotation would extend this with a key id -> public
// key lookup table.
export function verifyBuildReceiptSignature(input: {
  fields: BuildReceiptSignedFields;
  alg: SigningAlg | null;
  keyId: string | null;
  signature: string | null;
  transcriptSha256: string | null;
  publicKeyMaterial: BuildReceiptKeyMaterial;
}): { ok: boolean; reason: string | null; recomputed: { canonical: string; transcriptSha256: string } } {
  const recomputed = (() => {
    const canonical = canonicalizeSignedFields(input.fields);
    const transcriptSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
    return { canonical, transcriptSha256 };
  })();

  if (!input.alg) return { ok: false, reason: "signature missing: no signing_alg on row", recomputed };
  if (input.alg !== SUPPORTED_ALG) {
    return { ok: false, reason: `signature: unsupported signing_alg "${input.alg}"`, recomputed };
  }
  if (!input.keyId) return { ok: false, reason: "signature missing: no signing_key_id on row", recomputed };
  if (!input.signature) return { ok: false, reason: "signature missing: no signature on row", recomputed };
  if (!input.transcriptSha256) {
    return { ok: false, reason: "signature missing: no transcript_sha256 on row", recomputed };
  }
  if (input.transcriptSha256 !== recomputed.transcriptSha256) {
    return {
      ok: false,
      reason: `signature: transcript hash mismatch (stored=${input.transcriptSha256.slice(0, 12)}, recomputed=${recomputed.transcriptSha256.slice(0, 12)})`,
      recomputed,
    };
  }
  if (input.keyId !== input.publicKeyMaterial.keyId) {
    return {
      ok: false,
      reason: `signature: signing_key_id mismatch (row=${input.keyId}, expected=${input.publicKeyMaterial.keyId})`,
      recomputed,
    };
  }
  let verified: boolean;
  try {
    verified = cryptoVerify(
      null,
      Buffer.from(recomputed.canonical, "utf8"),
      input.publicKeyMaterial.publicKey,
      Buffer.from(input.signature, "base64url"),
    );
  } catch (err) {
    return {
      ok: false,
      reason: `signature: verify threw ${err instanceof Error ? err.message : String(err)}`,
      recomputed,
    };
  }
  if (!verified) {
    return { ok: false, reason: "signature: Ed25519 verification failed (canonical payload was tampered)", recomputed };
  }
  return { ok: true, reason: null, recomputed };
}
