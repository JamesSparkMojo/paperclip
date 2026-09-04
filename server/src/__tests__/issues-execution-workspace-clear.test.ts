import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  executionWorkspaces,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// SPA-6006 follow-up: the board workaround for a wedged execution_workspace_id
// (an open issue holding the workspace an escalation insert wants) is
// `PATCH /issues/:id {"executionWorkspaceId": null}`. James measured that the
// API returned 200 while the column kept its value, forcing a direct DB write.
// These tests pin the service contract: an explicit null must clear the
// workspace linkage, not be silently dropped.
describeEmbeddedPostgres("issueService.update clears execution workspace on explicit null", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-workspace-clear-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedIssueWithWorkspace() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Workspace Clear Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace clear project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary project workspace",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Wedged execution workspace",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      title: "Issue holding a wedged workspace",
      status: "todo",
      priority: "high",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, projectId, projectWorkspaceId, executionWorkspaceId, issueId };
  }

  async function readWorkspaceColumns(issueId: string) {
    const [row] = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row;
  }

  it("clears executionWorkspaceId when the update passes null", async () => {
    const { issueId } = await seedIssueWithWorkspace();
    const svc = issueService(db);

    const updated = await svc.update(issueId, { executionWorkspaceId: null });

    expect(updated).not.toBeNull();
    expect(updated!.executionWorkspaceId).toBeNull();
    const row = await readWorkspaceColumns(issueId);
    expect(row.executionWorkspaceId).toBeNull();
  });

  it("clears executionWorkspaceId and preference when both pass null", async () => {
    const { issueId } = await seedIssueWithWorkspace();
    const svc = issueService(db);

    await svc.update(issueId, {
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
    });

    const row = await readWorkspaceColumns(issueId);
    expect(row.executionWorkspaceId).toBeNull();
    expect(row.executionWorkspacePreference).toBeNull();
  });

  it("keeps the workspace when executionWorkspaceId is omitted", async () => {
    const { issueId, executionWorkspaceId } = await seedIssueWithWorkspace();
    const svc = issueService(db);

    await svc.update(issueId, { title: "Retitled, workspace untouched" });

    const row = await readWorkspaceColumns(issueId);
    expect(row.executionWorkspaceId).toBe(executionWorkspaceId);
  });

  // The live instance runs with enableIsolatedWorkspaces=false (default). The
  // strip-storm must still honor an explicit null — the wedged-workspace
  // workaround depends on it — while non-null values stay gated behind the flag.
  it("clears executionWorkspaceId on explicit null even when isolated workspaces are disabled", async () => {
    const { issueId } = await seedIssueWithWorkspace();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    const svc = issueService(db);

    const updated = await svc.update(issueId, { executionWorkspaceId: null });

    expect(updated).not.toBeNull();
    expect(updated!.executionWorkspaceId).toBeNull();
    const row = await readWorkspaceColumns(issueId);
    expect(row.executionWorkspaceId).toBeNull();
    // Preference may stay reuse_existing when only the id is nulled — the
    // critical fix is that the unique-index holder (executionWorkspaceId)
    // actually clears, which the previous guard swallowed.
  });
});
