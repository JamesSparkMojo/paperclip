CREATE TABLE "build_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "heartbeat_run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE,
  "execution_workspace_id" uuid REFERENCES "execution_workspaces"("id") ON DELETE SET NULL,
  "attempt_id" text NOT NULL,
  "card" text,
  "generation" integer NOT NULL DEFAULT 1,
  "tree_sha" text NOT NULL,
  "branch" text,
  "remote_verified" text NOT NULL DEFAULT 'unknown',
  "gates" jsonb NOT NULL DEFAULT '{"met":0,"unmet":0,"abandoned":0}'::jsonb,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz NOT NULL,
  "exit" text NOT NULL DEFAULT 'gates-met',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "build_receipts_issue_attempt_unique" ON "build_receipts" USING btree ("issue_id","attempt_id");--> statement-breakpoint
CREATE INDEX "build_receipts_company_issue_created_idx" ON "build_receipts" USING btree ("company_id","issue_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "build_receipts_company_run_idx" ON "build_receipts" USING btree ("company_id","heartbeat_run_id");
