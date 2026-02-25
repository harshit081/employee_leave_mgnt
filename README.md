# Smart Leave Approval System

A backend API for managing employee leave requests with complex approval workflows, built with Node.js, Express, TypeScript, and raw PostgreSQL.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up your .env (copy and adjust)
cp .env.example .env

# 3. Create the database
psql -U postgres -c "CREATE DATABASE leave_management;"

# 4. Run migrations and seed data
npm run migrate
npm run seed

# 5. Start the dev server
npm run dev
```

The API runs at `http://localhost:3000`.

---

## Database Schema

| Table | Purpose |
|---|---|
| `employees` | Name, email, role (employee/manager/hr), department, reporting manager |
| `leave_balances` | Per-employee per-year totals: 12 casual, 8 sick, 15 earned |
| `leave_requests` | Leave applications with dual-approval tracking, delegation chain, warnings, status |
| `approval_actions` | Audit trail of every approve/reject/delegate action |
| `blackout_periods` | Department-specific restricted periods |
| `notifications` | All system notifications (approval, rejection, delegation, reminders, etc.) |
| `team_availability` | Per-date per-department records of who is on leave |
| `delegation_log` | Audit trail of approval delegation chain hops |

### Seeded Data
- **HR**: Priya Sharma
- **Managers**: Rajesh Kumar (Engineering), Anita Desai (Finance), Vikram Patel (Marketing)
- **Employees**: 12 employees (4 per department), each reporting to their department manager
- **Leave Balances**: Initialized for 2026 (12 casual, 8 sick, 15 earned)
- **Blackout Periods**: Finance month-end closes, Engineering launch/hackathon weeks

---

## API Endpoints

### Employees
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/employees` | List all employees |
| GET | `/api/employees/:id` | Get employee by ID |
| GET | `/api/employees/:id/reports` | Get direct reports |
| GET | `/api/employees/:id/balances?year=2026` | Get leave balances |

### Leave Requests
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/leaves` | Create leave request |
| GET | `/api/leaves/:id` | Get leave request by ID |
| GET | `/api/leaves/employee/:employeeId` | Get all requests for an employee |
| POST | `/api/leaves/:id/approve` | Approve a leave request |
| POST | `/api/leaves/:id/reject` | Reject a leave request |
| POST | `/api/leaves/:id/cancel` | Cancel a leave request |
| POST | `/api/leaves/:id/document` | Upload medical document |
| GET | `/api/leaves/:id/delegation-history` | View delegation chain audit trail |

### Approvals
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leaves/pending/manager/:managerId` | Pending requests for a manager |
| GET | `/api/leaves/pending/hr` | Pending requests needing HR approval |

### Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leaves/notifications/:employeeId?unread=true` | Get notifications |
| PATCH | `/api/leaves/notifications/:id/read` | Mark as read |

