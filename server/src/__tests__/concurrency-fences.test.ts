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
