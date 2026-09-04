// End-to-end: the full persist -> sign -> verify chain against a REAL DB
// (embedded Postgres). This is the genuine new behavior R3's resubmission
// adds -- the key id is STABLE across restarts because the keypair is
// persisted, not re-minted. Host-guarded: skips when embedded PG is
// unsupported here.
//
// Chain proved:
//   1. initBuildReceiptKey(db) mints + persists a keypair on first run.
//   2. signBuildReceipt signs with the persisted key.
//   3. A second initBuildReceiptKey (simulating a server restart -- cache
//      cleared via setBuildReceiptKey(null)) loads the SAME key id.
//   4. verifyServerReceipt ACCEPTs a genuine signed row.
//   5. verifyServerReceipt REJECTs a gates-tampered row.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  buildReceiptSigningKeys,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  getBuildReceiptKey,
  initBuildReceiptKey,
  setBuildReceiptKey,
  signBuildReceipt,
} from "../services/build-receipt-signing.js";
import { verifyServerReceipt } from "../services/build-receipts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping build-receipt key-persistence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("build-receipt signing key persistence (R3 resubmit)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-r3-key-persist-");
    db = createDb(tempDb.connectionString);
    // Start clean: ensure no signing key exists yet.
    await db.delete(buildReceiptSigningKeys);
    setBuildReceiptKey(null);
  }, 60_000);

  afterAll(async () => {
    setBuildReceiptKey(null);
    await tempDb?.cleanup();
  });

  it("mints + persists on first init, and RELOADS the same key id on restart", async () => {
    const first = await initBuildReceiptKey(db);
    expect(first.keyId).toMatch(/^[0-9a-f]{16}$/);

    // One persisted active row, carrying the private side server-side only.
    const rows = await db.select().from(buildReceiptSigningKeys);
    expect(rows.length).toBe(1);
    expect(rows[0].keyId).toBe(first.keyId);
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(rows[0].publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);

    // Simulate a server restart: drop the in-memory cache, re-init.
    setBuildReceiptKey(null);
    const second = await initBuildReceiptKey(db);
    expect(second.keyId).toBe(first.keyId);

    // Still exactly one row -- no duplicate mint on re-init.
    const rowsAfter = await db.select().from(buildReceiptSigningKeys);
    expect(rowsAfter.length).toBe(1);
  });

  it("signs with the persisted key and verifyServerReceipt ACCEPTs the row", async () => {
    const key = await initBuildReceiptKey(db);
    const fields = {
      issueId: "issue-1",
      attemptId: "attempt-1",
      runId: "run-1",
      generation: 1,
      treeSha: "1111111111111111111111111111111111111111",
      gateCounts: { met: 4, unmet: 0, abandoned: 0 },
      emittedAt: new Date("2026-08-31T02:00:00.000Z"),
    };
    const signed = signBuildReceipt({ fields, key });
    expect(signed.keyId).toBe(key.keyId);

    const row = {
      companyId: "company-1",
      issueId: fields.issueId,
      heartbeatRunId: fields.runId,
      attemptId: fields.attemptId,
      generation: fields.generation,
      treeSha: fields.treeSha,
      gates: { ...fields.gateCounts },
      emittedAt: fields.emittedAt,
      signingAlg: signed.alg,
      signingKeyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
    } as Parameters<typeof verifyServerReceipt>[1];

    const result = await verifyServerReceipt(db, row);
    expect(result.ok, `reason=${result.reason}`).toBe(true);
  });

  it("verifyServerReceipt REJECTs a gates-tampered row against the persisted key", async () => {
    const key = await initBuildReceiptKey(db);
    const fields = {
      issueId: "issue-1",
      attemptId: "attempt-1",
      runId: "run-1",
      generation: 1,
      treeSha: "1111111111111111111111111111111111111111",
      gateCounts: { met: 4, unmet: 0, abandoned: 0 },
      emittedAt: new Date("2026-08-31T02:00:00.000Z"),
    };
    const signed = signBuildReceipt({ fields, key });

    const row = {
      companyId: "company-1",
      issueId: fields.issueId,
      heartbeatRunId: fields.runId,
      attemptId: fields.attemptId,
      generation: fields.generation,
      treeSha: fields.treeSha,
      gates: { met: 99, unmet: 0, abandoned: 0 }, // tampered post-emission
      emittedAt: fields.emittedAt,
      signingAlg: signed.alg,
      signingKeyId: signed.keyId,
      signature: signed.signature,
      transcriptSha256: signed.transcriptSha256,
    } as Parameters<typeof verifyServerReceipt>[1];

    const result = await verifyServerReceipt(db, row);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/transcript hash mismatch/);
  });
});
