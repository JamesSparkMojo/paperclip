// server/src/services/build-receipts.ts
//
// ADR-0058 Decision 5 Phase 2 -- server-emitted BUILD-RECEIPT row.
//
// R1 emits a row when a heartbeat run finishes with status=succeeded and the
// run context carries an issueId. The server, not the builder, is the trust
// boundary: the row is written from inside the run-finalize hook, the tree SHA
// is read from the workspace cwd (`git -C <cwd> rev-parse HEAD`), remote
// presence is checked against the workspace's origin (`git ls-remote`), and
// the gate counts are parsed by the server from the unlazy ledger file the
// builder names in resultJson.ledger_path (never from builder-reported
// counts -- self-reported counts are the disease Phase 2 exists to cure;
// ruling on interaction 1793b3c1, 2026-08-29).
//
// What R1 deliberately does NOT do:
//   * it does not modify reviewer-obedience gates (R2),
//   * it does not fence concurrent attempts (R4),
//   * it does not author adversarial fixtures (R5).
//
// R3 (this file's current scope) DOES sign the receipt it emits: every
// row carries a base64url Ed25519 signature, the algorithm name, a key id,
// and a transcript hash. The signing key is held in process memory and
// never leaves the server boundary. The detector (build-receipt-check.mjs)
// re-derives the canonical payload from the row's signed fields, computes
// the transcript hash, and verifies the signature; an unsigned or tampered
// receipt REJECTs.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  buildReceipts,
  executionWorkspaces,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  getSigningPublicKeyByKeyId,
  signBuildReceipt,
  SUPPORTED_ALG,
  verifyBuildReceiptSignature,
} from "./build-receipt-signing.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type BuildReceiptInsert = typeof buildReceipts.$inferInsert;
type BuildReceiptRow = typeof buildReceipts.$inferSelect;

const SHA40_RE = /^[0-9a-f]{40}$/i;
// Default ledger path when the builder did not name one in resultJson.
// Scope = the card identifier (e.g. SPA-5175).
const LEDGER_TIMEOUT_MS = 5_000;

export type LedgerStatus = "parsed" | "missing" | "malformed";
export type RemoteVerification = "verified" | "unverified" | "unknown";

export interface GateCounts {
  met: number;
  unmet: number;
  abandoned: number;
}

export interface LedgerParseResult {
  status: LedgerStatus;
  counts: GateCounts;
  path: string | null;
}

export interface EmitResult {
  emitted: boolean;
  receipt: BuildReceiptRow | null;
  reason: string;
}

// Small async git helper. Returns null on any failure (timeout, non-zero exit,
// missing cwd) -- callers fall open rather than block the run on a receipt
// emit. This matches the existing pattern in execution-workspaces.ts
// readGitStdout.
function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), LEDGER_TIMEOUT_MS);
    try {
      const child = spawn("git", ["-C", cwd, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code !== 0) return finish(null);
        finish(stdout);
      });
    } catch {
      finish(null);
    }
  });
}

async function runGitHead(cwd: string): Promise<string | null> {
  const stdout = await runGit(cwd, ["rev-parse", "HEAD"]);
  if (!stdout) return null;
  const value = stdout.trim();
  return SHA40_RE.test(value) ? value.toLowerCase() : null;
}

// Check whether a 40-hex commit exists on the workspace's origin. This is the
// remote_verified gate from James's ruling: "a receipt for an unpushed tree is
// still emitted but flagged, and the detector treats unverified as FAIL."
// Returns "unknown" when the check itself fails (no origin, no network,
// timeout) -- indistinguishable-in-principle from unverified, but the detector
// contract only treats verified as PASS.
export async function verifyRemoteHasCommit(
  cwd: string,
  sha: string,
): Promise<RemoteVerification> {
  const stdout = await runGit(cwd, ["remote", "get-url", "origin"]);
  if (!stdout) return "unknown";
  // ls-remote exits 0 with empty output when sha not on remote -- definitive
  // "unverified", not a failure. Non-zero exit / timeout => "unknown". Uses
  // async spawn (same runGit timeout) so event loop not blocked.
  const out = await runGit(cwd, ["ls-remote", "origin", sha, "refs/heads/*"]);
  if (out === null) return "unknown";
  const found = out
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[0]?.toLowerCase() === sha.toLowerCase());
  return found ? "verified" : "unverified";
}

