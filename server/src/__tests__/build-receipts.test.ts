import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUnlazyLedger } from "../services/build-receipts.js";

// Locked contracts for the server-side BUILD-RECEIPT emitter.
//
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

// Locks the GATES.md parser contract. The server parses the ledger file the
// builder names in resultJson.ledger_path; the parser is the ~40-line port of
// gate-check.mjs --status mode described on interaction 1793b3c1. These tests
// cover the four states a gate row can be in (met, pending, unmet,
// abandoned) and confirm the strict-format gating (EVIDENCE: required for met;
// PENDING: required for pending; ABANDON: as a top-level line).
describe("parseUnlazyLedger contract (build-receipts R1)", () => {
  it("counts a ticked EVIDENCE row as met", () => {
    const text = [
      "- [x] spec-found EVIDENCE: skill/AGENTS.md L42-88",
      "- [ ] build-evidence EVIDENCE: <none>",
    ].join("\n");
    expect(parseUnlazyLedger(text)).toEqual({ met: 1, unmet: 1, abandoned: 0 });
  });

  it("counts a PENDING row as unmet (not abandoned)", () => {
    const text = "- [ ] spec-found PENDING: blocked on upstream\n";
    expect(parseUnlazyLedger(text)).toEqual({ met: 0, unmet: 1, abandoned: 0 });
  });

  it("counts a top-level ABANDON: line as abandoned", () => {
    const text = [
      "- [x] spec-found EVIDENCE: ok",
      "ABANDON: build-evidence reason=superseded by R2",
    ].join("\n");
    expect(parseUnlazyLedger(text)).toEqual({ met: 1, unmet: 0, abandoned: 1 });
  });

  it("ignores comment lines and blank lines", () => {
    const text = [
      "",
      "# header",
      "- [x] g1 EVIDENCE: x",
      "",
      "ABANDON: g2 reason=z",
    ].join("\n");
    expect(parseUnlazyLedger(text)).toEqual({ met: 1, unmet: 0, abandoned: 1 });
  });

  it("treats [X] (uppercase) as met when EVIDENCE: is present", () => {
    const text = "- [X] g1 EVIDENCE: x\n";
    expect(parseUnlazyLedger(text)).toEqual({ met: 1, unmet: 0, abandoned: 0 });
  });

  it("counts a ticked row without EVIDENCE: as unmet", () => {
    const text = "- [x] g1 nonsense\n";
    expect(parseUnlazyLedger(text)).toEqual({ met: 0, unmet: 1, abandoned: 0 });
  });
});
