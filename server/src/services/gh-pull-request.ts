import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GhPullRequestMatch = {
  headSha: string;
  url: string | null;
};

export type GhPullRequestLookupInput = {
  repoUrl: string;
  branchName: string;
  expectedHeadSha: string;
};

export type GhPullRequestService = {
  findOpenByBranch: (input: GhPullRequestLookupInput) => Promise<GhPullRequestMatch | null>;
};

/**
 * Resolve the owner/repo host for a github.com-style repo URL. Returns null for
 * non-github.com URLs — non-GitHub PR systems are out of scope for this guard
 * and the precondition short-circuits there.
 */
export function parseGitHubRepo(repoUrl: string): {
  host: "github.com";
  owner: string;
  repo: string;
} | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") {
    return null;
  }
  const segments = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { host: "github.com", owner, repo };
}

/**
 * `gh pr list --state open --head <branch> --json headRefOid,url -L 1`
 * Returns the headRefOid of the open PR on this branch (or null if none).
 *
 * `gh` returns a non-zero exit code if no PR matches the head, but it also
 * prints no JSON, so we treat both "empty stdout" and "exit code != 0 with no
 * JSON" as no-match rather than as a hard failure — the precondition wants to
 * refuse `in_review` until a PR exists, not to block on transient `gh` errors.
 */
export async function ghListOpenPullRequestForBranch(input: {
  owner: string;
  repo: string;
  branchName: string;
}): Promise<GhPullRequestMatch | null> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        `${input.owner}/${input.repo}`,
        "--state",
        "open",
        "--head",
        input.branchName,
        "--json",
        "headRefOid,url",
        "--limit",
        "1",
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    stdout = err.stdout ?? "";
    if (!stdout) return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "[]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0] as { headRefOid?: unknown; url?: unknown };
  const headRefOid = typeof first.headRefOid === "string" ? first.headRefOid : null;
  const url = typeof first.url === "string" ? first.url : null;
  if (!headRefOid) return null;
  return { headSha: headRefOid, url };
}

export function ghPullRequestService(): GhPullRequestService {
  return {
    async findOpenByBranch(input) {
      const parsed = parseGitHubRepo(input.repoUrl);
      if (!parsed) return null;
      const match = await ghListOpenPullRequestForBranch({
        owner: parsed.owner,
        repo: parsed.repo,
        branchName: input.branchName,
      });
      if (!match) return null;
      // SHA equality is what the canary guard demands: an open PR on the
      // branch but pointing at an old push still leaves the issue without a
      // reviewable surface. Refuse with the same line so the builder fixes it.
      if (match.headSha !== input.expectedHeadSha) return null;
      return match;
    },
  };
}