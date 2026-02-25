-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 003: Append-Only Status Change Audit Log
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. The log table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS status_change_log (
    id               SERIAL PRIMARY KEY,
    leave_request_id INTEGER NOT NULL REFERENCES leave_requests(id),
    changed_by_id    INTEGER NOT NULL,  -- 0 = system/scheduler
    old_status       VARCHAR(30) NOT NULL,
    new_status       VARCHAR(30) NOT NULL,
    reason           TEXT,
    changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_status_log_leave ON status_change_log(leave_request_id);
CREATE INDEX idx_status_log_changed_at ON status_change_log(changed_at);

-- ─── 2. Trigger function: auto-log every status change ──────────────────────
--    Reads app.current_user_id from the session (set by the app before UPDATEs).
--    Falls back to 0 (system) if not set.

CREATE OR REPLACE FUNCTION log_status_change()
RETURNS TRIGGER AS $$
DECLARE
    actor_id INTEGER;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        -- Try to read the actor from session variable; default to 0 (system)
        BEGIN
            actor_id := current_setting('app.current_user_id', true)::INTEGER;
        EXCEPTION WHEN OTHERS THEN
            actor_id := 0;
        END;

        IF actor_id IS NULL THEN
            actor_id := 0;
        END IF;

        INSERT INTO status_change_log
            (leave_request_id, changed_by_id, old_status, new_status, reason)
        VALUES
            (OLD.id, actor_id, OLD.status, NEW.status, NEW.rejection_reason);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leave_status_change
    AFTER UPDATE ON leave_requests
    FOR EACH ROW
    EXECUTE FUNCTION log_status_change();

-- ─── 3. Also log the initial INSERT (creation) ─────────────────────────────

CREATE OR REPLACE FUNCTION log_status_on_insert()
RETURNS TRIGGER AS $$
DECLARE
    actor_id INTEGER;
BEGIN
    BEGIN
        actor_id := current_setting('app.current_user_id', true)::INTEGER;
    EXCEPTION WHEN OTHERS THEN
        actor_id := 0;
    END;

    IF actor_id IS NULL THEN
        actor_id := NEW.employee_id;  -- on creation, the actor is the employee
    END IF;

    INSERT INTO status_change_log
        (leave_request_id, changed_by_id, old_status, new_status, reason)
    VALUES
        (NEW.id, actor_id, '(created)', NEW.status, NULL);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leave_status_insert
    AFTER INSERT ON leave_requests
    FOR EACH ROW
    EXECUTE FUNCTION log_status_on_insert();

-- ─── 4. Append-only protection: block UPDATE and DELETE on the log ───────────

CREATE OR REPLACE FUNCTION prevent_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'status_change_log is append-only. Updates and deletes are forbidden.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_no_mutate_status_log
    BEFORE UPDATE OR DELETE ON status_change_log
    FOR EACH ROW
    EXECUTE FUNCTION prevent_log_mutation();
