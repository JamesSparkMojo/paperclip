#!/usr/bin/env node
// scripts/verify/build-receipt-r3-live-probe.mjs
//
// SPA-5177 R3 live probe -- exercises the signed-receipt contract end-to-end
// without going through a real run. Mints a keypair, signs three receipts
// (untouched / signature-stripped / gates-altered), writes them as fixtures,
// and runs the detector against each one. The exit code is the verdict.
//
// Usage:
//   node scripts/verify/build-receipt-r3-live-probe.mjs
//
// Success: prints "R3 LIVE PROBE PASS" and exits 0.
// Failure: prints "R3 LIVE PROBE FAIL: <reason>" and exits 1.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v)).join(",") + "}"
    );
  }
  return "null";
}

// toIso8601Utc MUST match the server's Date.prototype.toISOString format
// exactly: ms-precision, Z-suffix, 24 chars.
function toIso8601Utc(d) {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return new Date(d).toISOString();
  return null;
}

function deriveKeyId(publicKeyDer) {
  return createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);
}

function sign(fields, privateKey) {
  const canonical = canonicalize({
    alg: "ed25519",
    v: 3,
    issueId: fields.issueId,
    attemptId: fields.attemptId,
    runId: fields.runId,
    generation: fields.generation,
    treeSha: fields.treeSha.toLowerCase(),
    gateCounts: fields.gates,
    emittedAt: toIso8601Utc(fields.emittedAt),
  });
  const transcriptSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
  return { canonical, transcriptSha256, signature };
}

function makeReceipt({ keypair, keyId, fields, tamper }) {
  const signed = sign(fields, keypair.privateKey);
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
    branch: "SPA-5177-spa-5172-3-r3-signed-tamper-evident-build-receipts",
    remote_verified: "verified",
    gates: fields.gates,
    ledger_path: `.unlazy/${"SPA-5177"}/GATES.md`,
    ledger_status: "parsed",
    exit: "gates-met",
    signing_alg: "ed25519",
    signing_key_id: keyId,
    signature: signed.signature,
    transcript_sha256: signed.transcriptSha256,
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
  return receipt;
}