// Port of gate-check.mjs's --status parser (strict format, ~40 lines): a
// ledger line is
//   - [x] <gate id> EVIDENCE: <evidence>     => met
//   - [ ] <gate id> EVIDENCE: <evidence>     => unmet (checked, not passed)
//   - [ ] <gate id> PENDING: <reason>        => unmet (pending)
//   ABANDON: <gate id> <reason>              => abandoned
// Only strict `- [x]` with a non-pending marker counts as met. The server
// parses this file itself -- it never trusts a builder-reported number.
export function parseUnlazyLedger(text: string): GateCounts {
  const counts: GateCounts = { met: 0, unmet: 0, abandoned: 0 };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^ABANDON:/i.test(line)) {
      counts.abandoned += 1;
      continue;
    }
    const checkbox = line.match(/^-\s+\[( |x|X)\]\s+(.*)$/);
    if (!checkbox) continue;
    const rest = checkbox[2];
    if (/^PENDING:/i.test(rest)) {
      counts.unmet += 1;
      continue;
    }
    if (checkbox[1].toLowerCase() === "x" && /EVIDENCE:/i.test(rest)) {
      counts.met += 1;
    } else {
      counts.unmet += 1;
    }
  }
  return counts;
}

// Resolve the ledger path the builder named, then read + parse it from the
// workspace cwd. Missing file => status "missing" with null counts (detector
// FAILs); unreadable or non-strict content => "malformed". The returned
// `path` is the builder-named path verbatim so the receipt can echo it back
// for debugging; the counts are always server-computed.
export function parseLedgerForIssue(
  cwd: string,
  ledgerPath: string | null | undefined,
  card: string | null,
): LedgerParseResult {
  const named = typeof ledgerPath === "string" && ledgerPath.trim().length > 0
    ? ledgerPath.trim()
    : card
      ? `.unlazy/${card}/GATES.md`
      : null;
  if (!named) {
    return { status: "missing", counts: { met: 0, unmet: 0, abandoned: 0 }, path: null };
  }
  // Reject anything that escapes the workspace.
  const full = isAbsolute(named) ? resolve(named) : resolve(join(cwd, named));
  const cwdNorm = resolve(cwd);
  const inside = full === cwdNorm || full.startsWith(cwdNorm + "/");
  if (!inside) {
    return { status: "missing", counts: { met: 0, unmet: 0, abandoned: 0 }, path: named };
  }
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return { status: "missing", counts: { met: 0, unmet: 0, abandoned: 0 }, path: named };
  }
  if (text.trim().length === 0) {
    return { status: "malformed", counts: { met: 0, unmet: 0, abandoned: 0 }, path: named };
  }
  try {
    return { status: "parsed", counts: parseUnlazyLedger(text), path: named };
  } catch {
    return { status: "malformed", counts: { met: 0, unmet: 0, abandoned: 0 }, path: named };
  }
}

