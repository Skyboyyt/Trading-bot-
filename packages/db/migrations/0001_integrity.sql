-- Hand-written integrity rules that Drizzle cannot express. Reviewed: see docs/migrations.md.

-- 1. Append-only tables -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tb_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER order_state_transitions_append_only BEFORE UPDATE OR DELETE ON order_state_transitions
  FOR EACH ROW EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER fills_append_only BEFORE UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint

-- 2. Ledger: allowed accounts, and every journal balances per asset at commit ------------------
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_account_chk CHECK (
  account IN ('cash', 'holdings', 'trading', 'fees:platform', 'fees:network', 'equity:deposits', 'equity:withdrawals', 'adjustments')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tb_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unbalanced record;
  owners integer;
BEGIN
  SELECT count(DISTINCT (portfolio_id, mode)) INTO owners FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF owners <> 1 THEN
    RAISE EXCEPTION 'journal % spans % portfolios/modes', NEW.journal_id, owners USING ERRCODE = 'check_violation';
  END IF;
  SELECT asset, sum(amount_raw) AS total INTO unbalanced
  FROM ledger_entries WHERE journal_id = NEW.journal_id
  GROUP BY asset HAVING sum(amount_raw) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % is unbalanced for asset % (net %)', NEW.journal_id, unbalanced.asset, unbalanced.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journal_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tb_check_journal_balanced();
--> statement-breakpoint

-- 3. Order state machine enforced in the database as well as in code --------------------------
CREATE OR REPLACE FUNCTION tb_guard_order_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode OR NEW.portfolio_id IS DISTINCT FROM OLD.portfolio_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.side IS DISTINCT FROM OLD.side
     OR NEW.mint IS DISTINCT FROM OLD.mint THEN
    RAISE EXCEPTION 'order % identity columns are immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state, NEW.state) IN (
      ('PROPOSED', 'REJECTED'), ('PROPOSED', 'RESERVED'), ('PROPOSED', 'CANCELLED'),
      ('RESERVED', 'PREPARED'), ('RESERVED', 'CANCELLED'), ('RESERVED', 'FAILED'),
      ('PREPARED', 'SUBMITTED'), ('PREPARED', 'CANCELLED'), ('PREPARED', 'FAILED'),
      ('SUBMITTED', 'CONFIRMED'), ('SUBMITTED', 'FAILED'), ('SUBMITTED', 'UNKNOWN'),
      ('UNKNOWN', 'CONFIRMED'), ('UNKNOWN', 'FAILED'), ('UNKNOWN', 'MANUAL_REVIEW'),
      ('CONFIRMED', 'FINALIZED'), ('CONFIRMED', 'UNKNOWN'),
      ('FINALIZED', 'RECONCILED'), ('FINALIZED', 'MANUAL_REVIEW'),
      ('MANUAL_REVIEW', 'RECONCILED'), ('MANUAL_REVIEW', 'FAILED'), ('MANUAL_REVIEW', 'CANCELLED')
    )) THEN
      RAISE EXCEPTION 'illegal order transition % -> % for %', OLD.state, NEW.state, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'order % state change must bump version by one', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION tb_guard_order_update();
--> statement-breakpoint
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION tb_forbid_mutation();
--> statement-breakpoint

-- 4. A portfolio's mode can never change -------------------------------------------------------
CREATE OR REPLACE FUNCTION tb_guard_portfolio_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'portfolio % mode is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER portfolios_guard_mode BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION tb_guard_portfolio_mode();
--> statement-breakpoint

-- 5. Balance cache can never go negative; reserved never exceeds available ---------------------
ALTER TABLE portfolio_balances ADD CONSTRAINT portfolio_balances_cover_chk CHECK (
  cash_raw >= reserved_raw AND sol_lamports >= sol_reserved_lamports AND cash_raw >= 0 AND sol_lamports >= 0
);
