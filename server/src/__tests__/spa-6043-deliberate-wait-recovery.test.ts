import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("SPA-6043 deliberate continuation waits (recovery reconcile)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spa-6043-deliberate-wait-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(input: { executionPolicy?: Record<string, unknown> | null } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `DW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Deliberate Wait Co",
      issuePrefix: prefix,
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
        runtimeConfig: {},
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
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Parked waiting on external check",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      ...(input.executionPolicy !== undefined ? { executionPolicy: input.executionPolicy } : {}),
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedParkedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId?: string;
  }) {
    const runId = input.runId ?? randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: "cancelled",
      error: "Cancelled because the continuation summary says the executor should wait for reviewer feedback",
      errorCode: "issue_continuation_waiting_on_review",
      startedAt: new Date("2026-09-03T12:00:00.000Z"),
      finishedAt: new Date("2026-09-03T12:01:00.000Z"),
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
      },
    });
    return runId;
  }

  const REVIEW_STAGE_POLICY = {
    mode: "normal",
    commentRequired: true,
    stages: [{
      id: "11111111-1111-4111-8111-111111111111",
      type: "review",
      approvalsNeeded: 1,
      participants: [{ type: "agent", userId: null, agentId: "22222222-2222-4222-8222-222222222222" }],
    }],
  };

  it("case 1: review-stage card advances to in_review with the reviewer woken, assignee kept", async () => {
    const reviewerId = "22222222-2222-4222-8222-222222222222";
    const { companyId, coderId, sourceIssue } = await seedCompany({
      executionPolicy: REVIEW_STAGE_POLICY,
    });
    await seedParkedRun({ companyId, agentId: coderId, issueId: sourceIssue.id });
    // The review-stage participant must be a real agent row for the wake to
    // have a target; add it as a peer engineer (no reportsTo link to coder).
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    const stageWakes = enqueueWakeup.mock.calls.filter(
      ([, wake]) => wake?.reason === "execution_review_requested",
    );
    expect(stageWakes).toHaveLength(1);
    expect(stageWakes[0]?.[0]).toBe(reviewerId);
    expect(result.waitingOnReviewResolved).toBe(1);
  });

  it("case 2: external-wait card re-wakes the same owner via scheduled retry, never the manager", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await seedParkedRun({ companyId, agentId: coderId, issueId: sourceIssueId });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    expect(result.continuationRequeued).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBe(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    // A scheduled_retry run exists for the same owner, not the manager.
    const scheduledRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, coderId),
        eq(heartbeatRuns.status, "scheduled_retry"),
      ));
    expect(scheduledRuns).toHaveLength(1);
    expect(scheduledRuns[0]?.contextSnapshot).toMatchObject({
      issueId: sourceIssueId,
      source: "recovery.deliberate_wait_recheck",
    });
    // The manager was never woken.
    const managerWakes = enqueueWakeup.mock.calls.filter(([agentId]) => agentId === managerId);
    expect(managerWakes).toHaveLength(0);
    // One system comment names the wait.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssueId));
    expect(comments.some((comment) => (comment.body ?? "").includes("re-check scheduled"))).toBe(true);
  });

  it("case 3: escalation only after the strand threshold, then a genuine escalation still lands", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    // Seed 3 consecutive parked strands -> next reconcile must escalate.
    for (let i = 0; i < 3; i += 1) {
      await seedParkedRun({ companyId, agentId: coderId, issueId: sourceIssueId });
    }
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    expect(result.escalated).toBe(1);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(action?.ownerAgentId).toBe(managerId);
  });

  it("below threshold: second parked strand still re-wakes the owner, not the manager", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await seedParkedRun({ companyId, agentId: coderId, issueId: sourceIssueId });
    await seedParkedRun({ companyId, agentId: coderId, issueId: sourceIssueId });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({ status: "in_progress", assigneeAgentId: coderId });
    const managerWakes = enqueueWakeup.mock.calls.filter(([agentId]) => agentId === managerId);
    expect(managerWakes).toHaveLength(0);
  });
});
