-- ============================================================================
-- Migration 002: Approval Delegation Chain
--
-- Adds support for automatic approval delegation when a manager is on leave
-- or hasn't responded within 48 hours. Tracks the current delegated approver
-- and maintains a full audit trail of every escalation hop.
-- ============================================================================

-- ─── New columns on leave_requests ──────────────────────────────────────────

-- Who currently holds the manager-side approval responsibility
-- (initially the direct manager, changes on delegation)
ALTER TABLE leave_requests
  ADD COLUMN current_manager_approver_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;

-- How many times this request has been escalated (loop cap)
ALTER TABLE leave_requests
  ADD COLUMN escalation_count INTEGER DEFAULT 0;

-- When the current approver was assigned (for 48hr timeout tracking)
ALTER TABLE leave_requests
  ADD COLUMN current_approver_assigned_at TIMESTAMPTZ DEFAULT NOW();

-- ─── Delegation audit log ───────────────────────────────────────────────────

CREATE TABLE delegation_log (
  id SERIAL PRIMARY KEY,
  leave_request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  from_approver_id INTEGER NOT NULL REFERENCES employees(id),
  to_approver_id INTEGER NOT NULL REFERENCES employees(id),
  reason VARCHAR(50) NOT NULL CHECK (reason IN ('on_leave', 'timeout_48h', 'also_unavailable')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_delegation_log_request ON delegation_log(leave_request_id);

-- ─── Expand approval_actions to include 'delegated' action ──────────────────

ALTER TABLE approval_actions
  DROP CONSTRAINT IF EXISTS approval_actions_action_check;

ALTER TABLE approval_actions
  ADD CONSTRAINT approval_actions_action_check
  CHECK (action IN ('approved', 'rejected', 'overridden', 'delegated'));

-- ─── Backfill existing pending requests with current_manager_approver_id ────

UPDATE leave_requests lr
SET current_manager_approver_id = e.reporting_manager_id,
    current_approver_assigned_at = lr.created_at
FROM employees e
WHERE lr.employee_id = e.id
  AND lr.manager_approval = 'pending'
  AND lr.status IN ('pending', 'partially_approved');