### Blackout Periods
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/blackout-periods?department=Finance` | List blackout periods |
| POST | `/api/blackout-periods` | Create blackout period |
| DELETE | `/api/blackout-periods/:id` | Delete blackout period |

---

## Approval Rules & Design Decisions

### Rule 1: Manager approves direct reports
Straightforward — the system checks `reporting_manager_id` to verify authority.

### Rule 2: Dual approval for >3 consecutive days
When `consecutiveDays > 3`, both the manager AND HR must approve. The request starts as `pending`, and after one approval moves to `partially_approved`. Either one can reject at any time — rejection is immediate and final.

**Why "either can reject"?** The assignment says "either one can reject." I interpret this as a veto model — if either authority sees a problem, the request is denied. This is safer than requiring consensus to reject.

### Rule 3: 30% team capacity warning
The system calculates projected on-leave count per date. If approving would put >30% of the department on leave on any date, the request is **flagged** with `team_capacity_warning = true`. The approver sees the warning but can still approve.

**Conflict with Rule 2:** If a >3-day request also triggers the 30% warning, both rules apply independently. The dual approval still occurs, and both approvers see the capacity warning.

### Rule 4: Sick leave document requirement
Sick leave of ≥3 consecutive days enters `pending_document` status with a **72-hour deadline**.
- **Reminder at 24h before deadline** (first reminder)
- **Urgent reminder at 12h** (second reminder)
- **Auto-reject when deadline passes**
- Once document is uploaded → status moves to `pending` (normal approval flow)

**Conflict with Rule 2:** If sick leave is also >3 days (triggering dual-approval), the document must be uploaded first. Only then does the request enter the approval flow. This prevents approvers from wasting time reviewing incomplete requests.

**Design choice on timing:** 3 days is generous enough for genuine illness but short enough to prevent gaming.

### Rule 5: Manager self-leave escalation
A manager's leave goes to their `reporting_manager_id`. If no one above them → HR acts as the manager-role approver.

**Conflict with Rule 2:** If a manager requests >3 days, their manager approves (manager role) AND HR approves (HR role). If the manager has no one above them, HR fills both roles — in this case, a single HR approval suffices since they're acting in both capacities.

### Rule 6: Blackout period warnings
Leave during a blackout period gets `blackout_warning = true`. To approve, the approver must explicitly set `blackout_override = true`. Without the override, the API rejects the approval attempt.

**Conflict with Rule 3:** Both warnings can appear simultaneously. They're independent flags — the approver sees both and must consciously decide.

**Conflict with Rule 2:** In dual approval with blackout, EITHER approver can set the override. Only one override is needed (stored on the request).

### Rule Conflict Summary

| Scenario | Resolution |
|----------|-----------|
| >3 days sick leave | Document required FIRST, then dual approval kicks in |
| >3 days + 30% breach | Dual approval + capacity warning shown to both approvers |
| Blackout + 30% breach | Both warnings shown; approver must override blackout explicitly |
| Manager self-leave + >3 days | Escalated manager approves + HR approves |
| Manager self-leave + no boss | HR acts as sole approver (both manager and HR role) |

---

## Approval Delegation Chain (Option C)

### How It Works

When a leave request is created or while it's pending approval, the system checks if the assigned manager-approver is available:

1. **On creation**: If the direct manager is on approved leave during the request dates, the approval is immediately delegated up the chain.
2. **48-hour timeout**: A scheduled job runs every 30 minutes. If a request has been waiting for manager approval for >48 hours, it's automatically escalated to the next person up the chain.
3. **Chain walking**: `current approver → their reporting_manager → their reporting_manager → ... → HR (final fallback)`

### Loop Prevention

| Mechanism | Description |
|-----------|-------------|
| Visited set | During chain traversal, a `Set<number>` tracks visited IDs. If we encounter someone already visited, the chain breaks. |
| Escalation cap | Hard limit of 5 escalations per request (`escalation_count`). After 5 hops, no further delegation occurs. |
| HR terminal node | HR is always the final stop. Chain walking never goes past HR. |

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Direct manager on leave | Immediate delegation on request creation |
| Backup manager also on leave | Chain continues up to the next available person |
| All managers unavailable | Falls back to HR as ultimate approver |
| No HR in system | Delegation fails gracefully; stays with original approver |
| Circular reporting chain | Loop detection breaks the cycle; falls back to HR |
| 48h timeout + manager on leave | Escalates to next available person (may skip multiple levels) |

### Audit Trail

Every delegation hop is recorded in `delegation_log`:
```
| from_approver | to_approver | reason          |
|---------------|-------------|------------------|
| Rajesh Kumar  | Priya Sharma| on_leave         |
```

Additionally, `approval_actions` records each delegation with action `'delegated'` for full traceability.

### Database Fields

Added to `leave_requests`:
- `current_manager_approver_id` — who currently needs to approve (may differ from reporting_manager_id)
- `escalation_count` — how many times this request has been delegated
- `current_approver_assigned_at` — when the current approver was assigned (used for 48h timeout)

---

## Fan-Out Architecture

### Design
The system uses an **in-process event bus** (Node.js `EventEmitter`). When a leave status changes, the API handler updates the database (source of truth) and then **emits an event**. Registered handlers run asynchronously and do not block the API response.

```
API Request → DB State Change → Emit Event → Return Response
                                    ↓
                           ┌────────┴────────┐
                           │   Event Bus      │
                           └────────┬────────┘
                    ┌───────┬───────┼───────┬────────┐
                    ▼       ▼       ▼       ▼        ▼
                Balance  Notify  Notify  Avail.  Reassign
                Deduct   Employee Team    Update  Approvals
