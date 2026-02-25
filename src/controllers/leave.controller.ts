import { Request, Response } from 'express';
import * as leaveService from '../services/leave.service';
import * as notificationService from '../services/notification.service';

// ─── Create Leave Request ────────────────────────────────────────────────────

export async function createLeaveRequest(req: Request, res: Response) {
  const { employee_id, leave_type, start_date, end_date, reason } = req.body;

  if (!employee_id || !leave_type || !start_date || !end_date) {
    res.status(400).json({
      success: false,
      message: 'Required fields: employee_id, leave_type, start_date, end_date',
    });
    return;
  }

  if (!['sick', 'casual', 'earned'].includes(leave_type)) {
    res.status(400).json({ success: false, message: 'leave_type must be sick, casual, or earned' });
    return;
  }

  try {
    const result = await leaveService.createLeaveRequest({
      employee_id, leave_type, start_date, end_date, reason,
    });
    res.status(201).json({
      success: true,
      data: result.leaveRequest,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ─── Get Leave Requests ──────────────────────────────────────────────────────

export async function getLeaveRequest(req: Request, res: Response) {
  const id = parseInt(req.params.id as string);
  const lr = await leaveService.getLeaveRequestById(id);
  if (!lr) {
    res.status(404).json({ success: false, message: 'Leave request not found' });
    return;
  }
  res.json({ success: true, data: lr });
}

export async function getMyLeaveRequests(req: Request, res: Response) {
  const employeeId = parseInt(req.params.employeeId as string);
  const requests = await leaveService.getLeaveRequestsByEmployee(employeeId);
  res.json({ success: true, data: requests });
}

// ─── Pending Approvals ───────────────────────────────────────────────────────

export async function getPendingApprovalsForManager(req: Request, res: Response) {
  const managerId = parseInt(req.params.managerId as string);
  const requests = await leaveService.getPendingApprovalsForManager(managerId);
  res.json({ success: true, data: requests });
}

export async function getPendingApprovalsForHR(req: Request, res: Response) {
  const requests = await leaveService.getPendingApprovalsForHR();
  res.json({ success: true, data: requests });
}

// ─── Approve ─────────────────────────────────────────────────────────────────

export async function approveLeave(req: Request, res: Response) {
  const leaveRequestId = parseInt(req.params.id as string);
  const { approver_id, comments, blackout_override } = req.body;

  if (!approver_id) {
    res.status(400).json({ success: false, message: 'approver_id is required' });
    return;
  }

  try {
    const result = await leaveService.approveLeave(
      leaveRequestId, approver_id, comments, blackout_override
    );
    res.json({ success: true, data: result.leaveRequest, message: result.message });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ─── Reject ──────────────────────────────────────────────────────────────────

export async function rejectLeave(req: Request, res: Response) {
  const leaveRequestId = parseInt(req.params.id as string);
  const { approver_id, reason, comments } = req.body;

  if (!approver_id || !reason) {
    res.status(400).json({ success: false, message: 'approver_id and reason are required' });
    return;
  }

  try {
    const result = await leaveService.rejectLeave(leaveRequestId, approver_id, reason, comments);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

export async function cancelLeave(req: Request, res: Response) {
  const leaveRequestId = parseInt(req.params.id as string);
  const { employee_id } = req.body;

  if (!employee_id) {
    res.status(400).json({ success: false, message: 'employee_id is required' });
    return;
  }

  try {
    const result = await leaveService.cancelLeave(leaveRequestId, employee_id);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ─── Upload Medical Document ─────────────────────────────────────────────────

export async function uploadDocument(req: Request, res: Response) {
  const leaveRequestId = parseInt(req.params.id as string);
  const { employee_id, document_url } = req.body;

  if (!employee_id || !document_url) {
    res.status(400).json({ success: false, message: 'employee_id and document_url are required' });
    return;
  }

  try {
    const result = await leaveService.uploadMedicalDocument(leaveRequestId, employee_id, document_url);
    res.json({ success: true, data: result, message: 'Document uploaded. Leave request is now pending approval.' });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ─── Notifications ───────────────────────────────────────────────────────────

export async function getNotifications(req: Request, res: Response) {
  const employeeId = parseInt(req.params.employeeId as string);
  const unreadOnly = req.query.unread === 'true';
  const notifications = await notificationService.getNotifications(employeeId, unreadOnly);
  res.json({ success: true, data: notifications });
}

export async function markNotificationRead(req: Request, res: Response) {
  const id = parseInt(req.params.id as string);
  await notificationService.markAsRead(id);
  res.json({ success: true, message: 'Notification marked as read' });
}
