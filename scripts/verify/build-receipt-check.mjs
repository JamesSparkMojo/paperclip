#!/usr/bin/env node
// scripts/verify/build-receipt-check.mjs -- BUILD-RECEIPT checker (R3, signed).
//
// Validates a server-emitted, Ed25519-signed BUILD-RECEIPT row
// (ADR-0058 Decision 5 Phase 2 R3). Schema:
//
//   v: number  -- schema version, MUST be 3
//   card, issue_id, run_id, attempt_id, generation, started_at, finished_at,
//   emitted_at, tree_sha, branch, gates, ledger_path, ledger_status,
//   remote_verified, exit, skill, signing_alg, signing_key_id, signature,
//   transcript_sha256
//
// A receipt that:
//   * has no signature REJECTs
//   * has an unsupported signing_alg REJECTs
//   * has a transcript_sha256 that does not match the re-derived hash REJECTs
//   * has a signature that does not verify against the matching public key REJECTs
//   * has a gates field altered post-emission REJECTs (transcript hash no
//     longer matches and the signature fails)
//
// Public-key resolution: --public-key-path <pem> for local fixtures/self-test,
// or the server's persisted key route (/api/build-receipts/signing-key) when
// --issue is used. No machine-specific paths; no untracked scratch files.
//
// Usage:
//   node build-receipt-check.mjs --receipt <file.json> --expect-sha <40hex>
//                              [--public-key-path <public.pem>]
//   node build-receipt-check.mjs --issue <uuid> --expect-sha <40hex>
//                              [--base-url <url>] [--api-key <key>]
//   node build-receipt-check.mjs --self-test
//
// Success: prints "RECEIPT OK <sha>" to stdout, exits 0.
// Failure: prints "RECEIPT FAIL: <reasons>" to stderr, exits 1.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_FIELDS = [
  "v",
  "card",
  "issue_id",
  "run_id",
  "attempt_id",
  "generation",
  "skill",
  "started_at",
  "finished_at",
  "emitted_at",
  "tree_sha",
  "branch",
  "remote_verified",
  "gates",
  "ledger_path",
  "ledger_status",
  "exit",
  // R3 signing columns -- all four MUST be present on a v=3 receipt.
  "signing_alg",
  "signing_key_id",
  "signature",
  "transcript_sha256",
];

const SHA40_RE = /^[0-9a-f]{40}$/i;
const SUPPORTED_ALG = "ed25519";

function isIsoTimestamp(v) {
  if (typeof v !== "string") return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === v.slice(0, 19);
}

// Deterministic canonicalizer. Same contract as the server's
// build-receipt-signing.ts: keys sorted alphabetically, numbers via String(),
// null/undefined filtered, arrays preserved in order.
function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map((entry) => canonicalize(entry)).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
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

// Re-derive the canonical payload the server signed. The shape is part of
// the R3 contract with the server's build-receipt-signing.ts:
//   { alg, v, issueId, attemptId, runId, generation, treeSha, gateCounts,
//     emittedAt }
// Any drift here invalidates every signature.
function canonicalSignedPayload(r) {
  const gateCounts =
    r.gates && typeof r.gates === "object"
      ? {
          met: Number(r.gates.met),
          unmet: Number(r.gates.unmet),
          abandoned: Number(r.gates.abandoned),
        }
      : null;
  const emittedAt =
    typeof r.emitted_at === "string" && isIsoTimestamp(r.emitted_at)
      ? new Date(r.emitted_at).toISOString()
      : null;
  return canonicalize({
    alg: SUPPORTED_ALG,
    v: 3,
    issueId: r.issue_id,
    attemptId: r.attempt_id,
    runId: r.run_id,
    generation: Number(r.generation),
    treeSha: String(r.tree_sha).toLowerCase(),
    gateCounts,
    emittedAt,
  });
}

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function loadReceiptFromFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  return JSON.parse(text.trim());
}

function loadPublicKey(publicKeyPath) {
  const pem = readFileSync(publicKeyPath, "utf8");
  return createPublicKey({ key: pem, format: "pem" });
}

