import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as ctrl from '../controllers/leave.controller';

const router = Router();

// Leave requests
router.post('/', asyncHandler(ctrl.createLeaveRequest));
router.get('/:id', asyncHandler(ctrl.getLeaveRequest));
router.get('/employee/:employeeId', asyncHandler(ctrl.getMyLeaveRequests));

// Approval / Rejection / Cancellation
router.post('/:id/approve', asyncHandler(ctrl.approveLeave));
router.post('/:id/reject', asyncHandler(ctrl.rejectLeave));
router.post('/:id/cancel', asyncHandler(ctrl.cancelLeave));

// Medical document upload (Rule 4)
router.post('/:id/document', asyncHandler(ctrl.uploadDocument));

// Pending approvals
router.get('/pending/manager/:managerId', asyncHandler(ctrl.getPendingApprovalsForManager));
router.get('/pending/hr', asyncHandler(ctrl.getPendingApprovalsForHR));

// Notifications
router.get('/notifications/:employeeId', asyncHandler(ctrl.getNotifications));
router.patch('/notifications/:id/read', asyncHandler(ctrl.markNotificationRead));

export default router;