function detectExecutable(name) {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function fail(reason, code = 1) {
  console.error(`R3 LIVE PROBE FAIL: ${reason}`);
  process.exit(code);
}

async function main() {
  if (!detectExecutable("node")) fail("node not on PATH");
  if (!detectExecutable("openssl")) fail("openssl not on PATH (needed for the detector's self-test fixtures)");

  // Build a temp workspace.
  const work = mkdtempSync(join(tmpdir(), "build-receipt-r3-probe-"));
  const fixturesDir = join(work, "fixtures");
  const keyDir = join(work, "keys");
  // The COMMITTED detector (scripts/verify/build-receipt-check.mjs) -- the
  // DoD-named reader. Relative to the repo root, so this probe runs in CI and
  // any clone with no machine-specific absolute path (FATAL-2 fix).
  const detector = join(repoRoot, "scripts", "verify", "build-receipt-check.mjs");
  if (!existsSync(detector)) {
    fail(`committed detector not found at ${detector} -- FATAL-2`);
  }
  spawnSync("mkdir", ["-p", fixturesDir, keyDir]);

  try {
    // Mint an Ed25519 keypair via openssl (the detector can read the PEM
    // public key directly). Mirrors the server's process-local keypair.
    const privPath = join(keyDir, "private.pem");
    const pubPath = join(keyDir, "public.pem");
    const gen = run("openssl", ["genpkey", "-algorithm", "ED25519", "-out", privPath]);
    if (gen.status !== 0) fail(`openssl genpkey failed: ${gen.stderr}`);
    const extract = run("openssl", ["pkey", "-in", privPath, "-pubout", "-out", pubPath]);
    if (extract.status !== 0) fail(`openssl pkey extract failed: ${extract.stderr}`);

    // Use Node's crypto to derive the key id the server would compute for
    // this same public key. This is the cross-check the detector does.
    const { createPublicKey } = await import("node:crypto");
    const pubKey = createPublicKey({ key: readFileUtf8(pubPath), format: "pem" });
    const pubDer = pubKey.export({ type: "spki", format: "der" });
    const keyId = deriveKeyId(pubDer);

    // Mint the three fixtures.
    const baseFields = {
      issueId: "3e0b26a6-301e-4b44-9da6-f626b638ae1d",
      attemptId: "363d0158-5ae2-4f12-ae00-477c2c2687f0",
      runId: "363d0158-5ae2-4f12-ae00-477c2c2687f0",
      generation: 1,
      treeSha: "1111111111111111111111111111111111111111",
      gates: { met: 4, unmet: 0, abandoned: 0 },
      startedAt: "2026-08-31T01:00:00.000Z",
      finishedAt: "2026-08-31T01:45:00.000Z",
      emittedAt: "2026-08-31T01:45:00.123Z",
    };

    const { privateKey } = (() => {
      const pem = readFileUtf8(privPath);
      const node = createPrivateKey({ key: pem, format: "pem" });
      return { privateKey: node };
    })();
    const keypair = { privateKey };

    const untouched = makeReceipt({ keypair, keyId, fields: baseFields, tamper: null });
    const stripped = makeReceipt({ keypair, keyId, fields: baseFields, tamper: "strip-signature" });
    const tamperedGates = makeReceipt({ keypair, keyId, fields: baseFields, tamper: "alter-gates" });
    const tamperedTree = makeReceipt({ keypair, keyId, fields: baseFields, tamper: "alter-tree-sha" });

    const untouchedPath = join(fixturesDir, "untouched.json");
    const strippedPath = join(fixturesDir, "stripped.json");
    const tamperedGatesPath = join(fixturesDir, "tampered-gates.json");
    const tamperedTreePath = join(fixturesDir, "tampered-tree-sha.json");
    writeFileSync(untouchedPath, JSON.stringify(untouched, null, 2));
    writeFileSync(strippedPath, JSON.stringify(stripped, null, 2));
    writeFileSync(tamperedGatesPath, JSON.stringify(tamperedGates, null, 2));
    writeFileSync(tamperedTreePath, JSON.stringify(tamperedTree, null, 2));

    // Run the detector on each fixture.
    const cases = [
      { label: "untouched", path: untouchedPath, expect: "ok" },
      { label: "signature stripped", path: strippedPath, expect: "fail", reasonFragment: "missing required field" },
      { label: "gates altered", path: tamperedGatesPath, expect: "fail", reasonFragment: "transcript hash mismatch" },
      { label: "tree_sha altered", path: tamperedTreePath, expect: "fail", reasonFragment: "transcript hash mismatch" },
    ];

    for (const c of cases) {
      const out = run(
        "node",
        [detector, "--receipt", c.path, "--expect-sha", baseFields.treeSha, "--public-key-path", pubPath],
      );
      const stdout = (out.stdout || "").trim();
      const stderr = (out.stderr || "").trim();
      if (c.expect === "ok") {
        if (out.status !== 0) fail(`${c.label}: expected PASS, got FAIL. stderr=${stderr}`);
        if (!stdout.includes("RECEIPT OK")) fail(`${c.label}: expected RECEIPT OK, got: ${stdout}`);
        console.log(`PASS  ${c.label}: ${stdout}`);
      } else {
        if (out.status === 0) fail(`${c.label}: expected FAIL, got PASS. stdout=${stdout}`);
        const combined = (stdout + " " + stderr).toLowerCase();
        if (!combined.includes(c.reasonFragment.toLowerCase())) {
          fail(`${c.label}: expected reason containing "${c.reasonFragment}", got: ${stderr || stdout}`);
        }
        console.log(`PASS  ${c.label}: ${stderr || stdout}`);
      }
    }

    // Negative: detector WITHOUT the public key refuses to verify (proves the
    // detector's gate is on by default).
    const noKeyOut = run(
      "node",
      [detector, "--receipt", untouchedPath, "--expect-sha", baseFields.treeSha],
    );
    if (noKeyOut.status === 0) {
      fail("detector-without-public-key: expected FAIL, got PASS");
    }
    const noKeyCombined = ((noKeyOut.stdout || "") + " " + (noKeyOut.stderr || "")).toLowerCase();
    if (!noKeyCombined.includes("public key not provided")) {
      fail(`detector-without-public-key: expected "public key not provided", got: ${noKeyOut.stderr || noKeyOut.stdout}`);
    }
    console.log("PASS  detector refuses to verify without public key");

    console.log("R3 LIVE PROBE PASS");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readFileUtf8(p) {
  return readFileSync(p);
}

main().catch((err) => fail(err.stack || err.message));
