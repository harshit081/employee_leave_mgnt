import pool from '../config/database';
import * as employeeService from './employee.service';
import * as notificationService from './notification.service';
import { LeaveRequest, DelegationLog } from '../types';

/**
 * Approval Delegation Chain Service
 *
 * Handles automatic routing of approvals when a manager is unavailable.
 * Unavailability = on approved leave overlapping the request dates, OR 48h timeout.
 *
 * Chain walking logic:
 *   current_approver → their reporting_manager → their reporting_manager → ... → HR (final fallback)
 *
 * Loop prevention:
 *   1. Track visited IDs in a Set during chain traversal
 *   2. Hard cap of 5 escalations per request (escalation_count)
 *   3. HR is always the terminal node — chain stops there
 */

const MAX_ESCALATIONS = 5;

// ─── Check if an employee is on approved leave during given dates ────────────

export async function isOnLeave(employeeId: number, startDate: Date, endDate: Date): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM leave_requests
     WHERE employee_id = $1
       AND status = 'approved'
       AND start_date <= $3
       AND end_date >= $2
     LIMIT 1`,
    [employeeId, startDate, endDate]
  );
  return result.rows.length > 0;
}

// ─── Walk the delegation chain to find the next available approver ───────────

export interface DelegationResult {
  approverId: number;
  hops: { fromId: number; toId: number; reason: DelegationLog['reason'] }[];
  reachedHR: boolean;
}

/**
 * Starting from `startApproverId`, walk up the reporting chain to find someone
 * who is NOT on leave during the request dates. Returns the first available
 * approver and the full hop trail.
 *
 * @param startApproverId  The current (potentially unavailable) approver
 * @param leaveStartDate   The leave request's start date
 * @param leaveEndDate     The leave request's end date
 * @param reason           Why delegation is happening (on_leave | timeout_48h)
 * @param currentEscalationCount  How many times this request has already been escalated
 */
export async function findNextAvailableApprover(
  startApproverId: number,
  leaveStartDate: Date,
  leaveEndDate: Date,
  reason: DelegationLog['reason'],
  currentEscalationCount: number
): Promise<DelegationResult | null> {
  const visited = new Set<number>();
  const hops: DelegationResult['hops'] = [];
  let currentId = startApproverId;
  let escalations = currentEscalationCount;

  while (escalations < MAX_ESCALATIONS) {
    // Loop detection
    if (visited.has(currentId)) {
      console.warn(`[Delegation] Loop detected at employee #${currentId}. Breaking chain.`);
      break;
    }
    visited.add(currentId);

    const current = await employeeService.getEmployeeById(currentId);
    if (!current) break;

    // HR is always the terminal fallback — they are always "available" as final approver
    if (current.role === 'hr') {
      return { approverId: current.id, hops, reachedHR: true };
    }

    // Check if this person is on leave during the request dates
    const onLeave = await isOnLeave(currentId, leaveStartDate, leaveEndDate);

    if (!onLeave && currentId !== startApproverId) {
      // This person is available and is NOT the original (unavailable) approver
      return { approverId: currentId, hops, reachedHR: false };
    }

    // This person is unavailable — escalate up
    const nextId = current.reporting_manager_id;
    if (!nextId) {
      // No one above — fall back to HR
      const hrList = await employeeService.getHREmployees();
      if (hrList.length === 0) {
        console.warn('[Delegation] No HR found as final fallback');
        return null;
      }
      const hr = hrList[0]!;
      hops.push({
        fromId: currentId,
        toId: hr.id,
        reason: currentId === startApproverId ? reason : 'also_unavailable',
      });
      return { approverId: hr.id, hops, reachedHR: true };
    }

    hops.push({
      fromId: currentId,
      toId: nextId,
      reason: currentId === startApproverId ? reason : 'also_unavailable',
    });

    currentId = nextId;
    escalations++;
  }

  // Exhausted chain — hard fallback to HR
  const hrList = await employeeService.getHREmployees();
  if (hrList.length > 0) {
    const hr = hrList[0]!;
    if (!visited.has(hr.id)) {
      hops.push({ fromId: currentId, toId: hr.id, reason: 'also_unavailable' });
      return { approverId: hr.id, hops, reachedHR: true };
    }
  }

  console.error('[Delegation] Could not find any available approver. Chain exhausted.');
  return null;
}

// ─── Apply a delegation: update request + write logs + notify ────────────────

