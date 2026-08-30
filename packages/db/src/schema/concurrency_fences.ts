import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

// concurrency fencing -- ADR-0058/0059 Phase 2 R4.
//
// Three primitives extended onto the existing lease/attempt state machine
// without replacing it: deploy cap (1 concurrent on UAT), per-worktree
// builder fence (one live attempt per path+generation), and 60s sweep that
// frees a dead run's lease and bumps generation so the next attempt never
// reuses the dead identity.

export const deployLeases = pgTable(
  "deploy_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    environment: text("environment").notNull().default("uat"),
    status: text("status").notNull().default("active"),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    generation: integer("generation").notNull().default(1),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({} as Record<string, unknown>),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnvStatusIdx: index("deploy_leases_company_env_status_idx").on(
      table.companyId,
      table.environment,
      table.status,
    ),
    companyRunIdx: index("deploy_leases_company_run_idx").on(table.companyId, table.heartbeatRunId),
    companyIssueIdx: index("deploy_leases_company_issue_idx").on(table.companyId, table.issueId),
  }),
);

export const builderFences = pgTable(
  "builder_fences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    worktreePath: text("worktree_path").notNull(),
    generation: integer("generation").notNull(),
    status: text("status").notNull().default("active"),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({} as Record<string, unknown>),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPathGenStatusIdx: index("builder_fences_company_path_gen_status_idx").on(
      table.companyId,
      table.worktreePath,
      table.generation,
      table.status,
    ),
    companyPathStatusIdx: index("builder_fences_company_path_status_idx").on(
      table.companyId,
      table.worktreePath,
      table.status,
    ),
    companyRunIdx: index("builder_fences_company_run_idx").on(table.companyId, table.heartbeatRunId),
  }),
);

export type DeployLeaseRow = typeof deployLeases.$inferSelect;
export type DeployLeaseInsert = typeof deployLeases.$inferInsert;
export type BuilderFenceRow = typeof builderFences.$inferSelect;
export type BuilderFenceInsert = typeof builderFences.$inferInsert;
