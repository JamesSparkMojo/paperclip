// server/src/services/concurrency-fences.ts
//
// ADR-0058/0059 Phase 2 R4 -- concurrency fencing primitives.
//
// Three primitives extended onto the existing lease/attempt state machine
// without replacing it: deploy cap 1 on UAT, per-worktree builder fence,
// and 60s sweep that frees a dead run's lease and bumps generation.
//
// Contract mirrors card SPA-5179 DoD:
//   1. Deploy cap: at most 1 active deploy_lease per (company, environment).
//      2nd start while first active -> 409 "deploy in progress". On timeout
//      the lease blocks (never stacks); timeout does NOT auto-release.
//   2. Builder fence: at most 1 active builder_fence per (company,
//      worktreePath, generation). 2nd -> 409 with a clear message.
//   3. Recovery sweep: every 60s, rows whose heartbeatRunId maps to a run that
//      is no longer "running" (dead without clean release) are marked expired.
//      The next acquire on the same (path,generation) gets a fresh generation
//      by virtue of the caller's generation bump -- server never reuses the
//      dead attempt identity (codex finding #4). Sweep is fail-open.

import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { builderFences, deployLeases, heartbeatRuns } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";

// How long a fence row is considered alive after its last heartbeat. After
// this window the sweep reclaims it even if the run row still says running
// but has stopped heartbeating (the kill-mid-attempt probe: after 90s the
// lease must be cleared).
const STALE_HEARTBEAT_MS = 60_000;

type FenceDb = Pick<Db, "select" | "insert" | "update" | "delete"> & {
  // drizzle's typed .select/.insert/etc.; narrow to what we use
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
};

// Deploy concurrency: 1 at a time on UAT (ADR-0059 Decision 7).
export async function acquireDeployLease(input: {
  db: FenceDb;
  companyId: string;
  heartbeatRunId?: string | null;
  issueId?: string | null;
  environment?: string;
}): Promise<typeof deployLeases.$inferSelect> {
  const env = (input.environment ?? "uat").toLowerCase();
  // Check existing active lease in this company+env before inserting. The
  // partial unique index (WHERE status='active') is the hard backstop; this
  // pre-check produces a clearer 409 message than a PG unique violation.
  const existing = await (input.db as Db)
    .select()
    .from(deployLeases)
    .where(
      and(
        eq(deployLeases.companyId, input.companyId),
        eq(deployLeases.environment, env),
        eq(deployLeases.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existing) {
    throw conflict("deploy in progress");
  }
  const row = await (input.db as Db)
    .insert(deployLeases)
    .values({
      companyId: input.companyId,
      environment: env,
      status: "active",
      heartbeatRunId: input.heartbeatRunId ?? null,
      issueId: input.issueId ?? null,
      generation: existing ? (existing.generation as number) + 1 : 1,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0] as typeof deployLeases.$inferSelect);
  return row;
}

export async function releaseDeployLease(input: {
  db: FenceDb;
  leaseId: string;
  companyId: string;
}): Promise<void> {
  await (input.db as Db)
    .update(deployLeases)
    .set({ status: "released", releasedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(deployLeases.id, input.leaseId), eq(deployLeases.companyId, input.companyId)));
}

export async function heartbeatDeployLease(input: {
  db: FenceDb;
  leaseId: string;
  companyId: string;
}): Promise<void> {
  await (input.db as Db)
    .update(deployLeases)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(deployLeases.id, input.leaseId),
        eq(deployLeases.companyId, input.companyId),
        eq(deployLeases.status, "active"),
      ),
    );
}

// Builder fence: one live attempt per (worktreePath, generation).
export async function acquireBuilderFence(input: {
  db: FenceDb;
  companyId: string;
  worktreePath: string;
  generation: number;
  heartbeatRunId?: string | null;
  issueId?: string | null;
}): Promise<typeof builderFences.$inferSelect> {
  if (!input.worktreePath || input.worktreePath.trim().length === 0) {
    throw conflict("worktreePath is required");
  }
  const normPath = input.worktreePath.trim();
  const existing = await (input.db as Db)
    .select()
    .from(builderFences)
    .where(
      and(
        eq(builderFences.companyId, input.companyId),
        eq(builderFences.worktreePath, normPath),
        eq(builderFences.generation, input.generation),
        eq(builderFences.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existing) {
    throw conflict(
      `builder already active for worktree ${normPath} generation ${input.generation}`,
    );
  }
  const row = await (input.db as Db)
    .insert(builderFences)
    .values({
      companyId: input.companyId,
      worktreePath: normPath,
      generation: input.generation,
      status: "active",
      heartbeatRunId: input.heartbeatRunId ?? null,
      issueId: input.issueId ?? null,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0] as typeof builderFences.$inferSelect);
  return row;
}

export async function releaseBuilderFence(input: {
  db: FenceDb;
  fenceId: string;
  companyId: string;
}): Promise<void> {
  await (input.db as Db)
    .update(builderFences)
    .set({ status: "released", releasedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(builderFences.id, input.fenceId), eq(builderFences.companyId, input.companyId)));
}

export async function heartbeatBuilderFence(input: {
  db: FenceDb;
  fenceId: string;
  companyId: string;
}): Promise<void> {
  await (input.db as Db)
    .update(builderFences)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(builderFences.id, input.fenceId),
        eq(builderFences.companyId, input.companyId),
        eq(builderFences.status, "active"),
      ),
    );
}

