#!/usr/bin/env node
// SPA-4929 sandbox proof — runs a vitest case that prints the rendered TTY line
// to stdout. Captures both human and --json output for PR body.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const issueId = "5455a04c-f4e7-4ab6-88b9-b3448448cbd4";
const interactionId = "f71b6e33-9baf-4cb8-9ba5-929523f71f43";

const test = `
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerIssueCommands } from "../commands/client/issue";

describe("sandbox SPA-4929 render proof", () => {
  it("prints pendingInteraction line in TTY mode", async () => {
    const mockRow = {
      id: "${issueId}",
      identifier: "SPA-4929",
      title: "SPA-4885/BUILD: surface pending interactions",
      status: "todo",
      priority: "low",
      pendingInteractions: [
        {
          id: "${interactionId}",
          kind: "request_confirmation",
          title: null,
          status: "pending",
          createdAt: new Date(Date.now() - 60000).toISOString(),
          createdByAgentId: "55ea2812-f43f-4dee-bb5c-aaaf822ae042",
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(mockRow), { headers: { "content-type": "application/json" } })));

    const captured = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => captured.push(args.join(" ")));
    const orig = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const { Command } = await import("commander");
    const { registerIssueCommands } = await import("../commands/client/issue");
    const issueId = "${issueId}";
    try {
      const prog = new Command();
      prog.exitOverride();
      prog.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      registerIssueCommands(prog);
      await prog.parseAsync([
        "issue",
        "get",
        issueId,
        "--api-base",
        "http://localhost:3100",
        "--api-key",
        "board-token",
      ], { from: "user" });
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
    }
    process.stderr.write("===SANDBOX_HUMAN_OUTPUT_BEGIN===" + captured.join("\\n") + "===SANDBOX_HUMAN_OUTPUT_END===");
    expect(captured.join("\\n")).toContain("pendingInteraction");
  });
});
`;

writeFileSync("cli/src/__tests__/sandbox-spa-4929-render.test.ts", test);

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--project", "paperclipai", "cli/src/__tests__/sandbox-spa-4929-render.test.ts"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
);

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