```

### On Approval
1. **Deduct leave balance** — reduces `used_days`
2. **Notify employee** — "Your leave was approved"
3. **Notify team** — "X will be out from ... to ..."
4. **Update team availability** — records per-date entries for 30% rule
5. **Reassign approvals** — if the approved person is a manager, their pending approval queue is reassigned

### On Rejection
1. **Notify employee** — includes rejection reason
2. **Notify other approver** — in dual-approval, if one already approved, tell them the other rejected

### On Cancellation
1. **Credit balance back** — restores `used_days`
2. **Notify manager** — "X cancelled their leave"
3. **Remove from availability** — cleans up per-date records
4. **Re-evaluate capacity** — pending requests previously flagged for 30% breach are re-checked; if capacity freed up, the warning is cleared

### Failure Handling
Each handler is isolated with its own try/catch. If one fails:
- **The approval is NOT rolled back.** The DB status change (approved/rejected/cancelled) is the source of truth.
- Failed handlers log errors. In production, these would go to a dead-letter queue for retry.
- **Rationale:** Approval is a user-facing action. If a notification fails to send, the approval itself should still stand. Downstream effects are eventual-consistency.

### Extensibility
To add a new downstream action (e.g., sync to Google Calendar on approval):
1. Create a new handler in `src/events/handlers/`
2. Register it in `src/events/register.ts`
3. Zero changes to approval logic.

---

## Scheduled Jobs

| Job | Frequency | Purpose |
|-----|-----------|---------|
| Document deadline check | Every hour | Sends reminders and auto-rejects expired pending_document requests |
| Stale approval escalation | Every 30 min | Escalates requests where approver hasn't responded in 48 hours |
---

## Project Structure

```
src/
├── app.ts                          # Express setup, route mounting
├── config/database.ts              # pg Pool config
├── types/index.ts                  # All TypeScript interfaces & types
├── utils/helpers.ts                # Date math utilities
├── middleware/
│   ├── asyncHandler.ts             # Async error wrapper
│   └── errorHandler.ts             # Global error handler
├── services/
│   ├── employee.service.ts         # Employee lookups, team queries
│   ├── balance.service.ts          # Leave balance CRUD
│   ├── leave.service.ts            # Core business logic (rules 1-6)
│   ├── delegation.service.ts       # Approval delegation chain logic
│   ├── blackout.service.ts         # Blackout period management
│   ├── availability.service.ts     # Team capacity (30% rule)
│   └── notification.service.ts     # Notification persistence
├── controllers/
│   ├── employee.controller.ts      # Employee endpoints
│   ├── leave.controller.ts         # Leave + approval endpoints
│   └── blackout.controller.ts      # Blackout endpoints
├── routes/
│   ├── employee.routes.ts
│   ├── leave.routes.ts
│   └── blackout.routes.ts
├── events/
│   ├── emitter.ts                  # Event bus (EventEmitter wrapper)
│   ├── register.ts                 # Handler registration
│   └── handlers/
│       ├── balance.handler.ts      # Balance deduct/credit
│       ├── notification.handler.ts # All notification logic
│       ├── availability.handler.ts # Team availability updates
│       └── reassignment.handler.ts # Manager approval reassignment
└── jobs/
    └── scheduler.ts                # Cron jobs (document reminders)
migrations/
├── 001_schema.sql                  # Full database schema
└── 002_delegation_chain.sql        # Delegation chain columns + delegation_log table
```

---

## Tech Decisions

| Decision | Why |
|----------|-----|
| Raw `pg` over ORM | Full SQL control, no abstraction leaks, clearer for reviewers |
| EventEmitter over MQ | Sufficient for single-process; easy to swap to Redis/RabbitMQ later |
| Cron for reminders | Simpler than a separate worker process; `node-cron` runs in-process |
| No auth middleware | Assignment says no frontend; IDs passed in body for simplicity |
| fire-and-forget events | Approval response isn't blocked by notifications/balance updates |
