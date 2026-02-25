import pool, { withActor } from '../config/database';
import { LeaveRequest, CreateLeaveRequestDTO, Employee, LeaveEvent } from '../types';
import * as balanceService from './balance.service';
import * as employeeService from './employee.service';
import * as blackoutService from './blackout.service';
import * as availabilityService from './availability.service';
import * as delegationService from './delegation.service';
import { consecutiveDays, countBusinessDays } from '../utils/helpers';
import { leaveEventBus } from '../events/emitter';

// ─── Create Leave Request ────────────────────────────────────────────────────

export async function createLeaveRequest(dto: CreateLeaveRequestDTO): Promise<{
  leaveRequest: LeaveRequest;
  warnings: string[];
}> {
  const employee = await employeeService.getEmployeeById(dto.employee_id);
  if (!employee) throw new Error('Employee not found');

  const startDate = new Date(dto.start_date);
  const endDate = new Date(dto.end_date);
  if (endDate < startDate) throw new Error('End date must be after start date');

  const days = countBusinessDays(startDate, endDate);
  if (days === 0) throw new Error('Leave request must include at least one business day');

  const warnings: string[] = [];

  // ── Check leave balance ──────────────────────────────────────────────────
  const year = startDate.getFullYear();
  const hasBalance = await balanceService.hasEnoughBalance(employee.id, dto.leave_type, year, days);
  if (!hasBalance) {
    throw new Error(`Insufficient ${dto.leave_type} leave balance. Requested ${days} day(s).`);
  }

  // ── Determine if dual approval is needed (Rule 2) ────────────────────────
  const numConsecutive = consecutiveDays(startDate, endDate);
  const requiresDualApproval = numConsecutive > 3;

  // ── Determine initial status ─────────────────────────────────────────────
  // Rule 4: Sick leave >= 3 days needs medical document
  let status: LeaveRequest['status'] = 'pending';
  let documentDeadline: Date | null = null;

  if (dto.leave_type === 'sick' && numConsecutive >= 3) {
    status = 'pending_document';
    // 3-day deadline for document upload
    documentDeadline = new Date();
    documentDeadline.setDate(documentDeadline.getDate() + 3);
  }

  // ── Team capacity check (Rule 3) ────────────────────────────────────────
  const teamSize = await employeeService.getTeamSize(employee.department);
  const capacityCheck = await availabilityService.checkTeamCapacity(
    employee.department, employee.id, startDate, endDate, teamSize
  );

  if (capacityCheck.wouldBreach) {
    const worstDay = capacityCheck.details[0]!;
    warnings.push(
      `⚠ Team capacity warning: Approving this would put ${worstDay.percentage}% of ${employee.department} on leave on ${worstDay.date} (${worstDay.onLeave}/${teamSize} people). The 30% threshold would be breached.`
    );
  }

  // ── Blackout period check (Rule 6) ──────────────────────────────────────
  const blackoutConflicts = await blackoutService.checkBlackoutConflict(
    employee.department, startDate, endDate
  );

  let blackoutWarning = false;
  if (blackoutConflicts.length > 0) {
    blackoutWarning = true;
    for (const bp of blackoutConflicts) {
      warnings.push(
        `⚠ Blackout period: "${bp.name}" (${bp.start_date} to ${bp.end_date}) — ${bp.reason}. Approver must explicitly override.`
      );
    }
  }

  // ── Determine approval flow ─────────────────────────────────────────────
  const hrApproval = requiresDualApproval ? 'pending' : 'not_required';

  // ── Determine the initial manager approver ─────────────────────────────
  const { managerId: initialManagerId, needsHRAsManager } = await employeeService.getApproverFor(employee);
  let managerApproverId: number | null = initialManagerId;
  if (!managerApproverId && needsHRAsManager) {
    const hrList = await employeeService.getHREmployees();
    managerApproverId = hrList.length > 0 ? hrList[0]!.id : null;
  }

  // ── Insert the leave request ────────────────────────────────────────────
  const result = await pool.query(
    `INSERT INTO leave_requests (
      employee_id, leave_type, start_date, end_date, reason, status,
      document_deadline, requires_dual_approval, manager_approval, hr_approval,
      team_capacity_warning, blackout_warning,
      current_manager_approver_id, escalation_count, current_approver_assigned_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, 0, NOW())
    RETURNING *`,
    [
      employee.id, dto.leave_type, dto.start_date, dto.end_date,
      dto.reason || null, status, documentDeadline, requiresDualApproval,
      hrApproval, capacityCheck.wouldBreach, blackoutWarning,
      managerApproverId
    ]
  );

  let leaveRequest = result.rows[0] as LeaveRequest;

  // ── Delegation: check if approver is on leave → immediate escalation ───
  if (managerApproverId && status !== 'pending_document') {
    const delegation = await delegationService.delegateIfApproverUnavailable(
      leaveRequest.id, managerApproverId, startDate, endDate
    );
    if (delegation.delegated) {
      warnings.push(
        `ℹ Your manager is currently on leave. Your request has been automatically routed to an alternate approver.`
      );
      leaveRequest = (await getLeaveRequestById(leaveRequest.id))!;
    }
  }

  // ── Emit event ──────────────────────────────────────────────────────────
  leaveEventBus.emitLeaveEvent({
    type: 'leave.created',
    leaveRequest,
    actor_id: employee.id,
  });

  return { leaveRequest, warnings };
}

