import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as LeaveController from '../controllers/leave.controller';

const router = Router();

// Leave requests
router.post('/', asyncHandler(LeaveController.createLeaveRequest));
router.get('/:id', asyncHandler(LeaveController.getLeaveRequest));
router.get('/employee/:employeeId', asyncHandler(LeaveController.getMyLeaveRequests));

// Approval / Rejection / Cancellation
router.post('/:id/approve', asyncHandler(LeaveController.approveLeave));
router.post('/:id/reject', asyncHandler(LeaveController.rejectLeave));
router.post('/:id/cancel', asyncHandler(LeaveController.cancelLeave));

// Medical document upload (Rule 4)
router.post('/:id/document', asyncHandler(LeaveController.uploadDocument));

// Delegation history
router.get('/:id/delegation-history', asyncHandler(LeaveController.getDelegationHistory));

// Status audit log (append-only)
router.get('/:id/status-log', asyncHandler(LeaveController.getStatusLog));

// Pending approvals
router.get('/pending/manager/:managerId', asyncHandler(LeaveController.getPendingApprovalsForManager));
router.get('/pending/hr', asyncHandler(LeaveController.getPendingApprovalsForHR));

// Notifications
router.get('/notifications/:employeeId', asyncHandler(LeaveController.getNotifications));
router.patch('/notifications/:id/read', asyncHandler(LeaveController.markNotificationRead));

export default router;
