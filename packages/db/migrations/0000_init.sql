CREATE TABLE `agent_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_versions_agent_version_unique` ON `agent_versions` (`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`limits` text DEFAULT '{}' NOT NULL,
	`sandbox_level` integer DEFAULT 1 NOT NULL,
	`working_dir` text,
	`enabled` integer DEFAULT true NOT NULL,
	`paused_reason` text,
	`current_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "agents_sandbox_level_check" CHECK("agents"."sandbox_level" in (1, 2, 3))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_agent_key_version_unique` ON `artifacts` (`agent_id`,`key`,`version`);--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`nonce` blob NOT NULL,
	`key_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_name_unique` ON `secrets` (`name`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config_ciphertext` blob NOT NULL,
	`config_nonce` blob NOT NULL,
	`key_version` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "channels_kind_check" CHECK("channels"."kind" in ('sms', 'email', 'slack', 'discord'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_name_unique` ON `channels` (`name`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`run_id` text,
	`idempotency_key` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`provider_message_ref` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "deliveries_status_check" CHECK("deliveries"."status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_idempotency_key_unique` ON `deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `deliveries_pending_idx` ON `deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `human_request_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`human_request_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`provider_message_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`human_request_id`) REFERENCES `human_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `human_request_deliveries_request_channel_unique` ON `human_request_deliveries` (`human_request_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `human_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`tool_call_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`options` text,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`answered_via` text,
	`answered_at` integer,
	`expires_at` integer NOT NULL,
	`default_on_timeout` text NOT NULL,
	`executed_at` integer,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "human_requests_kind_check" CHECK("human_requests"."kind" in ('info', 'question', 'approval', 'choice')),
	CONSTRAINT "human_requests_status_check" CHECK("human_requests"."status" in ('open', 'answered', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `human_requests_status_idx` ON `human_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `human_requests_run_idx` ON `human_requests` (`run_id`);--> statement-breakpoint
CREATE INDEX `human_requests_expires_idx` ON `human_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`file` text NOT NULL,
	`args` text DEFAULT '[]' NOT NULL,
	`parameters` text DEFAULT '{}' NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commands_name_unique` ON `commands` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`config` text NOT NULL,
	`sharing` text DEFAULT 'shared' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK("mcp_servers"."transport" in ('stdio', 'http')),
	CONSTRAINT "mcp_servers_sharing_check" CHECK("mcp_servers"."sharing" in ('shared', 'per-agent', 'per-run'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_slug_unique` ON `mcp_servers` (`slug`);--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`definition` text NOT NULL,
	`definition_hash` text NOT NULL,
	`approved_hash` text,
	`listed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tools_server_name_unique` ON `mcp_tools` (`server_id`,`name`);--> statement-breakpoint
CREATE TABLE `sandbox_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sandbox_templates_provider_check" CHECK("sandbox_templates"."provider" in ('srt', 'container'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_templates_name_unique` ON `sandbox_templates` (`name`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`location` text NOT NULL,
	`source_url` text,
	`content_hash` text NOT NULL,
	`scan_status` text DEFAULT 'pending' NOT NULL,
	`has_scripts` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "skills_scan_status_check" CHECK("skills"."scan_status" in ('pending', 'clean', 'flagged', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`turn` integer NOT NULL,
	`model` text NOT NULL,
	`served_model` text,
	`provider` text,
	`generation_id` text,
	`request_body` text,
	`response_body` text,
	`finish_reason` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `model_calls_run_idx` ON `model_calls` (`run_id`,`turn`);--> statement-breakpoint
CREATE INDEX `model_calls_started_idx` ON `model_calls` (`started_at`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`span_id` text,
	`parent_span_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq_unique` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version_id` text NOT NULL,
	`source` text NOT NULL,
	`trigger_id` text,
	`trigger_attempt_id` text,
	`input` text,
	`parent_run_id` text,
	`root_run_id` text,
	`forked_from_run_id` text,
	`forked_from_seq` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`stop_reason` text,
	`error` text,
	`turns` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`cancel_requested_at` integer,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`trigger_attempt_id`) REFERENCES `trigger_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`forked_from_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_source_check" CHECK("runs"."source" in ('api', 'webhook', 'cron', 'manual', 'spawn', 'fork')),
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "runs_stop_reason_check" CHECK("runs"."stop_reason" is null or "runs"."stop_reason" in ('success', 'max_turns', 'max_budget', 'timeout', 'cancelled', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_idempotency_key_unique` ON `runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `runs_status_queued_idx` ON `runs` (`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `runs_agent_status_idx` ON `runs` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `runs_root_idx` ON `runs` (`root_run_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`model_call_id` text,
	`call_id` text NOT NULL,
	`name` text NOT NULL,
	`args` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`result_path` text,
	`error` text,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_call_id`) REFERENCES `model_calls`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tool_calls_state_check" CHECK("tool_calls"."state" in ('pending', 'awaiting_approval', 'running', 'completed', 'error', 'interrupted', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `tool_calls_run_call_idx` ON `tool_calls` (`run_id`,`call_id`);--> statement-breakpoint
CREATE TABLE `agent_channels` (
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`recipients` text DEFAULT '[]' NOT NULL,
	`events` text DEFAULT '["result","failure"]' NOT NULL,
	PRIMARY KEY(`agent_id`, `channel_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_commands` (
	`agent_id` text NOT NULL,
	`command_id` text NOT NULL,
	`effect` text DEFAULT 'allow' NOT NULL,
	PRIMARY KEY(`agent_id`, `command_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `commands`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_commands_effect_check" CHECK("agent_commands"."effect" in ('allow', 'ask', 'deny'))
);
--> statement-breakpoint
CREATE TABLE `agent_mcp_tools` (
	`agent_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`effect` text NOT NULL,
	PRIMARY KEY(`agent_id`, `tool_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_id`) REFERENCES `mcp_tools`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_mcp_tools_effect_check" CHECK("agent_mcp_tools"."effect" in ('allow', 'ask', 'deny'))
);
--> statement-breakpoint
CREATE TABLE `agent_skills` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_spawnable_agents` (
	`agent_id` text NOT NULL,
	`child_agent_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `child_agent_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- IF NOT EXISTS: databases from M1 already have this table from the old bootstrap SQL.
CREATE TABLE IF NOT EXISTS `process_heartbeats` (
	`process` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`started_at` integer NOT NULL,
	`beat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`agent_id` text,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`missed_run_policy` text DEFAULT 'skip' NOT NULL,
	`overlap_policy` text DEFAULT 'skip' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedules_missed_run_policy_check" CHECK("schedules"."missed_run_policy" in ('skip', 'run_once')),
	CONSTRAINT "schedules_overlap_policy_check" CHECK("schedules"."overlap_policy" in ('skip', 'queue'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_trigger_unique` ON `schedules` (`trigger_id`);--> statement-breakpoint
CREATE INDEX `schedules_next_run_idx` ON `schedules` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `trigger_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text,
	`agent_id` text NOT NULL,
	`webhook_delivery_id` text,
	`scheduled_for` integer,
	`outcome` text NOT NULL,
	`reason` text,
	`detail` text,
	`run_id` text,
	`fired_at` integer NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`webhook_delivery_id`) REFERENCES `webhook_deliveries`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "trigger_attempts_outcome_check" CHECK("trigger_attempts"."outcome" in ('started', 'skipped', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `trigger_attempts_trigger_idx` ON `trigger_attempts` (`trigger_id`,`fired_at`);--> statement-breakpoint
CREATE INDEX `trigger_attempts_agent_idx` ON `trigger_attempts` (`agent_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`path_token` text,
	`auth_mode` text,
	`auth_config` text,
	`filter` text,
	`prompt_template` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "triggers_kind_check" CHECK("triggers"."kind" in ('api', 'webhook', 'cron')),
	CONSTRAINT "triggers_auth_mode_check" CHECK("triggers"."auth_mode" is null or "triggers"."auth_mode" in ('none', 'header', 'hmac', 'standard_webhooks'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_path_token_unique` ON `triggers` (`path_token`);--> statement-breakpoint
CREATE INDEX `triggers_agent_idx` ON `triggers` (`agent_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`dedup_key` text NOT NULL,
	`headers` text NOT NULL,
	`body` text NOT NULL,
	`signature_valid` integer,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_trigger_dedup_unique` ON `webhook_deliveries` (`trigger_id`,`dedup_key`);