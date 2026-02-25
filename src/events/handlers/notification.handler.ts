import { LeaveEvent } from '../../types';
import * as notificationService from '../../services/notification.service';
import * as employeeService from '../../services/employee.service';
import pool from '../../config/database';

/**
 * Notify the employee when their leave is approved.
 */
export async function handleApprovalNotification(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  await notificationService.createNotification(
    lr.employee_id,
    'leave_approved',
    `Your ${lr.leave_type} leave from ${lr.start_date} to ${lr.end_date} has been approved.`,
    lr.id
  );

  // Notify the team
  const employee = await employeeService.getEmployeeById(lr.employee_id);
  if (employee) {
    await notificationService.notifyTeam(
      employee.department,
      `${employee.name} will be on ${lr.leave_type} leave from ${lr.start_date} to ${lr.end_date}.`,
      lr.id,
      employee.id // exclude the employee themselves
    );
  }

  console.log(`[NotificationHandler] Sent approval notifications for leave #${lr.id}`);
}

/**
 * Notify the employee when their leave is rejected.
 * If dual-approval and one already approved, notify that approver too.
 */
export async function handleRejectionNotification(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  const reason = lr.rejection_reason || 'No reason provided';

  await notificationService.createNotification(
    lr.employee_id,
    'leave_rejected',
    `Your ${lr.leave_type} leave from ${lr.start_date} to ${lr.end_date} was rejected. Reason: ${reason}`,
    lr.id
  );

  // Rule 2 follow-up: If dual-approval and one already approved, notify them
  if (lr.requires_dual_approval) {
    const roleType = event.metadata?.roleType as string;
    // Find the other approver who already approved
    const otherApproval = await pool.query(
      `SELECT DISTINCT approver_id FROM approval_actions
       WHERE leave_request_id = $1
         AND action = 'approved'
         AND role_type != $2`,
      [lr.id, roleType]
    );

    for (const row of otherApproval.rows) {
      await notificationService.createNotification(
        row.approver_id,
        'dual_approval_rejected',
        `Leave request #${lr.id} that you approved was rejected by the other approver. Reason: ${reason}`,
        lr.id
      );
    }
  }

  console.log(`[NotificationHandler] Sent rejection notifications for leave #${lr.id}`);
}

/**
 * Notify the manager when an approved leave is cancelled.
 */
export async function handleCancellationNotification(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  const employee = await employeeService.getEmployeeById(lr.employee_id);
  if (!employee) return;

  // Notify the manager
  if (employee.reporting_manager_id) {
    await notificationService.createNotification(
      employee.reporting_manager_id,
      'leave_cancelled',
      `${employee.name} has cancelled their ${lr.leave_type} leave from ${lr.start_date} to ${lr.end_date}.`,
      lr.id
    );
  }

  console.log(`[NotificationHandler] Sent cancellation notifications for leave #${lr.id}`);
}
