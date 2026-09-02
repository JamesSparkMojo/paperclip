import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(async () => ({ adoptedFromRunId: null })),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 0 })),
  getCurrentScheduledRetry: vi.fn(async () => null),
  listReviewAttention: vi.fn(async () => new Map()),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  decide: vi.fn(async (input: { action?: string }) => ({
    allowed: true,
    action: input.action,
    reason: "allow_explicit_grant",
    explanation: "Allowed by test grant.",
  })),
  hasPermission: vi.fn(async () => true),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  getById: vi.fn(),
  createForIssue: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockGhPullRequestService = vi.hoisted(() => ({
  findOpenByBranch: vi.fn(async () => null),
}));

const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  for: vi.fn(() => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([]).then(onFulfilled, onRejected),
  })),
  orderBy: vi.fn(() => ({
    limit: vi.fn(() => Promise.resolve([])),
  })),
  limit: vi.fn(() => Promise.resolve([])),
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn((table: unknown) => {
  // executionWorkspaces is queried for resolveIssueRepoUrl; return a github
  // repo so the precondition can resolve a repoUrl. Checked before
  // heartbeatRuns because both tables share many of the same column shapes
  // on the Symbol-keyed Drizzle objects.
  const isExecutionWorkspaces = Boolean(
    table
      && typeof table === "object"
      && "sourceIssueId" in (table as Record<string, unknown>)
      && "repoUrl" in (table as Record<string, unknown>)
      && "branchName" in (table as Record<string, unknown>)
      && "openedAt" in (table as Record<string, unknown>),
  );
  if (isExecutionWorkspaces) {
    return {
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{
            repoUrl: "https://github.com/Spark-Mojo/spark-mojo-platform",
          }])),
        })),
        limit: vi.fn(() => Promise.resolve([])),
        then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([]).then(onFulfilled, onRejected),
      })),
    };
  }
  // heartbeatRuns is queried for cross-issue-influence-limit; return a valid
  // run row so the cap does not refuse the request with 403.
  const isHeartbeatRuns = Boolean(
    table
      && typeof table === "object"
      && "id" in (table as Record<string, unknown>)
      && "agentId" in (table as Record<string, unknown>)
      && "responsibleUserId" in (table as Record<string, unknown>)
      && "contextSnapshot" in (table as Record<string, unknown>),
  );
  if (isHeartbeatRuns) {
    return {
      where: vi.fn(() => ({
        for: vi.fn(() => ({
          then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve([{
              id: RUN_ID,
              companyId: "company-1",
              agentId: ASSIGNEE_AGENT_ID,
              responsibleUserId: null,
              contextSnapshot: { issueId: ISSUE_ID },
            }]).then(onFulfilled, onRejected),
        })),
        then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([]).then(onFulfilled, onRejected),
      })),
    };
  }
  return { where: mockDbSelectWhere };
}));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: { select: typeof mockDbSelect }) => Promise<unknown>) =>
    callback({ select: mockDbSelect })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async (id: string) => ({ id, companyId: "company-1", permissions: null })),
  resolveByReference: vi.fn(async () => ({ ambiguous: false, agent: null })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    ghPullRequestService: () => mockGhPullRequestService,
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({ getById: vi.fn(async () => null) }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => mockWorkProductService,
  }));
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      runId: RUN_ID,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as never, {} as never));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    projectId: null,
    status: "todo",
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-5971",
    title: "Build leaf",
    executionPolicy: null,
    executionState: null,
    monitorNextCheckAt: null,
    checkoutRunId: RUN_ID,
    executionRunId: RUN_ID,
    blockedByIssueIds: [],
    ...overrides,
  };
}

const AGENT_ACTOR = {
  type: "agent" as const,
  agentId: ASSIGNEE_AGENT_ID,
  companyId: "company-1",
  runId: RUN_ID,
};

describe("issue PATCH in_review precondition: open PR required for build-leaf", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockGhPullRequestService.findOpenByBranch.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
  });

  it("refuses in_review when a pushed branch has no open PR", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-1",
        companyId: issue.companyId,
        projectId: null,
        issueId: issue.id,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "branch",
        provider: "github",
        externalId: "feature/x",
        title: "feature/x",
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: { branchName: "feature/x", headSha: "abc123" },
        createdByRunId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockGhPullRequestService.findOpenByBranch.mockResolvedValue(null);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("open PR for branch feature/x not found");
    expect(res.body.error).toContain(
      'gh pr create --base main --head feature/x --title "Build leaf"',
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows in_review when an open PR exists on the branch head", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-1",
        companyId: issue.companyId,
        projectId: null,
        issueId: issue.id,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "branch",
        provider: "github",
        externalId: "feature/x",
        title: "feature/x",
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: { branchName: "feature/x", headSha: "abc123" },
        createdByRunId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockGhPullRequestService.findOpenByBranch.mockResolvedValue({
      headSha: "abc123",
      url: "https://github.com/Spark-Mojo/spark-mojo-platform/pull/42",
    });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      {
        id: "99999999-9999-4999-8999-999999999999",
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: ASSIGNEE_AGENT_ID,
        sourceRunId: RUN_ID,
      },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
      changes: {
        status: { from: issue.status, to: patch.status },
      },
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "in_review" }),
    );
    expect(mockGhPullRequestService.findOpenByBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "feature/x", expectedHeadSha: "abc123" }),
    );
  });

  it("preserves existing behavior when no branch work product is present", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    // Existing review-path guard would still refuse (no path); we only assert
    // that the new open-pr precondition does NOT additionally fail-closed
    // and that it does not query GitHub for PRs.
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(mockGhPullRequestService.findOpenByBranch).not.toHaveBeenCalled();
    // Existing assertAgentInReviewReviewPath 422 path is the contract here, not 409.
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
  });

  it("refuses in_review when the open PR exists but its head SHA does not match the pushed branch head", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-1",
        companyId: issue.companyId,
        projectId: null,
        issueId: issue.id,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "branch",
        provider: "github",
        externalId: "feature/x",
        title: "feature/x",
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: { branchName: "feature/x", headSha: "abc123" },
        createdByRunId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockGhPullRequestService.findOpenByBranch.mockResolvedValue(null);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("open PR for branch feature/x not found");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not run the open-pr precondition when the issue already is in_review", async () => {
    const issue = makeIssue({ status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "wp-1",
        companyId: issue.companyId,
        projectId: null,
        issueId: issue.id,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "branch",
        provider: "github",
        externalId: "feature/x",
        title: "feature/x",
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: { branchName: "feature/x", headSha: "abc123" },
        createdByRunId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeUserId: "local-board" });

    expect(mockGhPullRequestService.findOpenByBranch).not.toHaveBeenCalled();
    // No 409 from open-pr guard; whatever the route decides, it's not this precondition.
    expect(res.status).not.toBe(409);
  });

  it("does not run the open-pr precondition when the issue has no execution-policy stages and no build label", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    // No branch WP, no build label, no executionPolicy.stages — the card is
    // not a build-leaf, so the precondition short-circuits and the existing
    // review-path guard alone decides the transition.
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_review" });

    expect(mockGhPullRequestService.findOpenByBranch).not.toHaveBeenCalled();
    expect(res.status).not.toBe(409);
  });
});