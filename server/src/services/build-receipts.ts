// server/src/services/build-receipts.ts
//
// ADR-0058 Decision 5 Phase 2 -- server-emitted BUILD-RECEIPT row.
//
// R1 emits a row when a heartbeat run finishes with status=succeeded and the
// run context carries an issueId. The server, not the builder, is the trust
// boundary: the row is written from inside the run-finalize hook, the tree SHA
// is read from the workspace cwd (`git -C <cwd> rev-parse HEAD`), and the
// branch comes from the workspace row. Phase 2 §R1 scope.
//
// What R1 deliberately does NOT do:
//   * it does not modify reviewer-obedience gates (R2),
//   * it does not sign the receipt (R3),
//   * it does not fence concurrent attempts (R4),
//   * it does not author adversarial fixtures (R5).
//
// If any of those are required, route to the matching card -- this file's
// scope is the emitter and the read endpoint.

import { spawn } from "node:child_process";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  buildReceipts,
  executionWorkspaces,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type BuildReceiptInsert = typeof buildReceipts.$inferInsert;
type BuildReceiptRow = typeof buildReceipts.$inferSelect;

const SHA40_RE = /^[0-9a-f]{40}$/i;

export interface EmitResult {
  emitted: boolean;
  receipt: BuildReceiptRow | null;
  reason: string;
}

// Small git helper. Returns null on any failure (timeout, non-zero exit, missing
// cwd) -- callers fall open rather than block the run on a receipt emit. This
// matches the existing pattern in execution-workspaces.ts readGitStdout.
function runGitHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn("git", ["-C", cwd, "rev-parse", "HEAD"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code !== 0) return finish(null);
        const value = stdout.trim();
        if (!SHA40_RE.test(value)) return finish(null);
        finish(value.toLowerCase());
      });
    } catch {
      finish(null);
    }
  });
}

// Read the issueId off a run's contextSnapshot. Returns null when the run
// is not attached to an issue (skill tests, smoke runs, daemon background work).
function readIssueIdFromContext(run: HeartbeatRunRow): string | null {
  const snapshot = run.contextSnapshot as Record<string, unknown> | null | undefined;
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot["issueId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Resolve the execution workspace for an issue. R1 takes the issue's
// executionWorkspaceId; if absent, falls back to the most recently active
// workspace for that issue's project. The branch and cwd come from this row.
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
    // R1 can only verify the commit exists in the local workspace git. Remote
    // verification (the SHA is on the assigned remote's branch tip) lands in
    // a later phase; until then the value is "local_only" so the detector can
    // distinguish it from a self-posted Phase-1 receipt's boolean.
    remoteVerified: "local_only",
    gates: { met: 0, unmet: 0, abandoned: 0 },
    startedAt,
    finishedAt,
    exit: "gates-met",
    metadata: {
      heartbeatRunStatus: run.status,
      contextSnapshotSkill: typeof skill === "string" ? skill : null,
    },
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
    { runId: run.id, issueId, treeSha, branch: values.branch },
    "build-receipts: emitted server-side BUILD-RECEIPT row",
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
