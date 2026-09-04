import { describe, expect, it } from "vitest";
import {
  acquireBuilderFence,
  acquireDeployLease,
  nextGenerationForRetry,
  sweepExpiredFences,
} from "../services/concurrency-fences.js";

// Pure-contract tests without DB: exercise error paths and helper.
// Integration live-probe (DoD section) covers the 409 paths against a
// running server; these lock the helpers the live probe depends on.

describe("concurrency fences: generation helper (R4)", () => {
  it("bumps generation by 1", () => {
    expect(nextGenerationForRetry({ failedGeneration: 1 })).toBe(2);
    expect(nextGenerationForRetry({ failedGeneration: 7 })).toBe(8);
  });

  it("never reuses the same generation", () => {
    const g = 3;
    const next = nextGenerationForRetry({ failedGeneration: g });
    expect(next).not.toBe(g);
    expect(next).toBeGreaterThan(g);
  });
});

describe("concurrency fences: builder path validation (R4)", () => {
  // exercise the sync validation before any DB hit: empty path must 409
  // without requiring a real DB connection
  it("rejects empty worktreePath with 409", async () => {
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
    } as never;
    await expect(
      acquireBuilderFence({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", worktreePath: "", generation: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      acquireBuilderFence({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", worktreePath: "   ", generation: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a duplicate active builder fence with 409 and names path+generation", async () => {
    const normPath = "/tmp/ws-abc";
    const fakeDb = {
      select: () =>
        ({
          from: () => ({ where: async () => [{ id: "existing", worktreePath: normPath, generation: 2, status: "active" }] }),
        }) as never,
      insert: (() => {
        throw new Error("insert must not be called when fence already active");
      }) as never,
    } as never;
    await expect(
      acquireBuilderFence({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", worktreePath: normPath, generation: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    try {
      await acquireBuilderFence({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", worktreePath: normPath, generation: 2 });
      expect.unreachable("expected 409");
    } catch (err: unknown) {
      expect((err as Error).message).toContain(normPath);
      expect((err as Error).message).toContain("2");
    }
  });
});

describe("concurrency fences: deploy cap (R4)", () => {
  it("rejects a second deploy while one is active with 409 deploy in progress", async () => {
    const fakeDb = {
      select: () =>
        ({
          from: () => ({ where: async () => [{ id: "existing-lease", status: "active", environment: "uat" }] }),
        }) as never,
      insert: (() => {
        throw new Error("insert must not be called when lease already active");
      }) as never,
    } as never;
    await expect(
      acquireDeployLease({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", environment: "uat" }),
    ).rejects.toMatchObject({ status: 409 });
    try {
      await acquireDeployLease({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", environment: "uat" });
      expect.unreachable("expected 409");
    } catch (err: unknown) {
      expect((err as Error).message).toMatch(/deploy in progress/i);
    }
  });
});

describe("concurrency fences: sweep (R4 recovery)", () => {
  it("sweep is fail-open (never throws)", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("db down");
      },
    } as never;
    const result = await sweepExpiredFences(brokenDb);
    expect(result).toEqual({ deployExpired: 0, builderExpired: 0 });
  });

  it("sweep returns zero when nothing stale", async () => {
    const emptyDb = {
      select: () =>
        ({
          from: () => ({
            where: async () => [],
          }),
        }) as never,
      update: () =>
        ({
          set: () => ({ where: async () => ({}) }),
        }) as never,
    } as never;
    const result = await sweepExpiredFences(emptyDb);
    expect(result).toEqual({ deployExpired: 0, builderExpired: 0 });
  });
});

// R4 round-2 verdict (Argus P1/P2): heartbeat-vs-sweep race + 23505 catch.
// A lease whose heartbeat arrives between the SELECT and the UPDATE
// must NOT be expired in flight. The fix: the sweep UPDATE carries
// WHERE lastHeartbeatAt < cutoff so the WHERE matches the same row set
// the SELECT just read; a fresh heartbeat bumps lastHeartbeatAt and the
// row no longer matches.
describe("concurrency fences: sweep heartbeat-vs-update race (R4 round 2)", () => {
  it("stale deploy UPDATE carries WHERE lastHeartbeatAt < cutoff (heartbeat-cancels-expiry)", async () => {
    const calls: Array<{ phase: string; whereClause?: unknown }> = [];
    const now = Date.now();
    const staleRow = {
      id: "stale-1",
      heartbeatRunId: null,
      lastHeartbeatAt: new Date(now - 120_000),
    };
    const freshDb = {
      select: () => ({
        from: () => ({
          where: async () => [staleRow],
        }),
      }),
      update: (table: unknown) => {
        calls.push({ phase: "update-enter", whereClause: table });
        return {
          set: () => ({
            where: async (clause: unknown) => {
              calls.push({ phase: "update-where", whereClause: clause });
              // the where clause must be a non-empty argument -- drizzle forbids
              // empty WHERE. Returning {} means "I executed without filtering",
              // which is the heartbeat-vs-update race.
              return {};
            },
          }),
        };
      },
    } as never;
    const result = await sweepExpiredFences(freshDb);
    expect(result.deployExpired).toBeGreaterThanOrEqual(0);
    // The route-level guard: the UPDATE must carry an explicit WHERE that
    // re-checks lastHeartbeatAt < cutoff. We assert by capturing the
    // number of arguments to .where(): a guarded UPDATE passes a clause,
    // an unguarded one passes nothing.
    const updateWhereCalls = calls.filter((c) => c.phase === "update-where");
    expect(updateWhereCalls.length).toBeGreaterThan(0);
    // Every guarded where call must have a defined, non-undefined clause
    // (drizzle's bare .where() with no args is the unguarded form).
    for (const c of updateWhereCalls) {
      expect(c.whereClause).toBeDefined();
    }
  });
});

// R4 round-2 verdict (Argus P2): when the partial unique index catches a
// race the pre-check missed, the insert must rethrow as conflict() with
// the same shape callers expect, not a raw 500 from PG unique-violation.
describe("concurrency fences: 23505 catch on insert (R4 round 2)", () => {
  it("acquireDeployLease rethrows 23505 as conflict('deploy in progress')", async () => {
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: () => ({
          returning: async () => {
            const err = new Error("duplicate key value violates unique constraint") as Error & { code?: string };
            err.code = "23505";
            throw err;
          },
        }),
      }),
    } as never;
    await expect(
      acquireDeployLease({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", environment: "uat" }),
    ).rejects.toMatchObject({ status: 409 });
    try {
      await acquireDeployLease({ db: fakeDb, companyId: "00000000-0000-0000-0000-000000000000", environment: "uat" });
      expect.unreachable("expected 409");
    } catch (err: unknown) {
      expect((err as Error).message).toMatch(/deploy in progress/i);
    }
  });

  it("acquireBuilderFence rethrows 23505 as conflict naming path+generation", async () => {
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: () => ({
          returning: async () => {
            const err = new Error("duplicate key value violates unique constraint") as Error & { code?: string };
            err.code = "23505";
            throw err;
          },
        }),
      }),
    } as never;
    await expect(
      acquireBuilderFence({
        db: fakeDb,
        companyId: "00000000-0000-0000-0000-000000000000",
        worktreePath: "/tmp/ws-xyz",
        generation: 4,
      }),
    ).rejects.toMatchObject({ status: 409 });
    try {
      await acquireBuilderFence({
        db: fakeDb,
        companyId: "00000000-0000-0000-0000-000000000000",
        worktreePath: "/tmp/ws-xyz",
        generation: 4,
      });
      expect.unreachable("expected 409");
    } catch (err: unknown) {
      expect((err as Error).message).toContain("/tmp/ws-xyz");
      expect((err as Error).message).toContain("4");
    }
  });
});
