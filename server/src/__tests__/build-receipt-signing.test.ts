// SPA-5177 R3: tamper-evident (signed) build receipts.
//
// Locks the contract that the verifier-side detector relies on:
//   * signBuildReceipt is deterministic given the same key + same fields
//     EXCEPT for emittedAt -- which is bound to the wall-clock moment.
//   * verifyBuildReceiptSignature returns ok=true for an untouched row.
//   * An unsigned row (signature stripped) REJECTs.
//   * A row whose gateCounts is altered post-emission REJECTs.
//   * A row whose treeSha is altered post-emission REJECTs.
//   * A row whose emittedAt is altered post-emission REJECTs.
//   * A row signed by a different key (rotation) REJECTs.
//   * The transcript hash recomputed by the detector matches the server's.
//   * The public key id is derived deterministically from the DER bytes.

import { describe, expect, it } from "vitest";
import {
  deriveKeyId,
  generateBuildReceiptKey,
  loadBuildReceiptKey,
  signBuildReceipt,
  SUPPORTED_ALG,
  verifyBuildReceiptSignature,
  type BuildReceiptSignedFields,
} from "../services/build-receipt-signing.js";
import { createPublicKey, createPrivateKey } from "node:crypto";

function baseFields(overrides: Partial<BuildReceiptSignedFields> = {}): BuildReceiptSignedFields {
  return {
    issueId: "issue-1",
    attemptId: "attempt-1",
    runId: "attempt-1",
    generation: 1,
    treeSha: "1111111111111111111111111111111111111111",
    gateCounts: { met: 4, unmet: 0, abandoned: 0 },
    emittedAt: new Date("2026-08-31T02:00:00.000Z"),
    ...overrides,
  };
}

describe("build-receipt-signing R3", () => {
  it("generates an Ed25519 key with a deterministic 16-hex key id", () => {
    const key = generateBuildReceiptKey();
    expect(key.alg).toBe(SUPPORTED_ALG);
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
    // Re-deriving from the same public key MUST produce the same id. This
    // is the contract the detector uses to identify the key on rotation.
    expect(deriveKeyId(key.publicKeyDer)).toBe(key.keyId);
  });

  it("signs and verifies a receipt round-trip", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key });
    expect(signed.alg).toBe("ed25519");
    expect(signed.keyId).toBe(key.keyId);
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.transcriptSha256).toMatch(/^[0-9a-f]{64}$/);

    const verification = verifyBuildReceiptSignature({
      fields,
      alg: signed.alg,
      keyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: key,
    });
    expect(verification.ok).toBe(true);
    expect(verification.reason).toBeNull();
  });

  it("rejects an unsigned receipt (signature field missing)", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key });
    const verification = verifyBuildReceiptSignature({
      fields,
      alg: signed.alg,
      keyId: signed.keyId,
      signature: null,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: key,
    });
    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/no signature on row/);
  });

  it("rejects a receipt whose gateCounts field is tampered post-emission", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key });

    // Attacker bumps gates.met from 4 -> 99 to fake a green receipt.
    const tampered = baseFields({ gateCounts: { met: 99, unmet: 0, abandoned: 0 } });
    const verification = verifyBuildReceiptSignature({
      fields: tampered,
      alg: signed.alg,
      keyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: key,
    });
    expect(verification.ok).toBe(false);
    // The transcript hash must not match -- the canonical payload was
    // mutated after the signature was bound to it.
    expect(verification.reason).toMatch(/transcript hash mismatch|Ed25519 verification failed/);
    // The detector's recomputed hash differs from the stored one.
    expect(verification.recomputed.transcriptSha256).not.toBe(signed.transcriptSha256);
  });

  it("rejects a receipt whose treeSha is tampered post-emission", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key });

    const tampered = baseFields({ treeSha: "2222222222222222222222222222222222222222" });
    const verification = verifyBuildReceiptSignature({
      fields: tampered,
      alg: signed.alg,
      keyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: key,
    });
    expect(verification.ok).toBe(false);
  });

  it("rejects a receipt whose emittedAt is tampered post-emission", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key });

    const tampered = baseFields({
      emittedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const verification = verifyBuildReceiptSignature({
      fields: tampered,
      alg: signed.alg,
      keyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: key,
    });
    expect(verification.ok).toBe(false);
  });

  it("rejects a receipt signed by a different key (rotation)", () => {
    const serverKey = generateBuildReceiptKey();
    const attackerKey = generateBuildReceiptKey();
    const fields = baseFields();

    // Attacker signs with their own key.
    const attackerSigned = signBuildReceipt({ fields, key: attackerKey });

    const verification = verifyBuildReceiptSignature({
      fields,
      alg: attackerSigned.alg,
      keyId: attackerSigned.keyId,
      signature: attackerSigned.signature,
      transcriptSha256: attackerSigned.transcriptSha256,
      publicKeyMaterial: serverKey,
    });
    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/signing_key_id mismatch/);
  });

  it("rejects a receipt with an unsupported signing_alg", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key });
    const verification = verifyBuildReceiptSignature({
      fields,
      alg: "rsa-2048" as never,
      keyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: key,
    });
    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/unsupported signing_alg/);
  });

  it("produces identical signatures for the same fields on retry (deterministic on canonical form)", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields();
    const a = signBuildReceipt({ fields, key });
    const b = signBuildReceipt({ fields, key });
    expect(a.canonical).toBe(b.canonical);
    expect(a.transcriptSha256).toBe(b.transcriptSha256);
    expect(a.signature).toBe(b.signature);
  });

  it("hydrates a key from PEM and produces the same keyId", () => {
    const generated = generateBuildReceiptKey();
    const pem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const reloaded = loadBuildReceiptKey({ alg: "ed25519", privateKeyPem: pem });
    expect(reloaded.keyId).toBe(generated.keyId);
    // Sign with the reloaded key -- the public side must still verify.
    const fields = baseFields();
    const signed = signBuildReceipt({ fields, key: reloaded });
    const verification = verifyBuildReceiptSignature({
      fields,
      alg: signed.alg,
      keyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
      publicKeyMaterial: generated,
    });
    expect(verification.ok).toBe(true);
  });

  it("canonicalizes the same logical payload identically regardless of key order", () => {
    const key = generateBuildReceiptKey();
    const fields = baseFields({
      gateCounts: { met: 4, unmet: 0, abandoned: 0 },
    });
    // Build a duplicate fields object with insertion order shuffled to prove
    // canonicalization is order-independent at the verifier layer.
    const shuffled: BuildReceiptSignedFields = {
      runId: "attempt-1",
      gateCounts: { abandoned: 0, unmet: 0, met: 4 },
      emittedAt: new Date("2026-08-31T02:00:00.000Z"),
      attemptId: "attempt-1",
      issueId: "issue-1",
      generation: 1,
      treeSha: "1111111111111111111111111111111111111111",
    };
    const a = signBuildReceipt({ fields, key });
    const b = signBuildReceipt({ fields: shuffled, key });
    expect(a.canonical).toBe(b.canonical);
    expect(a.signature).toBe(b.signature);
    expect(a.transcriptSha256).toBe(b.transcriptSha256);
  });
});
