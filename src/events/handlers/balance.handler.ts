import { LeaveEvent } from '../../types';
import * as balanceService from '../../services/balance.service';
import { countBusinessDays } from '../../utils/helpers';

/**
 * Deduct leave balance when a request is approved.
 */
export async function handleBalanceDeduction(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  const days = countBusinessDays(new Date(lr.start_date), new Date(lr.end_date));
  const year = new Date(lr.start_date).getFullYear();

  await balanceService.deductBalance(lr.employee_id, lr.leave_type, year, days);
  console.log(`[BalanceHandler] Deducted ${days} ${lr.leave_type} day(s) for employee #${lr.employee_id}`);
}

/**
 * Credit leave balance back when a previously-approved request is cancelled.
 */
export async function handleBalanceCredit(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  // Only credit back if it was previously approved (cancellation after approval)
  const days = countBusinessDays(new Date(lr.start_date), new Date(lr.end_date));
  const year = new Date(lr.start_date).getFullYear();

  await balanceService.creditBalance(lr.employee_id, lr.leave_type, year, days);
  console.log(`[BalanceHandler] Credited ${days} ${lr.leave_type} day(s) back to employee #${lr.employee_id}`);
}
