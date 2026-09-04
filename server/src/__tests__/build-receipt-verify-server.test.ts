// Locks the contract of verifyServerReceipt -- the PRODUCTION CALLER of
// verifyBuildReceiptSignature (FATAL-3). The latest-receipt route calls this on
// every read, so it is the server-side proof that a row has not been altered
// in the DB or in transit.
//
// Host-independent: verifies the verify path with a fake DB that stores a
// persisted signing-key row, so it does not need embedded-postgres. The pure
// sign/verify contract itself is locked in build-receipt-signing.test.ts.

import { describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  deriveKeyId,
  generateBuildReceiptKey,
  signBuildReceipt,
  type BuildReceiptSignedFields,
} from "../services/build-receipt-signing.js";
import { verifyServerReceipt } from "../services/build-receipts.js";

// Minimal fake of the drizzle query builder subset that
// getSigningPublicKeyByKeyId uses: select().from().where().limit() resolving to
// a rows array. Stores persisted signing-key rows in memory.
//
// drizzle's eq(column, value) carries { field: { name }, value } -- the fake's
// `where` reads that shape to filter rows by keyId, so the "unknown key" case
// (no matching row) is exercised correctly.
function makeFakeDb(rows: Array<{ keyId: string; publicKeyPem: string }>) {
  const state = { rows };
  const db = {
    select: () => ({
      from: () => ({
        where: (eqObj: { field?: { name?: string }; value?: unknown } | undefined) => ({
          limit: async (n: number) => {
            const fieldName = eqObj?.field?.name;
            const value = eqObj?.value;
            const filtered =
              fieldName && value !== undefined
                ? state.rows.filter((r) => (r as Record<string, unknown>)[fieldName] === value)
                : state.rows;
            return filtered.slice(0, n);
          },
        }),
      }),
    }),
    _rows: state.rows,
  };
  return db;
}

function keyRow(key: ReturnType<typeof generateBuildReceiptKey>) {
  return {
    keyId: key.keyId,
    publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function baseFields(overrides: Partial<BuildReceiptSignedFields> = {}): BuildReceiptSignedFields {
  return {
    issueId: "issue-1",
    attemptId: "attempt-1",
    runId: "run-1",
    generation: 1,
    treeSha: "1111111111111111111111111111111111111111",
    gateCounts: { met: 4, unmet: 0, abandoned: 0 },
    emittedAt: new Date("2026-08-31T02:00:00.000Z"),
    ...overrides,
  };
}

// Build a receipt row shaped like BuildReceiptRow but carrying the signed
// fields, as the route would read from the DB. Note the field-name split: the
// signing contract uses `gateCounts` (BuildReceiptSignedFields), the DB row
// uses `gates` (BuildReceiptRow). The two carry the same {met,unmet,abandoned}.
function signedRow(key: ReturnType<typeof generateBuildReceiptKey>, fields: BuildReceiptSignedFields) {
  const signed = signBuildReceipt({ fields, key });
  return {
    companyId: "company-1",
    issueId: fields.issueId,
    heartbeatRunId: fields.runId,
    attemptId: fields.attemptId,
    generation: fields.generation,
    treeSha: fields.treeSha,
    gates: { met: fields.gateCounts.met, unmet: fields.gateCounts.unmet, abandoned: fields.gateCounts.abandoned },
    emittedAt: fields.emittedAt,
    signingAlg: signed.alg,
    signingKeyId: signed.keyId,
    signature: signed.signature,
    transcriptSha256: signed.transcriptSha256,
  } as Parameters<typeof verifyServerReceipt>[1];
}

describe("verifyServerReceipt (production caller, FATAL-3)", () => {
  it("returns ok=false for a pre-R3 row with no signing columns", async () => {
    const db = makeFakeDb([]);
    const result = await verifyServerReceipt(db as never, {
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      attemptId: "attempt-1",
      generation: 1,
      treeSha: "1111111111111111111111111111111111111111",
      gates: { met: 4, unmet: 0, abandoned: 0 },
      emittedAt: new Date(),
      signingAlg: null,
      signingKeyId: null,
      signature: null,
      transcriptSha256: null,
    } as Parameters<typeof verifyServerReceipt>[1]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsigned \(pre-R3\)/);
  });

  it("rejects a row whose gates were altered post-emission", async () => {
    const key = generateBuildReceiptKey();
    const db = makeFakeDb([keyRow(key)]);
    const fields = baseFields();
    const row = signedRow(key, fields);
    // Tamper gates AFTER the row was signed (the server signed met=4).
    row.gates = { met: 99, unmet: 0, abandoned: 0 };
    const result = await verifyServerReceipt(db as never, row);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/transcript hash mismatch/);
  });

  it("rejects a row signed by an unknown key id", async () => {
    const realKey = generateBuildReceiptKey();
    const db = makeFakeDb([keyRow(realKey)]); // only realKey is persisted
    const attackerKey = generateBuildReceiptKey();
    const row = signedRow(attackerKey, baseFields()); // signed by someone else
    const result = await verifyServerReceipt(db as never, row);
    expect(result.ok).toBe(false);
    // Rejection lands on "unknown signing key" (no persisted row for this id)
    // or "signing_key_id mismatch" (the fake DB can't filter by key id and
    // returns the wrong key) -- both are correct rejections for a receipt
    // signed by a key the server does not recognize.
    expect(result.reason).toMatch(/unknown signing key|signing_key_id mismatch/);
  });

  it("accepts a genuine server-signed row", async () => {
    const key = generateBuildReceiptKey();
    const db = makeFakeDb([keyRow(key)]);
    const row = signedRow(key, baseFields());
    const result = await verifyServerReceipt(db as never, row);
    expect(result.ok, `reason=${result.reason}`).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("rejects a row with an unsupported signing_alg", async () => {
    const key = generateBuildReceiptKey();
    const db = makeFakeDb([keyRow(key)]);
    const row = signedRow(key, baseFields());
    row.signingAlg = "rsa-2048";
    const result = await verifyServerReceipt(db as never, row);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsupported signing alg/);
  });

  it("derives a stable key id from the persisted public key", async () => {
    const key = generateBuildReceiptKey();
    const db = makeFakeDb([keyRow(key)]);
    // The detector re-derives key id from the public key; it must match the
    // row's signing_key_id or the receipt is rejected. This locks the rotate
    // path: a persisted key's id is a function of its public bytes only.
    const reloaded = createPublicKey({ key: keyRow(key).publicKeyPem, format: "pem" });
    const der = reloaded.export({ type: "spki", format: "der" }) as Buffer;
    expect(deriveKeyId(der)).toBe(key.keyId);
  });
});
