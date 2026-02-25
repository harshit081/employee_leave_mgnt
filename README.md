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
| `status_change_log` | Append-only immutable audit log of every leave status change |

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
| GET | `/api/leaves/:id/status-log` | View immutable status change audit trail |

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

Straightforward — the system checks `reporting_manager_id` to verify authority. In `approveLeave()`, the approver must be:
- The employee's direct manager (`requestor.reporting_manager_id === approverId`), OR
- A delegated approver via the delegation chain (`current_manager_approver_id === approverId`), OR
- HR acting in the manager role for escalated cases

If none of these match → `"You are not authorized to approve this leave request"`.

### Rule 2: Dual approval for >3 consecutive days

When `consecutiveDays > 3`, both the manager AND HR must approve. The state machine is:

```
pending → (first approval) → partially_approved → (second approval) → approved
                                    ↓ (either rejects)
                                 rejected
```

In `createLeaveRequest()`:
```typescript
const numConsecutive = consecutiveDays(startDate, endDate);
const requiresDualApproval = numConsecutive > 3;
const hrApproval = requiresDualApproval ? 'pending' : 'not_required';
```

In `approveLeave()`, after recording the approval, the system checks:
```typescript
const managerDone = updated.manager_approval === 'approved';
const hrDone = updated.hr_approval === 'approved' || updated.hr_approval === 'not_required';

if (managerDone && hrDone) {
  finalStatus = 'approved';        // Both done → fully approved
} else {
  finalStatus = 'partially_approved'; // One done, waiting for other
}
```

**Why "either can reject"?** This is a veto model — if either authority sees a problem, the request is denied immediately. In `rejectLeave()`, regardless of who rejects, the status goes straight to `'rejected'`. No second opinion needed.

### Rule 3: 30% team capacity warning

The system calculates projected on-leave count **per date** across every business day in the range. In `createLeaveRequest()`:

```typescript
const capacityCheck = await availabilityService.checkTeamCapacity(
  employee.department, employee.id, startDate, endDate, teamSize
);

if (capacityCheck.wouldBreach) {
  warnings.push(`⚠ Team capacity warning: ...${worstDay.percentage}% of ${employee.department}...`);
}
```

The request is **flagged** with `team_capacity_warning = true` but never auto-rejected. When a manager or HR views their pending approvals, the warning is surfaced:

```typescript
if (lr.team_capacity_warning) warnings.push('⚠ This request would breach 30% team capacity threshold.');
```

The approver decides. No override flag needed — it's purely advisory.

### Rule 4: Sick leave document requirement

Sick leave of ≥3 consecutive days enters `pending_document` status with a **72-hour deadline**:

```typescript
if (dto.leave_type === 'sick' && numConsecutive >= 3) {
  status = 'pending_document';
  documentDeadline = new Date();
  documentDeadline.setDate(documentDeadline.getDate() + 3); // 72 hours
}
```

**Scheduled job (runs every hour)** handles reminders and auto-rejection:
- **24h before deadline** → first reminder notification
- **12h before deadline** → urgent reminder notification
- **Deadline passes** → auto-reject with reason `"Auto-rejected: medical document not uploaded within deadline (3 days)"`

Once a document is uploaded via `POST /:id/document`:
```typescript
// status moves from pending_document → pending (enters normal approval flow)
await client.query(
  `UPDATE leave_requests SET medical_document_url = $2, status = 'pending', ...`,
  [leaveRequestId, documentUrl]
);
```

**Design choice on timing:** 3 days is generous enough for genuine illness but short enough to prevent gaming.

### Rule 5: Manager self-leave escalation

A manager cannot approve their own leave. The system first prevents it:
```typescript
if (approverId === leaveRequest.employee_id) {
  throw new Error('Cannot approve your own leave request');
}
```

Then, on creation, the approver is determined via `getApproverFor()`:
- If the manager has a `reporting_manager_id` → that person is the manager-role approver
- If no one above them → HR acts as the manager-role approver

In `approveLeave()`, the key logic that lets HR fill the "manager" slot:
```typescript
const hrActsAsManager =
  (requestor.role === 'manager' || requestor.role === 'hr') &&
  (requestor.reporting_manager_id === approverId || requestor.reporting_manager_id === null);

if ((hrActsAsManager || hrIsDelegatedApprover) && leaveRequest.manager_approval === 'pending') {
  roleType = 'manager';  // HR fills the manager-role slot
} else {
  roleType = 'hr';       // HR fills the HR-role slot
}
```

### Rule 6: Blackout period warnings

Leave during a blackout period gets `blackout_warning = true`. The warning is set at creation time:

```typescript
const blackoutConflicts = await blackoutService.checkBlackoutConflict(
  employee.department, startDate, endDate
);
if (blackoutConflicts.length > 0) {
  blackoutWarning = true;
  warnings.push(`⚠ Blackout period: "${bp.name}" ...Approver must explicitly override.`);
}
```

At approval time, the override is **required** or the approval is rejected:
```typescript
if (leaveRequest.blackout_warning && !blackoutOverride) {
  throw new Error('This leave falls during a blackout period. Set blackout_override=true to explicitly approve.');
}
```

The `blackout_override` flag is stored on the request row when an approver provides it.

---

## How Rule Conflicts Are Handled

The six rules aren't independent — they interact when multiple conditions are true simultaneously. Here's how every conflict is resolved:

### Conflict 1: >3-Day Sick Leave (Rule 4 × Rule 2)

**Scenario:** Employee requests 5 days of sick leave.

**Problem:** Rule 4 says "needs document first." Rule 2 says "needs dual approval." Which comes first?

**Resolution:** Rule 4 gates **submission**, Rule 2 gates **approval**. They run sequentially:

```
CREATE → pending_document (Rule 4 blocks approval flow)
         ↓ (employee uploads document)
         pending → manager approves → partially_approved → HR approves → approved
                                       (Rule 2 dual approval)
```

In code, `createLeaveRequest()` sets `status = 'pending_document'` AND `requires_dual_approval = true` simultaneously. But since `approveLeave()` requires status to be `'pending'` or `'partially_approved'`, no one can approve until the document is uploaded. This prevents approvers from wasting time reviewing incomplete requests.

### Conflict 2: >3-Day Leave + 30% Team Breach (Rule 2 × Rule 3)

**Scenario:** Employee requests 5 days, and the team already has people out on those dates.

**Resolution:** Both rules apply independently — they don't interfere.

- `requires_dual_approval = true` (Rule 2) → both manager and HR must approve
- `team_capacity_warning = true` (Rule 3) → both approvers see the warning

When a manager or HR queries their pending queue, both warnings are surfaced:
```typescript
if (lr.team_capacity_warning) warnings.push('⚠ ...30% team capacity threshold.');
if (lr.blackout_warning) warnings.push('⚠ ...blackout period...');
```

Rule 3 is purely advisory — it never blocks. Rule 2 is structural — it determines *who* needs to approve.

### Conflict 3: Manager Self-Leave + >3 Days (Rule 5 × Rule 2)

**Scenario:** A manager requests >3 consecutive days. Rule 5 says it escalates up. Rule 2 says both manager-role AND HR-role must approve.

**Resolution: Two sub-cases:**

**Case A — Manager has a boss:**
The manager's boss fills the "manager" role, HR fills the "HR" role → standard dual approval with two different people.

**Case B — Manager has no boss (top of reporting chain):**
HR fills **both** roles. The HR person can approve twice:

1. **First approval:** `manager_approval` is `'pending'` → the `hrActsAsManager` check is true → `roleType = 'manager'` → status becomes `partially_approved`
2. **Second approval:** `manager_approval` is now `'approved'`, so the condition `leaveRequest.manager_approval === 'pending'` is false → `roleType = 'hr'` → status becomes `approved`

For a manager with no boss requesting **≤3 days** (`hr_approval = 'not_required'`): A single HR approval fills the manager slot, and since `hrDone` is already `true` (not_required), the request is immediately `approved` in one step.

### Conflict 4: Blackout + 30% Breach (Rule 6 × Rule 3)

**Scenario:** Leave during a blackout period that would also breach 30% capacity.

**Resolution:** Both flags are set independently at creation time:

```typescript
team_capacity_warning = true   // Rule 3 — advisory
blackout_warning = true        // Rule 6 — requires override
```

At approval time:
- **Capacity warning** is informational — approver sees it but isn't blocked
- **Blackout warning** requires `blackout_override: true` in the request body, or the approval is rejected

The approver sees both warnings and must consciously decide on the blackout. Capacity is shown for context but doesn't gate anything.

### Conflict 5: Blackout + Dual Approval (Rule 6 × Rule 2)

**Scenario:** A >3-day leave falls during a blackout period. Both manager and HR need to approve.

**Resolution:** Each approver independently acknowledges the blackout.

The `blackout_override` check runs for **every** approval call:
```typescript
if (leaveRequest.blackout_warning && !blackoutOverride) {
  throw new Error('...Set blackout_override=true to explicitly approve.');
}
```

So both the manager and HR must pass `blackout_override: true` in their respective approval requests. This is intentional — each approver independently acknowledges the risk. You don't want one person's override to silently greenlight it for the other.

### Conflict 6: Sick Leave + Blackout + Dual Approval (Rule 4 × Rule 6 × Rule 2)

**The triple conflict.** A 5-day sick leave during a Finance month-end blackout.

