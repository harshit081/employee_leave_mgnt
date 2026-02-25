import { leaveEventBus } from './emitter';
import { handleBalanceDeduction, handleBalanceCredit } from './handlers/balance.handler';
import { handleApprovalNotification, handleRejectionNotification, handleCancellationNotification } from './handlers/notification.handler';
import { handleAvailabilityUpdate, handleAvailabilityRemoval } from './handlers/availability.handler';
import { handleManagerReassignment } from './handlers/reassignment.handler';

/**
 * Register all event handlers.
 *
 * Each handler is isolated — if one fails, the others still run.
 * The approval/rejection/cancellation is the source-of-truth DB state change.
 * Downstream effects (notifications, balance, availability) are eventual-consistency.
 *
 * To add a new downstream action: just register a new handler here.
 * No changes needed in approval logic.
 */
export function registerAllHandlers() {
  // ── On Approval ──────────────────────────────────────────────────────────
  leaveEventBus.onLeaveEvent('leave.approved', handleBalanceDeduction);
  leaveEventBus.onLeaveEvent('leave.approved', handleApprovalNotification);
  leaveEventBus.onLeaveEvent('leave.approved', handleAvailabilityUpdate);
  leaveEventBus.onLeaveEvent('leave.approved', handleManagerReassignment);

  // ── On Rejection ─────────────────────────────────────────────────────────
  leaveEventBus.onLeaveEvent('leave.rejected', handleRejectionNotification);

  // ── On Cancellation ──────────────────────────────────────────────────────
  leaveEventBus.onLeaveEvent('leave.cancelled', handleBalanceCredit);
  leaveEventBus.onLeaveEvent('leave.cancelled', handleCancellationNotification);
  leaveEventBus.onLeaveEvent('leave.cancelled', handleAvailabilityRemoval);

  console.log('[EventBus] All handlers registered');
}
