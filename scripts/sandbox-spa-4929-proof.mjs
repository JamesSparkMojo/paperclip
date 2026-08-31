#!/usr/bin/env node
// SPA-4929 sandbox proof harness — runs `paperclipai issue get <id>` against
// a mock HTTP server that returns an issue shape with a pending request_confirmation.
// Captures human-mode and --json stdout for PR body.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const ISSUE_ID = "5455a04c-f4e7-4ab6-88b9-b3448448cbd4";
const INTERACTION_ID = "f71b6e33-9baf-4cb8-9ba5-929523f71f43";

const mockIssue = {
  id: ISSUE_ID,
  identifier: "SPA-4929",
  title: "SPA-4885/BUILD: surface pending interactions in `paperclipai issue get` output (paperclip fork)",
  status: "todo",
  priority: "low",
  pendingInteractions: [
    {
      id: INTERACTION_ID,
      kind: "request_confirmation",
      title: null,
      status: "pending",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      createdByAgentId: "55ea2812-f43f-4dee-bb5c-aaaf822ae042",
    },
  ],
};

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(mockIssue));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const runCli = (args) =>
  new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ["./cli/dist/index.js", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PAPERCLIP_API_URL: baseUrl,
          PAPERCLIP_API_KEY: "sandbox-test-key",
          PAPERCLIP_COMPANY_ID: "00000000-0000-0000-0000-000000000000",
          FORCE_COLOR: "0",
        },
      }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });

console.log("=== HUMAN MODE (TTY=1) ===");
const tty = await runCli(["issue", "get", ISSUE_ID]);
console.log(tty.stdout);

console.log("\n=== JSON MODE --json --include-interactions ===");
const json = await runCli(["issue", "get", ISSUE_ID, "--json", "--include-interactions"]);
console.log(json.stdout);

console.log("\n=== JSON MODE --json --no-include-interactions (back-compat) ===");
const noFlag = await runCli(["issue", "get", ISSUE_ID, "--json", "--no-include-interactions"]);
console.log(noFlag.stdout);

server.close();