**Resolution:** The rules compose cleanly because they operate at **different stages**:

```
Stage 1 — CREATION:
  • Rule 4: status = 'pending_document' (blocks approvals)
  • Rule 2: requires_dual_approval = true (stored for later)
  • Rule 6: blackout_warning = true (stored for later)
  • Rule 3: team_capacity_warning = true/false (stored for later)

Stage 2 — DOCUMENT UPLOAD:
  • Rule 4: status moves to 'pending' (unlocks approval flow)

Stage 3 — FIRST APPROVAL (manager):
  • Rule 6: must pass blackout_override=true
  • Rule 2: status → 'partially_approved' (waiting for HR)
  • Rule 3: capacity warning shown (advisory)

Stage 4 — SECOND APPROVAL (HR):
  • Rule 6: must pass blackout_override=true (independently)
  • Rule 2: status → 'approved' (both done)
  • Rule 3: capacity warning shown (advisory)
```

No special "triple conflict" code path exists. Each rule is a composable layer that checks its own condition at its own stage.

### Rule Conflict Summary

| Conflict | Rules | Resolution |
|----------|-------|-----------|
| >3 days sick leave | R4 × R2 | Document required FIRST, then dual approval kicks in |
| >3 days + 30% breach | R2 × R3 | Dual approval + capacity warning shown to both approvers |
| Manager self-leave + >3 days | R5 × R2 | Escalated manager approves (manager role) + HR approves (HR role) |
| Manager self-leave + no boss | R5 × R2 | HR fills both roles — can approve twice (once as manager, once as HR) |
| Blackout + 30% breach | R6 × R3 | Both warnings shown; blackout requires override, capacity is advisory |
| Blackout + dual approval | R6 × R2 | Each approver independently passes `blackout_override: true` |
| Sick + blackout + dual | R4 × R6 × R2 | Document → pending → each approval checks blackout override independently |

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

## Status Audit Log

Every status change on a leave request is captured in an **append-only, immutable** audit trail. Nobody can edit or delete log entries — not even database admins.

### How It Works

```
INSERT leave_request (status='pending') ──► log_status_on_insert trigger
                                               │
                                               ▼
                                    status_change_log row:
                                    old='(created)', new='pending',
                                    changed_by=employee_id

UPDATE status 'pending' → 'approved' ──► log_status_change trigger
                                               │
                                               ▼
                                    status_change_log row:
                                    old='pending', new='approved',
                                    changed_by=approver_id
```

### Three-Layer Protection

| Layer | Mechanism | What It Does |
|-------|-----------|-------------|
| **INSERT trigger** | `log_status_on_insert()` | Captures the initial status when a leave request is created |
| **UPDATE trigger** | `log_status_change()` | Catches every `status` column change, recording old → new + who did it |
| **Mutation-blocking trigger** | `prevent_log_mutation()` | Raises an exception on any `UPDATE` or `DELETE` against the log table |

### Actor Tracking with `withActor()`

The `withActor(actorId, fn)` helper wraps status-changing queries in a transaction that sets a PostgreSQL session variable:

```sql
BEGIN;
SET LOCAL app.current_user_id = '2';   -- approver's ID
UPDATE leave_requests SET status = 'approved' WHERE id = 1;
COMMIT;
```

The trigger reads `current_setting('app.current_user_id', true)` to record who made the change. For system actions (e.g., auto-reject by cron), the actor is `0`.

### Immutability Guarantee

```sql
-- Both of these FAIL with:
-- ERROR: status_change_log is append-only. Updates and deletes are forbidden.
UPDATE status_change_log SET new_status = 'hacked' WHERE id = 1;
DELETE FROM status_change_log WHERE id = 1;
```

The only way to bypass this is to drop the trigger, which requires DDL privileges and is auditable at the infrastructure level.

### API

```
GET /api/leaves/:id/status-log
```

Returns the full chronological audit trail:

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "leave_request_id": 1,
      "changed_by_id": 5,
      "old_status": "(created)",
      "new_status": "pending",
      "changed_at": "2026-02-25T11:15:57.301Z"
    },
    {
      "id": 2,
      "leave_request_id": 1,
      "changed_by_id": 2,
      "old_status": "pending",
      "new_status": "approved",
      "changed_at": "2026-02-25T11:16:57.903Z"
    }
  ]
}
```

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
├── config/database.ts              # pg Pool config + withActor() helper
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
├── 002_delegation_chain.sql        # Delegation chain columns + delegation_log table
└── 003_status_audit_log.sql        # Append-only status_change_log table + triggers
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
| DB triggers for audit | Guarantees logging even on direct SQL; impossible to skip at the app layer |
| `SET LOCAL` for actor tracking | Transaction-scoped, safe for concurrent requests, no global state |