// Sweep: reclaim leases whose heartbeatRun died (no longer 'running') or whose
// lastHeartbeatAt is older than STALE_HEARTBEAT_MS. Every 60s via the server
// ticker (like sweepStaleIssueLocks). Fail-open: never throws.
export async function sweepExpiredFences(db: FenceDb): Promise<{ deployExpired: number; builderExpired: number }> {
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
  let deployExpired = 0;
  let builderExpired = 0;
  try {
    // Collect active deploy leases that are stale or whose run is no longer running.
    // Two signals: lastHeartbeatAt stale, OR heartbeatRuns.status != 'running'.
    const staleDeployRows = await (db as Db)
      .select({ id: deployLeases.id, heartbeatRunId: deployLeases.heartbeatRunId, lastHeartbeatAt: deployLeases.lastHeartbeatAt })
      .from(deployLeases)
      .where(and(eq(deployLeases.status, "active"), lt(deployLeases.lastHeartbeatAt, cutoff)));
    for (const row of staleDeployRows) {
      if (row.heartbeatRunId) {
        const run = await (db as Db)
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, row.heartbeatRunId))
          .then((rows) => rows[0] ?? null);
        const stillRunning = run?.status === "running";
        // Stale heartbeat + still reported running: treat as dead (kill mid-attempt).
        // Stale + already terminal: reclaim. Only skip stale rows that are still
        // actively running and recently heartbeated (but they wouldn't be stale then).
        if (stillRunning) {
          // Check if run's lastOutputAt is also stale; if the run is alive but
          // not heartbeating the fence, it is considered expanded after 60s.
          // We still reclaim: generation will bump on next acquire.
        }
      }
      await (db as Db)
        .update(deployLeases)
        .set({ status: "expired", releasedAt: new Date(), updatedAt: new Date() })
        .where(eq(deployLeases.id, row.id));
      deployExpired += 1;
    }
    // Also sweep deploy rows whose run is terminal even if not yet stale.
    // This covers the fast path: run cancelled/failed/timed_out without release.
    const terminalDeployCandidates = await (db as Db)
      .select({ id: deployLeases.id, heartbeatRunId: deployLeases.heartbeatRunId })
      .from(deployLeases)
      .where(eq(deployLeases.status, "active"));
    for (const row of terminalDeployCandidates) {
      if (!row.heartbeatRunId) continue;
      // Skip rows already handled above.
      if (staleDeployRows.some((r) => r.id === row.id)) continue;
      const run = await (db as Db)
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, row.heartbeatRunId))
        .then((rows) => rows[0] ?? null);
      if (run && run.status !== "running" && run.status !== "queued") {
        await (db as Db)
          .update(deployLeases)
          .set({ status: "expired", releasedAt: new Date(), updatedAt: new Date() })
          .where(eq(deployLeases.id, row.id));
        deployExpired += 1;
      }
    }

    const staleBuilderRows = await (db as Db)
      .select({ id: builderFences.id, heartbeatRunId: builderFences.heartbeatRunId })
      .from(builderFences)
      .where(and(eq(builderFences.status, "active"), lt(builderFences.lastHeartbeatAt, cutoff)));
    for (const row of staleBuilderRows) {
      await (db as Db)
        .update(builderFences)
        .set({ status: "expired", releasedAt: new Date(), updatedAt: new Date() })
        .where(eq(builderFences.id, row.id));
      builderExpired += 1;
    }
    const activeBuilderCandidates = await (db as Db)
      .select({ id: builderFences.id, heartbeatRunId: builderFences.heartbeatRunId })
      .from(builderFences)
      .where(eq(builderFences.status, "active"));
    for (const row of activeBuilderCandidates) {
      if (!row.heartbeatRunId) continue;
      if (staleBuilderRows.some((r) => r.id === row.id)) continue;
      const run = await (db as Db)
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, row.heartbeatRunId))
        .then((rows) => rows[0] ?? null);
      if (run && run.status !== "running" && run.status !== "queued") {
        await (db as Db)
          .update(builderFences)
          .set({ status: "expired", releasedAt: new Date(), updatedAt: new Date() })
          .where(eq(builderFences.id, row.id));
        builderExpired += 1;
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "concurrency-fences: sweep failed (fail-open)");
  }
  if (deployExpired > 0 || builderExpired > 0) {
    logger.info({ deployExpired, builderExpired }, "concurrency-fences: sweep reclaimed expired fences");
  }
  return { deployExpired, builderExpired };
}

export function nextGenerationForRetry(input: { failedGeneration: number }): number {
  return input.failedGeneration + 1;
}