// Read the issueId off a run's contextSnapshot. Returns null when the run
// is not attached to an issue (skill tests, smoke runs, daemon background work).
function readIssueIdFromContext(run: HeartbeatRunRow): string | null {
  const snapshot = run.contextSnapshot as Record<string, unknown> | null | undefined;
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot["issueId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The builder names its ledger in resultJson.ledger_path. Never read a
// builder-supplied gate count -- only the path, which the server validates
// against the strict ledger format on read.
function readLedgerPathFromResult(run: HeartbeatRunRow): string | null {
  const result = run.resultJson as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== "object") return null;
  const value = result["ledger_path"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Resolve the execution workspace for an issue. R1 takes the issue's
// executionWorkspaceId; if absent, falls back to the most recently active
// workspace for that company. The branch and cwd come from this row.
async function resolveWorkspace(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<typeof executionWorkspaces.$inferSelect | null> {
  const issueRow = await db
    .select({ executionWorkspaceId: issues.executionWorkspaceId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .then((rows) => rows[0] ?? null);
  if (issueRow?.executionWorkspaceId) {
    const ws = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, issueRow.executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (ws) return ws;
  }
  const fallback = await db
    .select()
    .from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.status, "active")))
    .orderBy(desc(executionWorkspaces.lastUsedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return fallback ?? null;
}

// emitBuildReceiptForRun is the public entry called from the heartbeat
// run-finalize hook. It is fail-open: any error logs and returns
// { emitted: false, ... } so the run completes even if the receipt cannot be
// produced. R1 does NOT make the run depend on a successful emit.
export async function emitBuildReceiptForRun(input: {
  db: Db;
  run: HeartbeatRunRow;
}): Promise<EmitResult> {
  const { db, run } = input;
  if (run.status !== "succeeded") {
    return { emitted: false, receipt: null, reason: `status=${run.status} (not a success terminal)` };
  }
  const issueId = readIssueIdFromContext(run);
  if (!issueId) {
    return { emitted: false, receipt: null, reason: "no issueId on run.contextSnapshot" };
  }

  const workspace = await resolveWorkspace(db, run.companyId, issueId);
  const cwd = workspace?.cwd ?? null;
  if (!cwd) {
    logger.warn(
      { runId: run.id, issueId },
      "build-receipts: skipping emit -- issue has no execution workspace cwd",
    );
    return { emitted: false, receipt: null, reason: "issue has no execution workspace cwd" };
  }
  const treeSha = await runGitHead(cwd);
  if (!treeSha) {
    logger.warn(
      { runId: run.id, issueId, cwd },
      "build-receipts: skipping emit -- could not resolve HEAD from workspace cwd",
    );
    return {
      emitted: false,
      receipt: null,
      reason: "could not resolve HEAD from workspace cwd (not a git checkout, or git unavailable)",
    };
  }

  const startedAt = run.startedAt ?? new Date();
  const finishedAt = run.finishedAt ?? new Date();
  // Resolve the human-readable card identifier (e.g. "SPA-5175") from the
  // issues row so the receipt carries the same value the verifier-side
  // detector expects. R1 only emits for runs that completed with a real
  // issueId, so the lookup should always succeed.
  const issueRow = await db
    .select({ identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
    .then((rows) => rows[0] ?? null);
  const card = issueRow?.identifier ?? null;
  const skill = (run.contextSnapshot as Record<string, unknown> | null)?.["skill"];

  // Server-side truth gathering: remote presence + ledger parse. Both are
  // allowed to fail individually -- the receipt still emits, with the honest
  // signal (unverified / missing) that the detector FAILs on.
  const remoteVerified = await verifyRemoteHasCommit(cwd, treeSha);
  const ledger = parseLedgerForIssue(cwd, readLedgerPathFromResult(run), card);

  // R3: sign the canonical payload before persisting. The signing key is
  // process-local; the signature, key id, algorithm, and transcript hash are
  // the four columns the detector re-derives and verifies. emittedAt is
  // bound into the canonical payload, so the receipt is bound to the
  // wall-clock moment the server signed it -- not the run's finishedAt.
  const emittedAt = new Date();
  const signed = signBuildReceipt({
    fields: {
      issueId,
      attemptId: run.id,
      runId: run.id,
      generation: 1,
      treeSha,
      gateCounts: ledger.counts,
      emittedAt,
    },
  });

  const values: BuildReceiptInsert = {
    companyId: run.companyId,
    issueId,
    heartbeatRunId: run.id,
    executionWorkspaceId: workspace?.id ?? null,
    attemptId: run.id,
    card: typeof card === "string" ? card : null,
    generation: 1,
    treeSha,
    branch: workspace?.branchName ?? null,
    remoteVerified,
    gates: ledger.counts,
    startedAt,
    finishedAt,
    // gates-met is the only success exit; run status=succeeded is the
    // precondition for ever reaching this point.
    exit: "gates-met",
    metadata: {
      heartbeatRunStatus: run.status,
      contextSnapshotSkill: typeof skill === "string" ? skill : null,
      ledger_status: ledger.status,
      ledger_path: ledger.path,
    },
    emittedAt,
    signingAlg: signed.alg,
    signingKeyId: signed.keyId,
    signature: signed.signature,
    transcriptSha256: signed.transcriptSha256,
  };

  // ON CONFLICT DO NOTHING -- a retry of the same run id (after a recovery
  // sweep re-runs setRunStatus) must not fail the run. The unique index on
  // (issue_id, attempt_id) is the dedupe boundary.
  const inserted = await db
    .insert(buildReceipts)
    .values(values)
    .onConflictDoNothing({ target: [buildReceipts.issueId, buildReceipts.attemptId] })
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!inserted) {
    const existing = await db
      .select()
      .from(buildReceipts)
      .where(and(eq(buildReceipts.issueId, issueId), eq(buildReceipts.attemptId, run.id)))
      .then((rows) => rows[0] ?? null);
    return {
      emitted: false,
      receipt: existing,
      reason: "row already existed for (issueId, attemptId) -- re-emit is a no-op",
    };
  }

  logger.info(
    {
      runId: run.id,
      issueId,
      treeSha,
      branch: values.branch,
      remoteVerified,
      ledgerStatus: ledger.status,
      gates: ledger.counts,
      signingKeyId: signed.keyId,
      signatureShort: signed.signature.slice(0, 12),
    },
    "build-receipts: emitted server-side BUILD-RECEIPT row (signed)",
  );
  return { emitted: true, receipt: inserted, reason: "ok" };
}

export async function getLatestBuildReceiptForIssue(input: {
  db: Db;
  companyId: string;
  issueId: string;
}): Promise<BuildReceiptRow | null> {
  const { db, companyId, issueId } = input;
  return db
    .select()
    .from(buildReceipts)
    .where(and(eq(buildReceipts.companyId, companyId), eq(buildReceipts.issueId, issueId)))
    .orderBy(desc(buildReceipts.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// Server-side signature verification of a receipt row against the persisted
// key whose id the row names. This is the production caller of
// verifyBuildReceiptSignature (FATAL-3): the latest-receipt route calls this
// before returning, so every receipt read is cryptographically re-verified
// inside the trust boundary -- not just the detector's external check.
//
// Pre-R3 rows have null signing columns and return { ok: false, reason:
// "unsigned (pre-R3)" }; the detector branches on that. The verify step is
// fail-closed: an unknown key id or a bad signature is an error, never a
// silent pass.
export async function verifyServerReceipt(
  db: Db,
  receipt: BuildReceiptRow,
): Promise<{ ok: boolean; reason: string | null }> {
  const gates = (receipt.gates ?? {}) as { met: number; unmet: number; abandoned: number };
  if (!receipt.signingAlg || !receipt.signingKeyId || !receipt.signature || !receipt.transcriptSha256) {
    return { ok: false, reason: "unsigned (pre-R3)" };
  }
  if (receipt.signingAlg !== SUPPORTED_ALG) {
    return { ok: false, reason: `unsupported signing alg "${receipt.signingAlg}"` };
  }
  const keyMaterial = await getSigningPublicKeyByKeyId(db, receipt.signingKeyId);
  if (!keyMaterial) {
    return { ok: false, reason: `unknown signing key id "${receipt.signingKeyId}"` };
  }
  const result = verifyBuildReceiptSignature({
    fields: {
      issueId: receipt.issueId,
      attemptId: receipt.attemptId,
      runId: receipt.heartbeatRunId,
      generation: receipt.generation,
      treeSha: receipt.treeSha,
      gateCounts: {
        met: Number(gates.met ?? 0),
        unmet: Number(gates.unmet ?? 0),
        abandoned: Number(gates.abandoned ?? 0),
      },
      emittedAt: receipt.emittedAt,
    },
    alg: receipt.signingAlg,
    keyId: receipt.signingKeyId,
    signature: receipt.signature,
    transcriptSha256: receipt.transcriptSha256,
    publicKeyMaterial: keyMaterial,
  });
  return { ok: result.ok, reason: result.reason };
}
