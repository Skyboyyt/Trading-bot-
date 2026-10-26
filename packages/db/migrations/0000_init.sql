CREATE TABLE "api_idempotency" (
	"key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_key_route_uq" UNIQUE("key","route")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"details" jsonb NOT NULL,
	"ip" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"pool_address" text NOT NULL,
	"mint" text NOT NULL,
	"provider" text NOT NULL,
	"interval" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"open" numeric(60, 30) NOT NULL,
	"high" numeric(60, 30) NOT NULL,
	"low" numeric(60, 30) NOT NULL,
	"close" numeric(60, 30) NOT NULL,
	"volume_usd" numeric(60, 30),
	"price_currency" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"parser_version" text NOT NULL,
	"raw_payload_id" uuid,
	"revision_count" integer DEFAULT 0 NOT NULL,
	"dataset_tag" text DEFAULT 'real' NOT NULL,
	CONSTRAINT "candles_series_open_uq" UNIQUE("network","pool_address","provider","interval","open_time"),
	CONSTRAINT "candles_interval_chk" CHECK ("candles"."interval" in ('1m')),
	CONSTRAINT "candles_dataset_tag_chk" CHECK ("candles"."dataset_tag" in ('real', 'synthetic')),
	CONSTRAINT "candles_ohlc_chk" CHECK ("candles"."high" >= "candles"."low" and "candles"."low" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"mint" text NOT NULL,
	"side" text NOT NULL,
	"token_qty_raw" numeric(78, 0) NOT NULL,
	"quote_amount_raw" numeric(78, 0) NOT NULL,
	"platform_fee_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"platform_fee_mint" text,
	"network_fee_lamports" numeric(78, 0) DEFAULT '0' NOT NULL,
	"network_fee_quote_estimate_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"price" numeric(60, 30) NOT NULL,
	"realized_pnl_raw" numeric(78, 0),
	"cost_basis_removed_raw" numeric(78, 0),
	"is_simulated" boolean NOT NULL,
	"fill_model_version" text,
	"approximate" boolean DEFAULT false NOT NULL,
	"notes" text,
	"filled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fills_id_portfolio_mode_uq" UNIQUE("id","portfolio_id","mode"),
	CONSTRAINT "fills_attempt_uq" UNIQUE("attempt_id"),
	CONSTRAINT "fills_mode_chk" CHECK ("fills"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "fills_sim_mode_chk" CHECK (("fills"."mode" = 'PAPER') = "fills"."is_simulated")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_chk" CHECK ("jobs"."status" in ('QUEUED', 'LEASED', 'DONE', 'DEAD'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"account" text NOT NULL,
	"asset" text NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"entry_type" text NOT NULL,
	"order_id" uuid,
	"fill_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_mode_chk" CHECK ("ledger_entries"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "ledger_amount_nonzero_chk" CHECK ("ledger_entries"."amount_raw" <> 0),
	CONSTRAINT "ledger_entry_type_chk" CHECK ("ledger_entries"."entry_type" in ('DEPOSIT','WITHDRAWAL','ACQUISITION','DISPOSAL','FEE_NETWORK','FEE_PLATFORM','TRANSFER','ADJUSTMENT'))
);
--> statement-breakpoint
CREATE TABLE "market_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"mint" text NOT NULL,
	"pool_address" text,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source_slot" bigint,
	"parser_version" text NOT NULL,
	"raw_payload_id" uuid,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_observations_kind_chk" CHECK ("market_observations"."kind" in ('POOL_SNAPSHOT', 'MINT_ACCOUNT', 'LARGEST_ACCOUNTS', 'HOLDER_OWNERS', 'QUOTE', 'CANDLE_REVISION'))
);
--> statement-breakpoint
CREATE TABLE "operator_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"command" text NOT NULL,
	"status" text DEFAULT 'ACCEPTED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "operator_commands_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "operator_commands_mode_chk" CHECK ("operator_commands"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "operator_commands_command_chk" CHECK ("operator_commands"."command" in ('PAUSE_ENTRIES', 'PAUSE_ALL', 'LIQUIDATE', 'RESUME', 'DISABLE_LIVE')),
	CONSTRAINT "operator_commands_status_chk" CHECK ("operator_commands"."status" in ('ACCEPTED', 'APPLIED', 'COMPLETED', 'PARTIAL', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "order_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"tx_digest" text,
	"expected_signature" text,
	"status" text NOT NULL,
	"quote" jsonb,
	"last_valid_block_height" text,
	"quote_received_at" timestamp with time zone,
	"prepared_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"simulation" jsonb,
	CONSTRAINT "order_attempts_order_no_uq" UNIQUE("order_id","attempt_no"),
	CONSTRAINT "order_attempts_status_chk" CHECK ("order_attempts"."status" in ('PREPARED','SUBMITTING','SUBMITTED','UNKNOWN','CONFIRMED','FINALIZED','FAILED','EXPIRED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "order_state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"from_version" integer,
	"to_version" integer NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"signal_id" uuid,
	"strategy_version_id" uuid,
	"token_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"side" text NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"notional_raw" numeric(78, 0),
	"quantity_raw" numeric(78, 0),
	"reserved_quote_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"reserved_fee_lamports" numeric(78, 0) DEFAULT '0' NOT NULL,
	"max_slippage_bps" integer NOT NULL,
	"max_price_impact_bps" integer NOT NULL,
	"max_network_fee_lamports" numeric(78, 0) NOT NULL,
	"reason" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_id_portfolio_mode_uq" UNIQUE("id","portfolio_id","mode"),
	CONSTRAINT "orders_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_mode_chk" CHECK ("orders"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "orders_side_chk" CHECK ("orders"."side" in ('BUY', 'SELL')),
	CONSTRAINT "orders_purpose_chk" CHECK ("orders"."purpose" in ('ENTRY', 'EXIT', 'LIQUIDATION')),
	CONSTRAINT "orders_state_chk" CHECK ("orders"."state" in ('PROPOSED','REJECTED','RESERVED','PREPARED','SUBMITTED','UNKNOWN','CONFIRMED','FINALIZED','RECONCILED','FAILED','CANCELLED','MANUAL_REVIEW')),
	CONSTRAINT "orders_amount_chk" CHECK (("orders"."side" = 'BUY' and "orders"."notional_raw" > 0) or ("orders"."side" = 'SELL' and "orders"."quantity_raw" > 0))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "parameter_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"split" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parameter_trials_split_chk" CHECK ("parameter_trials"."split" in ('train', 'validation', 'test'))
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"pool_address" text NOT NULL,
	"token_id" uuid NOT NULL,
	"base_mint" text NOT NULL,
	"quote_mint" text NOT NULL,
	"dex" text,
	"pool_created_at" timestamp with time zone,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pools_network_address_uq" UNIQUE("network","pool_address")
);
--> statement-breakpoint
CREATE TABLE "portfolio_balances" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"cash_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"reserved_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"sol_lamports" numeric(78, 0) DEFAULT '0' NOT NULL,
	"sol_reserved_lamports" numeric(78, 0) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_balances_mode_chk" CHECK ("portfolio_balances"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "portfolio_balances_nonneg_chk" CHECK ("portfolio_balances"."reserved_raw" >= 0 and "portfolio_balances"."sol_reserved_lamports" >= 0)
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"cash_raw" numeric(78, 0) NOT NULL,
	"reserved_raw" numeric(78, 0) NOT NULL,
	"positions_mark_raw" numeric(78, 0) NOT NULL,
	"equity_raw" numeric(78, 0) NOT NULL,
	"deposits_raw" numeric(78, 0) NOT NULL,
	"realized_pnl_raw" numeric(78, 0) NOT NULL,
	"unrealized_pnl_raw" numeric(78, 0) NOT NULL,
	"platform_fees_raw" numeric(78, 0) NOT NULL,
	"network_fees_lamports" numeric(78, 0) NOT NULL,
	"network_fees_quote_estimate_raw" numeric(78, 0) NOT NULL,
	"infra_costs_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"exposure_raw" numeric(78, 0) NOT NULL,
	"peak_equity_raw" numeric(78, 0) NOT NULL,
	"drawdown_bps" integer NOT NULL,
	"open_positions" integer NOT NULL,
	"stranded_positions" integer NOT NULL,
	"mark_quality" text NOT NULL,
	CONSTRAINT "portfolio_snapshots_mode_chk" CHECK ("portfolio_snapshots"."mode" in ('PAPER', 'LIVE'))
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"base_mint" text NOT NULL,
	"entries_paused" boolean DEFAULT false NOT NULL,
	"submissions_paused" boolean DEFAULT false NOT NULL,
	"live_disabled" boolean DEFAULT true NOT NULL,
	"liquidation_requested_at" timestamp with time zone,
	"pause_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolios_id_mode_uq" UNIQUE("id","mode"),
	CONSTRAINT "portfolios_name_uq" UNIQUE("name"),
	CONSTRAINT "portfolios_mode_chk" CHECK ("portfolios"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "portfolios_status_chk" CHECK ("portfolios"."status" in ('ACTIVE', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"token_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"status" text NOT NULL,
	"quantity_raw" numeric(78, 0) NOT NULL,
	"cost_basis_raw" numeric(78, 0) NOT NULL,
	"realized_pnl_raw" numeric(78, 0) DEFAULT '0' NOT NULL,
	"entry_order_id" uuid,
	"strategy_version_id" uuid,
	"entry_reason" text,
	"exit_reason" text,
	"mark_value_raw" numeric(78, 0),
	"mark_source" text,
	"mark_at" timestamp with time zone,
	"peak_mark_value_raw" numeric(78, 0),
	"stranded_since" timestamp with time zone,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_mode_chk" CHECK ("positions"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "positions_status_chk" CHECK ("positions"."status" in ('OPEN', 'CLOSING', 'STRANDED', 'CLOSED')),
	CONSTRAINT "positions_qty_chk" CHECK ("positions"."quantity_raw" >= 0 and "positions"."cost_basis_raw" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"provider" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"circuit_state" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"requests_total" bigint DEFAULT 0 NOT NULL,
	"rate_limited_total" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"byte_size" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "raw_payloads_sha256_uq" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"strategy_version_id" uuid,
	"portfolio_id" uuid,
	"dataset_version" text,
	"dataset_tag" text NOT NULL,
	"request" jsonb NOT NULL,
	"results" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "reports_kind_chk" CHECK ("reports"."kind" in ('REPLAY', 'PAPER_RUN')),
	CONSTRAINT "reports_status_chk" CHECK ("reports"."status" in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "reports_dataset_tag_chk" CHECK ("reports"."dataset_tag" in ('real', 'synthetic'))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"quote_raw" numeric(78, 0) NOT NULL,
	"fee_lamports" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "reservations_order_uq" UNIQUE("order_id"),
	CONSTRAINT "reservations_mode_chk" CHECK ("reservations"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "reservations_status_chk" CHECK ("reservations"."status" in ('ACTIVE', 'RELEASED', 'CONSUMED'))
);
--> statement-breakpoint
CREATE TABLE "risk_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid,
	"order_id" uuid,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"policy_id" uuid,
	"decision" text NOT NULL,
	"checks" jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "risk_decisions_mode_chk" CHECK ("risk_decisions"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "risk_decisions_decision_chk" CHECK ("risk_decisions"."decision" in ('APPROVED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "risk_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"params" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_policies_portfolio_version_uq" UNIQUE("portfolio_id","version"),
	CONSTRAINT "risk_policies_mode_chk" CHECK ("risk_policies"."mode" in ('PAPER', 'LIVE'))
);
--> statement-breakpoint
CREATE TABLE "screening_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"network" text NOT NULL,
	"mint" text NOT NULL,
	"verdict" text NOT NULL,
	"checks" jsonb NOT NULL,
	"intended_size_raw" numeric(78, 0) NOT NULL,
	"screener_version" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "screening_verdict_chk" CHECK ("screening_assessments"."verdict" in ('PASS', 'REJECT', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"service" text NOT NULL,
	"instance" text NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "service_heartbeats_uq" UNIQUE("service","instance")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"side" text NOT NULL,
	"signal_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"status_reason" text,
	"idempotency_key" text NOT NULL,
	"dataset_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_id_portfolio_mode_uq" UNIQUE("id","portfolio_id","mode"),
	CONSTRAINT "signals_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "signals_mode_chk" CHECK ("signals"."mode" in ('PAPER', 'LIVE')),
	CONSTRAINT "signals_side_chk" CHECK ("signals"."side" in ('BUY', 'SELL')),
	CONSTRAINT "signals_status_chk" CHECK ("signals"."status" in ('NEW', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'EXECUTED'))
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_versions_name_hash_uq" UNIQUE("name","version","params_hash")
);
--> statement-breakpoint
CREATE TABLE "system_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb NOT NULL,
	"portfolio_id" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"dedupe_key" text,
	CONSTRAINT "system_incidents_severity_chk" CHECK ("system_incidents"."severity" in ('INFO', 'WARNING', 'CRITICAL'))
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text,
	"name" text,
	"decimals" integer,
	"token_program" text,
	"allowlisted" boolean DEFAULT false NOT NULL,
	"allowlist_note" text,
	"preferred_pool_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_network_mint_uq" UNIQUE("network","mint")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"public_key" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_public_key_mode_uq" UNIQUE("public_key","mode"),
	CONSTRAINT "wallets_mode_chk" CHECK ("wallets"."mode" in ('PAPER', 'LIVE'))
);
--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_attempt_id_order_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."order_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_same_portfolio_fk" FOREIGN KEY ("order_id","portfolio_id","mode") REFERENCES "public"."orders"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_order_same_portfolio_fk" FOREIGN KEY ("order_id","portfolio_id","mode") REFERENCES "public"."orders"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_fill_same_portfolio_fk" FOREIGN KEY ("fill_id","portfolio_id","mode") REFERENCES "public"."fills"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_observations" ADD CONSTRAINT "market_observations_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_commands" ADD CONSTRAINT "operator_commands_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attempts" ADD CONSTRAINT "order_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_state_transitions" ADD CONSTRAINT "order_state_transitions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_same_portfolio_fk" FOREIGN KEY ("signal_id","portfolio_id","mode") REFERENCES "public"."signals"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_trials" ADD CONSTRAINT "parameter_trials_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameter_trials" ADD CONSTRAINT "parameter_trials_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_balances" ADD CONSTRAINT "portfolio_balances_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_entry_order_same_portfolio_fk" FOREIGN KEY ("entry_order_id","portfolio_id","mode") REFERENCES "public"."orders"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_order_same_portfolio_fk" FOREIGN KEY ("order_id","portfolio_id","mode") REFERENCES "public"."orders"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_policy_id_risk_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."risk_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_signal_same_portfolio_fk" FOREIGN KEY ("signal_id","portfolio_id","mode") REFERENCES "public"."signals"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_order_same_portfolio_fk" FOREIGN KEY ("order_id","portfolio_id","mode") REFERENCES "public"."orders"("id","portfolio_id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_policies" ADD CONSTRAINT "risk_policies_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_assessments" ADD CONSTRAINT "screening_assessments_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_portfolio_id_mode_portfolios_id_mode_fk" FOREIGN KEY ("portfolio_id","mode") REFERENCES "public"."portfolios"("id","mode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "candles_mint_open_idx" ON "candles" USING btree ("mint","open_time");--> statement-breakpoint
CREATE INDEX "fills_portfolio_filled_idx" ON "fills" USING btree ("portfolio_id","filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."status" in ('QUEUED', 'LEASED');--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "ledger_portfolio_account_idx" ON "ledger_entries" USING btree ("portfolio_id","account","asset");--> statement-breakpoint
CREATE INDEX "ledger_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "market_observations_mint_kind_received_idx" ON "market_observations" USING btree ("mint","kind","received_at");--> statement-breakpoint
CREATE INDEX "order_transitions_order_idx" ON "order_state_transitions" USING btree ("order_id","to_version");--> statement-breakpoint
CREATE INDEX "orders_portfolio_state_idx" ON "orders" USING btree ("portfolio_id","state");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "portfolio_snapshots_portfolio_at_idx" ON "portfolio_snapshots" USING btree ("portfolio_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_one_active_per_token_uq" ON "positions" USING btree ("portfolio_id","mint") WHERE "positions"."status" in ('OPEN', 'CLOSING', 'STRANDED');--> statement-breakpoint
CREATE INDEX "risk_decisions_portfolio_decided_idx" ON "risk_decisions" USING btree ("portfolio_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_policies_one_active_uq" ON "risk_policies" USING btree ("portfolio_id") WHERE "risk_policies"."active";--> statement-breakpoint
CREATE INDEX "screening_mint_assessed_idx" ON "screening_assessments" USING btree ("mint","assessed_at");--> statement-breakpoint
CREATE INDEX "signals_portfolio_created_idx" ON "signals" USING btree ("portfolio_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "system_incidents_open_dedupe_uq" ON "system_incidents" USING btree ("dedupe_key") WHERE "system_incidents"."dedupe_key" is not null and "system_incidents"."resolved_at" is null;