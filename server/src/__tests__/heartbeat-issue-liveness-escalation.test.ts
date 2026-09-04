import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import { DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // reconcileIssueGraphLiveness heals dependency wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
      enableIsolatedWorkspaces: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function enableAutoRecovery() {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: true,
    });
  }

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  it("keeps liveness findings advisory when auto recovery is disabled", async () => {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
    });
    const { companyId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryDisabled).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active when liveness auto recovery is disabled", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);
    expect(result.escalationsCreated).toBe(0);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(`issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`);
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    await enableAutoRecovery();
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);
    expect(result.escalationsCreated).toBe(0);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(`issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`);
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileIssueGraphLiveness();

    expect(beforeAssignment.dependencyWakesHealed).toBe(0);
    expect(beforeAssignment.dependencyWakeBackstopChecked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileIssueGraphLiveness();

    expect(afterAssignment.dependencyWakesHealed).toBe(1);
    expect(afterAssignment.dependencyWakeIssueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
    });
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeExistingSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    await enableAutoRecovery();
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileIssueGraphLiveness();

    expect(beforeFinalize.findings).toBe(0);
    expect(beforeFinalize.dependencyWakesHealed).toBe(0);
    expect(beforeFinalize.dependencyWakeNotReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileIssueGraphLiveness();

    expect(afterFinalize.dependencyWakesHealed).toBe(1);
    expect(afterFinalize.dependencyWakeIssueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    await enableAutoRecovery();
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeExistingSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    await enableAutoRecovery();
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeDeferredOrFailed).toBe(1);
    expect(result.dependencyWakeEnqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

  it("does not create recovery issues outside the configured lookback window", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ outsideLookback: true });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedOutsideLookback).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("suppresses liveness escalation when the source issue is under an active pause hold", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId } = await seedBlockedChain();

    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: blockedIssueId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.skipped).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("treats an active executionRunId on the leaf blocker as a live execution path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      contextSnapshot: { issueId: blockedIssueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerIssueId));
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("creates one bounded escalation for an assigned backlog blocker leaf", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.findings).toBe(1);
    expect(first.escalationsCreated).toBe(1);
    expect(second.findings).toBe(0);
    expect(second.escalationsCreated).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: coderId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });
  });

  it("treats open recovery issues as active waiting paths for non-assigned-backlog states", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const existingEscalationId = randomUUID();

    await db.insert(issues).values({
      id: existingEscalationId,
      companyId,
      title: "Existing liveness unblock work",
      status: "todo",
      priority: "high",
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      issueNumber: 5,
      identifier: `${`P${companyId.replace(/-/g, "").slice(0, 4)}`}-5`,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
  });

  it("keeps active invalid_review_participant recoveries from being retired", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const existingEscalationId = randomUUID();

    await db.insert(issues).values({
      id: existingEscalationId,
      companyId,
      title: "Existing invalid review participant unblock work",
      status: "todo",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 5,
      identifier: `${`P${companyId.replace(/-/g, "").slice(0, 4)}`}-5`,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "invalid_review_participant",
        blockerIssueId,
      ].join(":"),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
  });

  it("creates one manager escalation, preserves blockers, and records owner selection", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.escalationsCreated).toBe(1);
    const [sourceAfterFirst] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    const eventsAfterFirst = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(eventsAfterFirst.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(1);

    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(second.escalationsCreated).toBe(0);
    const [sourceAfterSecond] = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(sourceAfterSecond?.updatedAt.getTime()).toBe(sourceAfterFirst?.updatedAt.getTime());

    const escalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalations[0]!.id].sort(),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("harness-level liveness incident");
    expect(comments[0]?.body).toContain(escalations[0]?.identifier ?? escalations[0]!.id);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.details).toMatchObject({
      recoveryIssueId: blockerIssueId,
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "root_agent",
        selectedSourceIssueId: blockerIssueId,
      },
      workspaceSelection: {
        reuseRecoveryExecutionWorkspace: false,
        inheritedExecutionWorkspaceFromIssueId: null,
        projectWorkspaceSourceIssueId: blockerIssueId,
      },
    });
    expect(events.filter((event) => event.action === "issue.blockers.updated")).toHaveLength(1);
  });

  it("skips budget-blocked direct owners and assigns recovery to the manager fallback", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        updatedAt: issueTimestamp,
      })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: coderId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      issueId: blockerIssueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent?.details).toMatchObject({
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        budgetBlockedCandidateAgentIds: [coderId],
      },
    });
  });

  it("parents recovery under the leaf blocker without inheriting dependent or blocker execution state for manager-owned recovery", async () => {
    await enableAutoRecovery();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const companyId = randomUUID();
    const managerId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentProjectId = randomUUID();
    const blockerProjectId = randomUUID();
    const dependentProjectWorkspaceId = randomUUID();
    const blockerProjectWorkspaceId = randomUUID();
    const dependentExecutionWorkspaceId = randomUUID();
    const blockerExecutionWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Root Operator",
      role: "operator",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values([
      {
        id: dependentProjectId,
        companyId,
        name: "Dependent workspace project",
        status: "in_progress",
      },
      {
        id: blockerProjectId,
        companyId,
        name: "Blocker workspace project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: dependentProjectWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        name: "Dependent primary",
      },
      {
        id: blockerProjectWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        name: "Blocker primary",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: dependentExecutionWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Dependent branch",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: blockerExecutionWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Blocker branch",
        status: "active",
        providerType: "git_worktree",
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        executionWorkspaceId: dependentExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        executionWorkspaceId: blockerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Unassigned leaf blocker",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      projectId: blockerProjectId,
      projectWorkspaceId: blockerProjectWorkspaceId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      assigneeAgentId: managerId,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
    });
  });

  it("reuses one open recovery issue for multiple dependents with the same leaf blocker", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(2);
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);

    const blockers = await db
      .select({ blockedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.issueId, escalations[0]!.id)));
    expect(blockers.map((row) => row.blockedIssueId).sort()).toEqual(
      [blockedIssueId, secondBlockedIssueId].sort(),
    );
  });

  it("holds a recently closed matching escalation, then re-escalates after the cooldown", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const now = new Date();
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");
    const closedEscalationId = randomUUID();

    await db.insert(issues).values({
      id: closedEscalationId,
      companyId,
      title: "Closed escalation",
      status: "done",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 3,
      identifier: "CLOSED-3",
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      updatedAt: now,
    });

    const held = await heartbeat.reconcileIssueGraphLiveness({ now });

    expect(held.escalationsCreated).toBe(0);
    expect(held.skippedReescalationCooldown).toBe(1);

    const result = await heartbeat.reconcileIssueGraphLiveness({
      now: new Date(now.getTime() + DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS + 1),
    });

    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(0);

    const openEscalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.originId, incidentKey),
        ),
      );
    expect(openEscalations).toHaveLength(2);
    const freshEscalation = openEscalations.find((issue) => issue.status !== "done");
    expect(freshEscalation).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
    });

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.some((row) => row.blockerIssueId === closedEscalationId)).toBe(false);
    expect(blockers.some((row) => row.blockerIssueId === freshEscalation?.id)).toBe(true);
  });

  it("re-escalates immediately after a matching escalation is cancelled", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);
    const now = new Date();
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Cancelled escalation",
      status: "cancelled",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 3,
      identifier: "CANCELLED-3",
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      updatedAt: now,
    });

    const result = await heartbeat.reconcileIssueGraphLiveness({ now });

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedReescalationCooldown).toBe(0);
  });

  it("removes closed liveness escalations from blocker relations during reconciliation", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLiveness();
    expect(first.escalationsCreated).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(1);

    await db
      .update(issues)
      .set({ status: "done", blockedByIssueIds: [] })
      .where(eq(issues.id, escalations[0]!.id));
    await db
      .update(issues)
      .set({ status: "done", blockedByIssueIds: [] })
      .where(eq(issues.id, blockerIssueId));

    const second = await heartbeat.reconcileIssueGraphLiveness();
    expect(second.obsoleteRecoveryBlockerRelationsRemoved).toBe(0);
    expect(second.doneRecoveryBlockerRelationsRemoved).toBe(1);

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.some((row) => row.blockerIssueId === escalations[0]!.id)).toBe(false);
  });

  it("handles an armed cutoff when no liveness findings exist", async () => {
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileIssueGraphLiveness({
      issueCreatedAtGte: new Date(),
    });

    expect(result.findings).toBe(0);
  });

  // SPA-6006 R1 oracle: when the recovery issue holds an execution_workspace_id
  // that is already claimed by an OPEN sibling issue, the new escalation INSERT
  // must NOT inherit that workspace (which would trip the partial unique index
  // and retry forever). The escalation must succeed and the parent must keep
  // its workspace.
  it("does not inherit a held execution_workspace_id when creating a liveness escalation", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();

    // Wire the recovery (blocker) issue + an OPEN sibling both into the same
    // execution workspace — the precondition for the partial unique collision.
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "SPA-6006 workspace-sharing project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "SPA-6006 workspace",
      sourceType: "git_worktree",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "SPA-6006 held execution workspace",
      providerType: "git_worktree",
    });

    // The recovery (blocker) issue still owns the workspace (open).
    await db
      .update(issues)
      .set({ executionWorkspaceId, projectId })
      .where(eq(issues.id, blockerIssueId));

    // And a separate OPEN sibling already holds the same workspace — this is
    // the precondition that previously tripped the partial unique index.
    const siblingOpenIssueId = randomUUID();
    await db.insert(issues).values({
      id: siblingOpenIssueId,
      companyId,
      projectId,
      title: "Open sibling that already holds the workspace",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      executionWorkspaceId,
      issueNumber: 99,
      identifier: `${`S${companyId.replace(/-/g, "").slice(0, 4)}`}-99`,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);

    // The recovery (blocker) issue keeps its workspace.
    const blockerAfter = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blockerAfter?.executionWorkspaceId).toBe(executionWorkspaceId);

    // The new escalation must NOT have inherited that workspace.
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      executionWorkspaceId: null,
    });
    expect(escalations[0]?.assigneeAgentId).toBeTruthy();
    // Defensive cross-link: the blocker is still the recovery issue and the
    // newly blocked issue is the originally blocked one.
    expect(escalations[0]?.id).not.toBe(siblingOpenIssueId);
    expect(blockedIssueId).not.toBe(siblingOpenIssueId);
  });

  // SPA-6006 R2 oracle: a failed incident INSERT must not invoke any agent
  // heartbeat. We force the INSERT to throw with a non-raced-recovery error
  // (FK violation) by removing the parent (recovery) issue out from under
  // the escalation insert.
  it("does not invoke any agent heartbeat when the liveness escalation INSERT throws", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();

    // First reconciliation succeeds and creates an escalation. Then we close
    // the escalation and remove the parent blocker issue (cascading relations
    // first) so the next reconciliation will fail to insert a new escalation
    // because parentId references a missing row.
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileIssueGraphLiveness();
    expect(first.escalationsCreated).toBe(1);

    const createdEscalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(createdEscalations).toHaveLength(1);
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, createdEscalations[0]!.id));
    await db.delete(issueRelations).where(eq(issueRelations.issueId, blockerIssueId));
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, blockerIssueId));
    await db.update(issues).set({ parentId: null }).where(eq(issues.parentId, blockerIssueId));
    await db.delete(issues).where(eq(issues.id, blockerIssueId));

    const wakesBefore = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));

    const result = await heartbeat.reconcileIssueGraphLiveness();
    expect(result.escalationsCreated).toBe(0);

    const wakesAfter = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    // No new wake may fire when the escalation INSERT throws.
    expect(wakesAfter.length).toBe(wakesBefore.length);

    // Sanity: the same incident never created a partial row.
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(blockedIssueId).not.toBe(blockerIssueId);
  });

  // SPA-6006 R3 oracle: a successful first reconciliation creates the escalation
// + wake. Subsequent reconciliations must not stack additional wakes on top
// of the same incident key (R1+R3 combined). Drive 10 ticks and assert no
// new wake fires after the first.
  it("backs off on repeated identical liveness escalation outcomes (no new wake for 10 ticks)", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatService(db);

    // First reconcile creates the escalation + fires the initial wake. After
    // that, every subsequent reconcile must see the existing escalation and
    // not fire another wake.
    const first = await heartbeat.reconcileIssueGraphLiveness();
    expect(first.escalationsCreated).toBe(1);

    const wakesBefore = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));

    // Drive 10 follow-up ticks. None must fire a new wake, none must create a
    // new escalation, and none must error.
    for (let i = 0; i < 10; i += 1) {
      const r = await heartbeat.reconcileIssueGraphLiveness();
      expect(r.escalationsCreated).toBe(0);
    }

    const wakesAfter = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));

    // The core SPA-6006 oracle: zero new wake rows across 10 follow-up ticks.
    // Pre-fix, every tick woke the assignee.
    expect(wakesAfter.length).toBe(wakesBefore.length);
  });
});
