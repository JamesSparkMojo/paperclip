import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

// build_receipts -- ADR-0058 Decision 5 Phase 2.
//
// Server-emitted BUILD-RECEIPT row. One row per (issue_id, attempt_id) where
// attempt_id is the run id that produced the receipt; the run id is itself the
// attempt identifier in the existing run lifecycle. generation lets future R2/R4
// emit follow-up receipts without losing the historical row.
//
// Trust boundary: this row is written by the server's run-finalize hook, not by
// the builder, so a builder cannot post a receipt that says "gates-met" against
// a tree it did not push. The detector reads through the read endpoint.
export const buildReceipts = pgTable(
  "build_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    heartbeatRunId: uuid("heartbeat_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id").references(
      () => executionWorkspaces.id,
      { onDelete: "set null" },
    ),
    // attemptId mirrors the heartbeat run id but is exposed as a separate
    // column for detector-side joins and to keep the contract with
    // ADR-0058 Decision 5 Phase 2 explicit (issueId, attemptId, runId).
    attemptId: text("attempt_id").notNull(),
    // Card human-readable id (e.g. SPA-5175) captured at emit time so the
    // detector's `card` field is populated without an extra lookup.
    card: text("card"),
    // Monotonic generation, starting at 1. Future phases (R2 reviewer-obedience,
    // R4 concurrency fencing) may rewrite this row; the generation lets the
    // detector tell "latest rewrite" from "first attempt".
    generation: integer("generation").notNull().default(1),
    // 40-hex SHA of the commit the workspace HEAD pointed to at emit time.
    treeSha: text("tree_sha").notNull(),
    branch: text("branch"),
    remoteVerified: text("remote_verified").notNull().default("unknown"),
    // { met, unmet, abandoned }: number. R1 seeds zeros for the unlazy-ledger
    // pieces and accepts that as "gates-met" iff the heartbeat run completed
    // without error. Future phases will populate from the real ledger.
    gates: jsonb("gates").$type<{ met: number; unmet: number; abandoned: number }>()
      .notNull()
      .default({ met: 0, unmet: 0, abandoned: 0 } as { met: number; unmet: number; abandoned: number }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    // "gates-met" or "handoff" (legacy names from Phase 1 self-posted comment).
    // R1 always emits "gates-met" because R1 only fires on success status.
    exit: text("exit").notNull().default("gates-met"),
    // Free-form structured metadata: which build skill (sm-build-paperclip,
    // ad-hoc), the executor's commit-context, etc. Read-only.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({} as Record<string, unknown>),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One row per (issue_id, attempt_id). attemptId is the heartbeat run id;
    // uniqueness lets a retry rebuild this row without a UNIQUE conflict if
    // the previous attempt's row was already deleted/cascaded.
    issueAttemptUnique: uniqueIndex("build_receipts_issue_attempt_unique").on(
      table.issueId,
      table.attemptId,
    ),
    companyIssueCreatedIdx: index("build_receipts_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt.desc(),
    ),
    companyRunIdx: index("build_receipts_company_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
  }),
);

export type BuildReceiptRow = typeof buildReceipts.$inferSelect;
export type BuildReceiptInsert = typeof buildReceipts.$inferInsert;
