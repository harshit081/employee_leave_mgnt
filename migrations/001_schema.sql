-- ============================================================================
-- Smart Leave Approval System — Schema
-- ============================================================================

-- Drop tables in reverse dependency order (idempotent)
DROP TABLE IF EXISTS team_availability CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS approval_actions CASCADE;
DROP TABLE IF EXISTS leave_requests CASCADE;
DROP TABLE IF EXISTS leave_balances CASCADE;
DROP TABLE IF EXISTS blackout_periods CASCADE;
DROP TABLE IF EXISTS employees CASCADE;

-- ─── Employees ───────────────────────────────────────────────────────────────
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('employee', 'manager', 'hr')),
  department VARCHAR(50) NOT NULL,
  reporting_manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_employees_department ON employees(department);
CREATE INDEX idx_employees_manager ON employees(reporting_manager_id);

-- ─── Leave Balances ──────────────────────────────────────────────────────────
CREATE TABLE leave_balances (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type VARCHAR(20) NOT NULL CHECK (leave_type IN ('sick', 'casual', 'earned')),
  year INTEGER NOT NULL,
  total_days INTEGER NOT NULL,
  used_days INTEGER NOT NULL DEFAULT 0,
  UNIQUE(employee_id, leave_type, year)
);

CREATE INDEX idx_leave_balances_employee ON leave_balances(employee_id);

-- ─── Leave Requests ──────────────────────────────────────────────────────────
CREATE TABLE leave_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type VARCHAR(20) NOT NULL CHECK (leave_type IN ('sick', 'casual', 'earned')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'pending_document', 'partially_approved', 'approved', 'rejected', 'cancelled')),

  -- Document tracking (Rule 4)
  medical_document_url TEXT,
  document_reminder_count INTEGER DEFAULT 0,
  document_deadline TIMESTAMPTZ,

  -- Dual approval tracking (Rule 2)
  requires_dual_approval BOOLEAN DEFAULT FALSE,
  manager_approval VARCHAR(20) DEFAULT 'pending'
    CHECK (manager_approval IN ('pending', 'approved', 'rejected')),
  hr_approval VARCHAR(20) DEFAULT 'pending'
    CHECK (hr_approval IN ('pending', 'approved', 'rejected', 'not_required')),

  -- Warnings (Rules 3, 6)
  team_capacity_warning BOOLEAN DEFAULT FALSE,
  blackout_warning BOOLEAN DEFAULT FALSE,
  blackout_override BOOLEAN DEFAULT FALSE,

  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_date_range CHECK (end_date >= start_date)
);

CREATE INDEX idx_leave_requests_employee ON leave_requests(employee_id);
CREATE INDEX idx_leave_requests_status ON leave_requests(status);
CREATE INDEX idx_leave_requests_dates ON leave_requests(start_date, end_date);

-- ─── Approval Actions (audit trail) ─────────────────────────────────────────
CREATE TABLE approval_actions (
  id SERIAL PRIMARY KEY,
  leave_request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  approver_id INTEGER NOT NULL REFERENCES employees(id),
  action VARCHAR(20) NOT NULL CHECK (action IN ('approved', 'rejected', 'overridden')),
  role_type VARCHAR(20) NOT NULL CHECK (role_type IN ('manager', 'hr')),
  comments TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_approval_actions_request ON approval_actions(leave_request_id);

-- ─── Blackout Periods ────────────────────────────────────────────────────────
CREATE TABLE blackout_periods (
  id SERIAL PRIMARY KEY,
  department VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_blackout_range CHECK (end_date >= start_date)
);

CREATE INDEX idx_blackout_department ON blackout_periods(department);

-- ─── Notifications ───────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  related_leave_request_id INTEGER REFERENCES leave_requests(id) ON DELETE SET NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_employee ON notifications(employee_id);

-- ─── Team Availability (for Rule 3 capacity check) ──────────────────────────
CREATE TABLE team_availability (
  id SERIAL PRIMARY KEY,
  department VARCHAR(50) NOT NULL,
  date DATE NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  UNIQUE(department, date, employee_id)
);

CREATE INDEX idx_team_availability_dept_date ON team_availability(department, date);