function deriveKeyId(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

// Validate a parsed receipt object against the schema + signature.
// Returns { ok: boolean, reasons: string[] }.
function validateReceipt(receipt, { expectSha, requireRemote, cwd, publicKey } = {}) {
  const reasons = [];

  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reasons: ["receipt is not a JSON object"] };
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in receipt));
  if (missing.length > 0) {
    reasons.push(`missing required field(s): ${missing.join(", ")}`);
  }

  if ("v" in receipt && receipt.v !== 3) {
    reasons.push(`v must equal 3 (got ${JSON.stringify(receipt.v)})`);
  }

  if ("tree_sha" in receipt) {
    if (typeof receipt.tree_sha !== "string" || !SHA40_RE.test(receipt.tree_sha)) {
      reasons.push("tree_sha must be 40 hex characters");
    } else if (expectSha && receipt.tree_sha.toLowerCase() !== expectSha.toLowerCase()) {
      reasons.push(`tree_sha mismatch: expected ${expectSha}, got ${receipt.tree_sha}`);
    }
  }

  if ("gates" in receipt) {
    const g = receipt.gates;
    if (
      g === null ||
      typeof g !== "object" ||
      typeof g.met !== "number" ||
      typeof g.unmet !== "number" ||
      typeof g.abandoned !== "number"
    ) {
      reasons.push("gates must be an object with numeric met, unmet, abandoned");
    } else {
      if (g.unmet !== 0) reasons.push(`gates.unmet must be 0 (got ${g.unmet})`);
      if (g.abandoned !== 0) reasons.push(`gates.abandoned must be 0 (got ${g.abandoned})`);
    }
  }

  if ("exit" in receipt && receipt.exit !== "gates-met") {
    reasons.push(`exit must be "gates-met" (got ${JSON.stringify(receipt.exit)})`);
  }

  if ("remote_verified" in receipt && receipt.remote_verified !== "verified") {
    reasons.push(`remote_verified must be "verified" (got ${JSON.stringify(receipt.remote_verified)})`);
  }

  if ("signing_alg" in receipt && receipt.signing_alg !== SUPPORTED_ALG) {
    reasons.push(`signing_alg must be "${SUPPORTED_ALG}" (got ${JSON.stringify(receipt.signing_alg)})`);
  }

  // Signature verification. Runs only when the four signing columns + the
  // signed payload fields are all present and well-typed.
  const sigFieldsPresent =
    typeof receipt.signing_alg === "string" &&
    typeof receipt.signing_key_id === "string" &&
    typeof receipt.signature === "string" &&
    typeof receipt.transcript_sha256 === "string" &&
    typeof receipt.issue_id === "string" &&
    typeof receipt.attempt_id === "string" &&
    typeof receipt.run_id === "string" &&
    typeof receipt.generation === "number" &&
    typeof receipt.tree_sha === "string" &&
    typeof receipt.emitted_at === "string" &&
    isIsoTimestamp(receipt.emitted_at) &&
    receipt.gates &&
    typeof receipt.gates === "object";

  if (sigFieldsPresent) {
    const canonical = canonicalSignedPayload(receipt);
    const recomputed = sha256Hex(canonical);
    if (recomputed !== receipt.transcript_sha256) {
      reasons.push(
        `signature: transcript hash mismatch (stored=${receipt.transcript_sha256.slice(0, 12)}, recomputed=${recomputed.slice(0, 12)}) -- gates/emittedAt/treeSha likely altered post-emission`,
      );
    } else if (!publicKey) {
      reasons.push("signature: public key not provided (pass --public-key-path to verify)");
    } else {
      const expectedKeyId = deriveKeyId(publicKey);
      if (receipt.signing_key_id !== expectedKeyId) {
        reasons.push(
          `signature: signing_key_id mismatch (row=${receipt.signing_key_id}, expected=${expectedKeyId})`,
        );
      } else {
        let verified = false;
        try {
          verified = cryptoVerify(
            null,
            Buffer.from(canonical, "utf8"),
            publicKey,
            Buffer.from(receipt.signature, "base64url"),
          );
        } catch (err) {
          reasons.push(`signature: verify threw ${err.message}`);
        }
        if (!verified) {
          reasons.push("signature: Ed25519 verification failed -- canonical payload was tampered");
        }
      }
    }
  }

  if (requireRemote) {
    if (typeof receipt.tree_sha !== "string" || !SHA40_RE.test(receipt.tree_sha)) {
      reasons.push("--require-remote: tree_sha missing or malformed, cannot verify");
    } else {
      const result = spawnSync("git", ["cat-file", "-e", `${receipt.tree_sha}^{commit}`], {
        cwd: cwd || process.cwd(),
      });
      if (result.status !== 0) {
        reasons.push(`--require-remote: commit ${receipt.tree_sha} not found in local git (git cat-file -e failed)`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// Fetch the latest server-emitted signed receipt for an issue.
async function fetchLatestReceiptFromServer(baseUrl, apiKey, issueId) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/issues/${issueId}/build-receipts/latest`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`could not reach paperclip API at ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`paperclip API ${url} returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body || typeof body !== "object" || body.v !== 3) {
    throw new Error(`paperclip API ${url} returned a non-v3 receipt (got v=${JSON.stringify(body && body.v)})`);
  }
  return body;
}

// Fetch the active signing public key from the server's persisted key route.
// Bearer auth comes from --api-key or PAPERCLIP_API_KEY.
async function fetchServerPublicKey(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/build-receipts/signing-key`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`could not reach signing-key route at ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`signing-key route ${url} returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body || typeof body.public_key_pem !== "string") {
    throw new Error(`signing-key route ${url} returned no public_key_pem`);
  }
  try {
    return createPublicKey({ key: body.public_key_pem, format: "pem" });
  } catch (err) {
    throw new Error(`signing-key route returned an unparseable public key: ${err.message}`);
  }
}

function parseArgs(argv) {
  const args = { requireRemote: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--receipt") args.receipt = argv[++i];
    else if (a === "--issue") args.issue = argv[++i];
    else if (a === "--expect-sha") args.expectSha = argv[++i];
    else if (a === "--require-remote") args.requireRemote = true;
    else if (a === "--public-key-path") args.publicKeyPath = argv[++i];
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--api-key") args.apiKey = argv[++i];
    else if (a === "--self-test") args.selfTest = true;
    else {
      console.error(`RECEIPT FAIL: unknown argument ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function runCheck(args) {
  if (!args.receipt && !args.issue && !args.selfTest) {
    return { ok: false, reasons: ["one of --receipt or --issue is required"] };
  }
  if (args.receipt && args.issue) {
    return { ok: false, reasons: ["--receipt and --issue are mutually exclusive"] };
  }
  if (!args.expectSha && !args.selfTest) {
    return { ok: false, reasons: ["--expect-sha is required (unless --self-test)"] };
  }

  let receipt;
  try {
    if (args.receipt) {
      if (!existsSync(args.receipt)) {
        return { ok: false, reasons: [`receipt file not found: ${args.receipt}`] };
      }
      receipt = loadReceiptFromFile(args.receipt);
    } else {
      const baseUrl = args.baseUrl || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
      const apiKey = args.apiKey || process.env.PAPERCLIP_API_KEY || null;
      receipt = await fetchLatestReceiptFromServer(baseUrl, apiKey, args.issue);
    }
  } catch (err) {
    return { ok: false, reasons: [err.message] };
  }

  // Public-key resolution: explicit PEM wins; for --issue, fall back to the
  // server's persisted key route (the key the server actually signed with).
  let publicKey = null;
  try {
    if (args.publicKeyPath) {
      publicKey = loadPublicKey(args.publicKeyPath);
    } else if (args.issue) {
      const baseUrl = args.baseUrl || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
      const apiKey = args.apiKey || process.env.PAPERCLIP_API_KEY || null;
      publicKey = await fetchServerPublicKey(baseUrl, apiKey);
    }
  } catch (err) {
    return { ok: false, reasons: [err.message] };
  }

  return validateReceipt(receipt, {
    expectSha: args.expectSha,
    requireRemote: args.requireRemote,
    cwd: process.cwd(),
    publicKey,
  });
}

// ---- self-test (hermetic) -----------------------------------------------
// Signs fixtures in-memory with a throwaway keypair, runs the 5 verdict rows,
// never touches the network or the repo. This proves the DETECTOR's logic; the
// live probe (build-receipt-r3-live-probe.mjs) proves the SERVER's wiring.

function makeFixtureReceipt({ fields, tamper }) {
  const { privateKey, publicKey } = fields.keypair;
  const canonical = canonicalize({
    alg: "ed25519",
    v: 3,
    issueId: fields.issueId,
    attemptId: fields.attemptId,
    runId: fields.runId,
    generation: fields.generation,
    treeSha: fields.treeSha.toLowerCase(),
    gateCounts: fields.gates,
    emittedAt: new Date(fields.emittedAt).toISOString(),
  });
  const transcriptSha256 = sha256Hex(canonical);
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
  const der = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha256").update(der).digest("hex").slice(0, 16);

  const receipt = {
    v: 3,
    card: "SPA-5177",
    issue_id: fields.issueId,
    run_id: fields.runId,
    attempt_id: fields.attemptId,
    generation: fields.generation,
    skill: "sm-build-paperclip",
    started_at: new Date(fields.startedAt).toISOString(),
    finished_at: new Date(fields.finishedAt).toISOString(),
    emitted_at: new Date(fields.emittedAt).toISOString(),
    tree_sha: fields.treeSha,
    branch: "self-test",
    remote_verified: "verified",
    gates: { ...fields.gates },
    ledger_path: ".unlazy/SPA-5177/GATES.md",
    ledger_status: "parsed",
    exit: "gates-met",
    signing_alg: "ed25519",
    signing_key_id: keyId,
    signature,
    transcript_sha256: transcriptSha256,
  };

  if (tamper === "strip-signature") {
    delete receipt.signature;
    delete receipt.signing_alg;
    delete receipt.signing_key_id;
    delete receipt.transcript_sha256;
  } else if (tamper === "alter-gates") {
    receipt.gates = { met: 99, unmet: 0, abandoned: 0 };
  } else if (tamper === "alter-tree-sha") {
    receipt.tree_sha = "2222222222222222222222222222222222222222";
  }
  return { receipt, publicKey };
}

function selfTest() {
  const EXPECT_SHA = "1111111111111111111111111111111111111111";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const baseFields = {
    keypair: { publicKey, privateKey },
    issueId: "3e0b26a6-301e-4b44-9da6-f626b638ae1d",
    attemptId: "363d0158-5ae2-4f12-ae00-477c2c2687f0",
    runId: "363d0158-5ae2-4f12-ae00-477c2c2687f0",
    generation: 1,
    treeSha: EXPECT_SHA,
    gates: { met: 4, unmet: 0, abandoned: 0 },
    startedAt: "2026-08-31T01:00:00.000Z",
    finishedAt: "2026-08-31T01:45:00.000Z",
    emittedAt: "2026-08-31T01:45:00.123Z",
  };

  let failed = false;
  function check(label, fn) {
    try {
      const result = fn();
      if (!result.ok) {
        console.error(`SELF-TEST STEP FAILED: ${label}: expected ok=true, got: ${result.reasons.join("; ")}`);
        failed = true;
      } else {
        console.log(`PASS  ${label}`);
      }
    } catch (err) {
      console.error(`SELF-TEST STEP FAILED: ${label}: threw ${err.message}`);
      failed = true;
    }
  }
  function checkFailsWith(label, fn, expectedSubstring) {
    try {
      const result = fn();
      if (result.ok) {
        console.error(`SELF-TEST STEP FAILED: ${label}: expected failure, got ok=true`);
        failed = true;
        return;
      }
      if (!result.reasons.join("; ").toLowerCase().includes(expectedSubstring.toLowerCase())) {
        console.error(
          `SELF-TEST STEP FAILED: ${label}: expected reason containing "${expectedSubstring}", got: ${result.reasons.join("; ")}`,
        );
        failed = true;
        return;
      }
      console.log(`PASS  ${label}`);
    } catch (err) {
      console.error(`SELF-TEST STEP FAILED: ${label}: threw ${err.message}`);
      failed = true;
    }
  }

  check("valid signed fixture", () => {
    const { receipt, publicKey: pub } = makeFixtureReceipt({ fields: baseFields, tamper: null });
    return validateReceipt(receipt, { expectSha: EXPECT_SHA, publicKey: pub });
  });
  checkFailsWith(
    "signature stripped",
    () => {
      const { receipt, publicKey: pub } = makeFixtureReceipt({ fields: baseFields, tamper: "strip-signature" });
      return validateReceipt(receipt, { expectSha: EXPECT_SHA, publicKey: pub });
    },
    "missing required field",
  );
  checkFailsWith(
    "gates altered post-emission",
    () => {
      const { receipt, publicKey: pub } = makeFixtureReceipt({ fields: baseFields, tamper: "alter-gates" });
      return validateReceipt(receipt, { expectSha: EXPECT_SHA, publicKey: pub });
    },
    "transcript hash mismatch",
  );
  checkFailsWith(
    "tree_sha altered post-emission",
    () => {
      const { receipt, publicKey: pub } = makeFixtureReceipt({ fields: baseFields, tamper: "alter-tree-sha" });
      return validateReceipt(receipt, { expectSha: EXPECT_SHA, publicKey: pub });
    },
    "transcript hash mismatch",
  );
  checkFailsWith(
    "no public key",
    () => {
      const { receipt } = makeFixtureReceipt({ fields: baseFields, tamper: null });
      return validateReceipt(receipt, { expectSha: EXPECT_SHA, publicKey: null });
    },
    "public key not provided",
  );

  if (failed) {
    console.log("RECEIPT SELF-TEST FAIL");
    process.exit(1);
  }
  console.log("RECEIPT SELF-TEST PASS");
  process.exit(0);
}

// ---- entrypoint -----------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfTest) {
    selfTest();
    return;
  }

  const { ok, reasons } = await runCheck(args);
  if (ok) {
    console.log(`RECEIPT OK ${args.expectSha}`);
    process.exit(0);
  } else {
    console.error(`RECEIPT FAIL: ${reasons.join("; ")}`);
    process.exit(1);
  }
}

main();