export async function delegateApproval(
  leaveRequestId: number,
  delegationResult: DelegationResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update the leave request to point to the new approver
    await client.query(
      `UPDATE leave_requests
       SET current_manager_approver_id = $2,
           escalation_count = escalation_count + $3,
           current_approver_assigned_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [leaveRequestId, delegationResult.approverId, delegationResult.hops.length]
    );

    // Write each hop to the delegation log
    for (const hop of delegationResult.hops) {
      await client.query(
        `INSERT INTO delegation_log (leave_request_id, from_approver_id, to_approver_id, reason)
         VALUES ($1, $2, $3, $4)`,
        [leaveRequestId, hop.fromId, hop.toId, hop.reason]
      );

      // Record in approval_actions for audit trail
      await client.query(
        `INSERT INTO approval_actions (leave_request_id, approver_id, action, role_type, comments)
         VALUES ($1, $2, 'delegated', 'manager', $3)`,
        [leaveRequestId, hop.fromId, `Delegated to employee #${hop.toId} (reason: ${hop.reason})`]
      );
    }

    await client.query('COMMIT');

    // Notify the new approver (outside transaction — non-critical)
    const lr = await pool.query('SELECT * FROM leave_requests WHERE id = $1', [leaveRequestId]);
    if (lr.rows[0]) {
      const request = lr.rows[0];
      const employee = await employeeService.getEmployeeById(request.employee_id);
      const fromApprover = delegationResult.hops.length > 0
        ? await employeeService.getEmployeeById(delegationResult.hops[0]!.fromId)
        : null;

      await notificationService.createNotification(
        delegationResult.approverId,
        'approval_delegated',
        `Leave request #${leaveRequestId} from ${employee?.name || 'unknown'} needs your approval. ` +
        `${fromApprover ? `Delegated from ${fromApprover.name}` : 'Delegated'} ` +
        `(${delegationResult.hops.length} hop(s) in chain, ${delegationResult.reachedHR ? 'reached HR fallback' : 'next in chain'}).`,
        leaveRequestId
      );
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Get delegation history for a leave request ─────────────────────────────

export async function getDelegationHistory(leaveRequestId: number): Promise<DelegationLog[]> {
  const result = await pool.query(
    `SELECT dl.*, fe.name as from_name, te.name as to_name
     FROM delegation_log dl
     JOIN employees fe ON dl.from_approver_id = fe.id
     JOIN employees te ON dl.to_approver_id = te.id
     WHERE dl.leave_request_id = $1
     ORDER BY dl.created_at ASC`,
    [leaveRequestId]
  );
  return result.rows;
}

// ─── Check and delegate on creation (if direct manager is on leave) ─────────

export async function delegateIfApproverUnavailable(
  leaveRequestId: number,
  approverId: number,
  leaveStartDate: Date,
  leaveEndDate: Date
): Promise<{ delegated: boolean; newApproverId: number }> {
  const onLeave = await isOnLeave(approverId, leaveStartDate, leaveEndDate);
  if (!onLeave) {
    return { delegated: false, newApproverId: approverId };
  }

  const result = await findNextAvailableApprover(approverId, leaveStartDate, leaveEndDate, 'on_leave', 0);
  if (!result) {
    // If no one is available, leave with original approver — they'll see it when back
    return { delegated: false, newApproverId: approverId };
  }

  await delegateApproval(leaveRequestId, result);
  return { delegated: true, newApproverId: result.approverId };
}

// ─── Process stale approvals (48h timeout) ──────────────────────────────────

export async function processStaleApprovals(): Promise<number> {
  // Find pending requests where current_approver_assigned_at > 48 hours ago
  const result = await pool.query(
    `SELECT lr.*, e.name as employee_name
     FROM leave_requests lr
     JOIN employees e ON lr.employee_id = e.id
     WHERE lr.status IN ('pending', 'partially_approved')
       AND lr.manager_approval = 'pending'
       AND lr.current_manager_approver_id IS NOT NULL
       AND lr.current_approver_assigned_at IS NOT NULL
       AND lr.current_approver_assigned_at < NOW() - INTERVAL '48 hours'
       AND lr.escalation_count < $1`,
    [MAX_ESCALATIONS]
  );

  let escalated = 0;

  for (const lr of result.rows) {
    const currentApproverId = lr.current_manager_approver_id;
    const delegationResult = await findNextAvailableApprover(
      currentApproverId,
      new Date(lr.start_date),
      new Date(lr.end_date),
      'timeout_48h',
      lr.escalation_count
    );

    if (delegationResult) {
      await delegateApproval(lr.id, delegationResult);

      // Notify the original approver that it was escalated
      await notificationService.createNotification(
        currentApproverId,
        'approval_escalated_timeout',
        `Leave request #${lr.id} from ${lr.employee_name} was escalated because you did not respond within 48 hours. It has been routed to the next approver in the chain.`,
        lr.id
      );

      // Notify the employee about the delegation
      await notificationService.createNotification(
        lr.employee_id,
        'approval_delegated_info',
        `Your leave request #${lr.id} has been automatically rerouted to a different approver because the original approver did not respond within 48 hours.`,
        lr.id
      );

      escalated++;
      console.log(`[Delegation] Leave #${lr.id}: escalated from approver #${currentApproverId} to #${delegationResult.approverId} (48h timeout)`);
    } else {
      console.warn(`[Delegation] Leave #${lr.id}: no available approver found after 48h timeout`);
    }
  }

  return escalated;
}