// ─── Get Leave Requests ──────────────────────────────────────────────────────

export async function getLeaveRequestById(id: number): Promise<LeaveRequest | null> {
  const result = await pool.query('SELECT * FROM leave_requests WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getLeaveRequestsByEmployee(employeeId: number): Promise<LeaveRequest[]> {
  const result = await pool.query(
    'SELECT * FROM leave_requests WHERE employee_id = $1 ORDER BY created_at DESC',
    [employeeId]
  );
  return result.rows;
}

export async function getPendingApprovalsForManager(managerId: number): Promise<(LeaveRequest & { warnings: string[] })[]> {
  // Get direct reports
  const reports = await employeeService.getDirectReports(managerId);
  const reportIds = reports.map(r => r.id);

  // Include both direct-report requests AND requests delegated to this manager
  const result = await pool.query(
    `SELECT * FROM leave_requests
     WHERE status IN ('pending', 'partially_approved')
       AND manager_approval = 'pending'
       AND (
         employee_id = ANY($1)
         OR current_manager_approver_id = $2
       )
     ORDER BY created_at ASC`,
    [reportIds.length > 0 ? reportIds : [0], managerId]
  );

  // Attach warnings
  return result.rows.map((lr: LeaveRequest) => {
    const warnings: string[] = [];
    if (lr.team_capacity_warning) warnings.push('⚠ This request would breach 30% team capacity threshold.');
    if (lr.blackout_warning) warnings.push('⚠ This request falls during a blackout period. Override required to approve.');
    return { ...lr, warnings };
  });
}

export async function getPendingApprovalsForHR(): Promise<(LeaveRequest & { warnings: string[] })[]> {
  // HR sees: (1) dual-approval requests needing HR sign-off, AND
  // (2) manager/HR employees whose leave escalated up (Rule 5)
  const result = await pool.query(
    `SELECT lr.*, e.name as employee_name, e.department
     FROM leave_requests lr
     JOIN employees e ON lr.employee_id = e.id
     WHERE lr.status IN ('pending', 'partially_approved')
       AND (
         (lr.requires_dual_approval = TRUE AND lr.hr_approval = 'pending')
         OR
         (e.role IN ('manager', 'hr') AND lr.manager_approval = 'pending')
       )
     ORDER BY lr.created_at ASC`
  );

  return result.rows.map((lr: LeaveRequest) => {
    const warnings: string[] = [];
    if (lr.team_capacity_warning) warnings.push('⚠ This request would breach 30% team capacity threshold.');
    if (lr.blackout_warning) warnings.push('⚠ This request falls during a blackout period. Override required to approve.');
    return { ...lr, warnings };
  });
}

// ─── Approve Leave ───────────────────────────────────────────────────────────

export async function approveLeave(
  leaveRequestId: number,
  approverId: number,
  comments?: string,
  blackoutOverride?: boolean
): Promise<{ leaveRequest: LeaveRequest; message: string }> {
  const leaveRequest = await getLeaveRequestById(leaveRequestId);
  if (!leaveRequest) throw new Error('Leave request not found');

  if (!['pending', 'partially_approved'].includes(leaveRequest.status)) {
    throw new Error(`Cannot approve a leave request with status "${leaveRequest.status}"`);
  }

  const approver = await employeeService.getEmployeeById(approverId);
  if (!approver) throw new Error('Approver not found');

  const requestor = await employeeService.getEmployeeById(leaveRequest.employee_id);
  if (!requestor) throw new Error('Requestor not found');

  // ── Rule 5: Cannot approve own leave ────────────────────────────────────
  if (approverId === leaveRequest.employee_id) {
    throw new Error('Cannot approve your own leave request');
  }

  // ── Blackout override check (Rule 6) ────────────────────────────────────
  if (leaveRequest.blackout_warning && !blackoutOverride) {
    throw new Error(
      'This leave falls during a blackout period. Set blackout_override=true to explicitly approve.'
    );
  }

  // ── Determine role of approver ──────────────────────────────────────────
  let roleType: 'manager' | 'hr';

  if (approver.role === 'hr') {
    // Rule 5: If the requestor is a manager/HR and HR is their reporting_manager
    // (or they have no manager), HR acts as the "manager" approver.
    const hrActsAsManager =
      (requestor.role === 'manager' || requestor.role === 'hr') &&
      (requestor.reporting_manager_id === approverId || requestor.reporting_manager_id === null);

    // Delegation chain: HR is the final fallback approver for delegation
    const hrIsDelegatedApprover = leaveRequest.current_manager_approver_id === approverId;

    if ((hrActsAsManager || hrIsDelegatedApprover) && leaveRequest.manager_approval === 'pending') {
      // HR fulfills the manager-role approval for escalated or delegated requests
      roleType = 'manager';
    } else {
      roleType = 'hr';
    }
  } else if (approver.role === 'manager') {
    // Verify this manager is the correct approver
    const isDirectManager = requestor.reporting_manager_id === approverId;
    // Rule 5: A manager's leave goes to their manager
    const isEscalatedManager = requestor.role === 'manager' && requestor.reporting_manager_id === approverId;
    // Delegation chain: this person was delegated as the current approver
    const isDelegatedApprover = leaveRequest.current_manager_approver_id === approverId;

    if (!isDirectManager && !isEscalatedManager && !isDelegatedApprover) {
      throw new Error('You are not authorized to approve this leave request');
    }
    roleType = 'manager';
  } else {
    throw new Error('Only managers and HR can approve leave requests');
  }

  // ── Record the approval action ──────────────────────────────────────────
  await pool.query(
    `INSERT INTO approval_actions (leave_request_id, approver_id, action, role_type, comments)
     VALUES ($1, $2, 'approved', $3, $4)`,
    [leaveRequestId, approverId, roleType, comments || null]
  );

  // ── Update approval status ──────────────────────────────────────────────
  if (roleType === 'manager') {
    await pool.query(
      `UPDATE leave_requests SET manager_approval = 'approved', blackout_override = $2, updated_at = NOW()
       WHERE id = $1`,
      [leaveRequestId, blackoutOverride || false]
    );
    leaveRequest.manager_approval = 'approved';
  } else {
    await pool.query(
      `UPDATE leave_requests SET hr_approval = 'approved', blackout_override = $2, updated_at = NOW()
       WHERE id = $1`,
      [leaveRequestId, blackoutOverride || false]
    );
    leaveRequest.hr_approval = 'approved';
  }

  // ── Check if fully approved ─────────────────────────────────────────────
  const updated = await getLeaveRequestById(leaveRequestId);
  if (!updated) throw new Error('Leave request disappeared');

  const managerDone = updated.manager_approval === 'approved';
  const hrDone = updated.hr_approval === 'approved' || updated.hr_approval === 'not_required';

  let finalStatus: LeaveRequest['status'];
  let message: string;

  if (managerDone && hrDone) {
    finalStatus = 'approved';
    message = 'Leave request fully approved.';
  } else {
    finalStatus = 'partially_approved';
    const pending = !managerDone ? 'manager' : 'HR';
    message = `Your approval recorded. Still waiting for ${pending} approval.`;
  }

  await withActor(approverId, async (client) => {
    await client.query(
      'UPDATE leave_requests SET status = $2, updated_at = NOW() WHERE id = $1',
      [leaveRequestId, finalStatus]
    );
  });

  const final = await getLeaveRequestById(leaveRequestId);
  if (!final) throw new Error('Leave request disappeared');

  // ── Emit event if fully approved ────────────────────────────────────────
  if (finalStatus === 'approved') {
    leaveEventBus.emitLeaveEvent({
      type: 'leave.approved',
      leaveRequest: final,
      actor_id: approverId,
    });
  }

  return { leaveRequest: final, message };
}

// ─── Reject Leave ────────────────────────────────────────────────────────────

export async function rejectLeave(
  leaveRequestId: number,
  approverId: number,
  reason: string,
  comments?: string
): Promise<LeaveRequest> {
  const leaveRequest = await getLeaveRequestById(leaveRequestId);
  if (!leaveRequest) throw new Error('Leave request not found');

  if (!['pending', 'partially_approved', 'pending_document'].includes(leaveRequest.status)) {
    throw new Error(`Cannot reject a leave request with status "${leaveRequest.status}"`);
  }

  const approver = await employeeService.getEmployeeById(approverId);
  if (!approver) throw new Error('Approver not found');

  if (approverId === leaveRequest.employee_id) {
    throw new Error('Cannot reject your own leave request. Use cancel instead.');
  }

  let roleType: 'manager' | 'hr';
  if (approver.role === 'hr') {
    // Rule 5: HR acts as manager for escalated manager/HR leave
    const requestor = await employeeService.getEmployeeById(leaveRequest.employee_id);
    const hrActsAsManager =
      requestor &&
      (requestor.role === 'manager' || requestor.role === 'hr') &&
      (requestor.reporting_manager_id === approverId || requestor.reporting_manager_id === null);
    // Delegation chain: HR is the final fallback approver
    const hrIsDelegatedApprover = leaveRequest.current_manager_approver_id === approverId;
    if ((hrActsAsManager || hrIsDelegatedApprover) && leaveRequest.manager_approval === 'pending') {
      roleType = 'manager';
    } else {
      roleType = 'hr';
    }
  } else if (approver.role === 'manager') {
    // Allow delegated approvers to reject
    const isDelegatedApprover = leaveRequest.current_manager_approver_id === approverId;
    const requestor = await employeeService.getEmployeeById(leaveRequest.employee_id);
    const isDirectManager = requestor?.reporting_manager_id === approverId;
    if (!isDirectManager && !isDelegatedApprover) {
      throw new Error('You are not authorized to reject this leave request');
    }
    roleType = 'manager';
  } else {
    throw new Error('Only managers and HR can reject leave requests');
  }

  // Record the rejection action
  await pool.query(
    `INSERT INTO approval_actions (leave_request_id, approver_id, action, role_type, comments)
     VALUES ($1, $2, 'rejected', $3, $4)`,
    [leaveRequestId, approverId, roleType, comments || null]
  );

  // Either one can reject in dual-approval (Rule 2)
  await withActor(approverId, async (client) => {
    await client.query(
      `UPDATE leave_requests
       SET status = 'rejected',
           rejection_reason = $2,
           ${roleType}_approval = 'rejected',
           updated_at = NOW()
       WHERE id = $1`,
      [leaveRequestId, reason]
    );
  });

  const final = await getLeaveRequestById(leaveRequestId);
  if (!final) throw new Error('Leave request disappeared');

  leaveEventBus.emitLeaveEvent({
    type: 'leave.rejected',
    leaveRequest: final,
    actor_id: approverId,
    metadata: { reason, roleType },
  });

  return final;
}

// ─── Cancel Leave ────────────────────────────────────────────────────────────

export async function cancelLeave(leaveRequestId: number, employeeId: number): Promise<LeaveRequest> {
  const leaveRequest = await getLeaveRequestById(leaveRequestId);
  if (!leaveRequest) throw new Error('Leave request not found');

  if (leaveRequest.employee_id !== employeeId) {
    throw new Error('You can only cancel your own leave requests');
  }

  if (leaveRequest.status === 'cancelled' || leaveRequest.status === 'rejected') {
    throw new Error(`Cannot cancel a leave request with status "${leaveRequest.status}"`);
  }

  await withActor(employeeId, async (client) => {
    await client.query(
      "UPDATE leave_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [leaveRequestId]
    );
  });

  const final = await getLeaveRequestById(leaveRequestId);
  if (!final) throw new Error('Leave request disappeared');

  leaveEventBus.emitLeaveEvent({
    type: 'leave.cancelled',
    leaveRequest: final,
    actor_id: employeeId,
  });

  return final;
}

// ─── Upload Medical Document (Rule 4) ────────────────────────────────────────

export async function uploadMedicalDocument(
  leaveRequestId: number,
  employeeId: number,
  documentUrl: string
): Promise<LeaveRequest> {
  const leaveRequest = await getLeaveRequestById(leaveRequestId);
  if (!leaveRequest) throw new Error('Leave request not found');

  if (leaveRequest.employee_id !== employeeId) {
    throw new Error('You can only upload documents for your own leave requests');
  }

  if (leaveRequest.status !== 'pending_document') {
    throw new Error('This leave request is not awaiting a medical document');
  }

  // Move to pending (for approval)
  await withActor(employeeId, async (client) => {
    await client.query(
      `UPDATE leave_requests
       SET medical_document_url = $2, status = 'pending', updated_at = NOW()
       WHERE id = $1`,
      [leaveRequestId, documentUrl]
    );
  });

  const updated = await getLeaveRequestById(leaveRequestId);
  return updated!;
}

// ─── Reassign pending approvals (for manager going on leave) ─────────────────

export async function reassignPendingApprovals(managerId: number, startDate: Date, endDate: Date): Promise<number> {
  const manager = await employeeService.getEmployeeById(managerId);
  if (!manager) return 0;

  // Find pending requests where this manager is the current approver
  const result = await pool.query(
    `SELECT lr.* FROM leave_requests lr
     WHERE lr.current_manager_approver_id = $1
       AND lr.status IN ('pending', 'partially_approved')
       AND lr.manager_approval = 'pending'`,
    [managerId]
  );

  // Also find requests from direct reports that don't yet have a current_manager_approver_id set
  const fallback = await pool.query(
    `SELECT lr.* FROM leave_requests lr
     JOIN employees e ON lr.employee_id = e.id
     WHERE e.reporting_manager_id = $1
       AND lr.status IN ('pending', 'partially_approved')
       AND lr.manager_approval = 'pending'
       AND lr.current_manager_approver_id IS NULL`,
    [managerId]
  );

  const allRequests = [...result.rows, ...fallback.rows];
  if (allRequests.length === 0) return 0;

  let delegated = 0;
  for (const lr of allRequests) {
    const delegationResult = await delegationService.findNextAvailableApprover(
      managerId,
      new Date(lr.start_date),
      new Date(lr.end_date),
      'on_leave',
      lr.escalation_count || 0
    );

    if (delegationResult) {
      await delegationService.delegateApproval(lr.id, delegationResult);
      delegated++;
    }
  }

  return delegated;
}

// ─── Re-evaluate flagged requests (after cancellation frees capacity) ────────

export async function reevaluateCapacityWarnings(department: string): Promise<number> {
  // Find pending requests with capacity warnings
  const result = await pool.query(
    `SELECT lr.* FROM leave_requests lr
     JOIN employees e ON lr.employee_id = e.id
     WHERE e.department = $1
       AND lr.team_capacity_warning = TRUE
       AND lr.status IN ('pending', 'partially_approved')`,
    [department]
  );

  let cleared = 0;
  const teamSize = await employeeService.getTeamSize(department);

  for (const lr of result.rows) {
    const check = await availabilityService.checkTeamCapacity(
      department, lr.employee_id, new Date(lr.start_date), new Date(lr.end_date), teamSize
    );

    if (!check.wouldBreach) {
      await pool.query(
        'UPDATE leave_requests SET team_capacity_warning = FALSE, updated_at = NOW() WHERE id = $1',
        [lr.id]
      );
      cleared++;
    }
  }

  return cleared;
}
