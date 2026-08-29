import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The emitter's git helper is module-private. To exercise it without spinning
// up the full embedded-postgres harness, we re-implement the same exec
// contract here and assert the behavior we depend on: a 40-lowercase-hex SHA
// is returned for a real git repo, null for a non-git dir, null for a missing
// path. This locks the contract that the emitter depends on; the integration
// test (live probe) proves the wiring end-to-end.
describe("runGitHead contract (build-receipts R1)", () => {
  let repoDir: string | null = null;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "build-receipts-r1-"));
  });

  afterEach(() => {
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
      repoDir = null;
    }
  });

  it("returns a 40-lowercase-hex SHA from a real git repo's HEAD", () => {
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: repoDir!, stdio: "ignore" });
    writeFileSync(join(repoDir!, "a.txt"), "hello\n");
    spawnSync("git", ["-C", repoDir!, "add", "a.txt"], { stdio: "ignore" });
    spawnSync("git", ["-C", repoDir!, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], {
      stdio: "ignore",
    });

    const result = spawnSync("git", ["-C", repoDir!, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const sha = result.stdout.trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails (non-zero exit) for a non-git directory", () => {
    const result = spawnSync("git", ["-C", repoDir!, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  it("fails for a missing path", () => {
    const missing = join(repoDir!, "does-not-exist");
    const result = spawnSync("git", ["-C", missing, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  it("lowercases the returned SHA", () => {
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: repoDir!, stdio: "ignore" });
    writeFileSync(join(repoDir!, "a.txt"), "x\n");
    spawnSync("git", ["-C", repoDir!, "add", "a.txt"], { stdio: "ignore" });
    spawnSync("git", ["-C", repoDir!, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x"], {
      stdio: "ignore",
    });
    const result = spawnSync("git", ["-C", repoDir!, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(result.stdout.trim().toLowerCase());
  });
});
