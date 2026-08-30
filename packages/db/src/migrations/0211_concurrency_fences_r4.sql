CREATE TABLE "deploy_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "environment" text NOT NULL DEFAULT 'uat',
  "status" text NOT NULL DEFAULT 'active',
  "heartbeat_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "acquired_at" timestamptz NOT NULL DEFAULT now(),
  "last_heartbeat_at" timestamptz NOT NULL DEFAULT now(),
  "released_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "deploy_leases_company_env_status_idx" ON "deploy_leases" USING btree ("company_id","environment","status");--> statement-breakpoint
CREATE INDEX "deploy_leases_company_run_idx" ON "deploy_leases" USING btree ("company_id","heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "deploy_leases_company_issue_idx" ON "deploy_leases" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_leases_active_env_unique" ON "deploy_leases" USING btree ("company_id","environment") WHERE status = 'active';--> statement-breakpoint
CREATE TABLE "builder_fences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "worktree_path" text NOT NULL,
  "generation" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "heartbeat_run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "acquired_at" timestamptz NOT NULL DEFAULT now(),
  "last_heartbeat_at" timestamptz NOT NULL DEFAULT now(),
  "released_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "builder_fences_company_path_gen_status_idx" ON "builder_fences" USING btree ("company_id","worktree_path","generation","status");--> statement-breakpoint
CREATE INDEX "builder_fences_company_path_status_idx" ON "builder_fences" USING btree ("company_id","worktree_path","status");--> statement-breakpoint
CREATE INDEX "builder_fences_company_run_idx" ON "builder_fences" USING btree ("company_id","heartbeat_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_fences_active_path_gen_unique_partial" ON "builder_fences" USING btree ("company_id","worktree_path","generation") WHERE status = 'active';
