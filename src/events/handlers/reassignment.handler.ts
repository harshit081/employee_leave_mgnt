import { LeaveEvent } from '../../types';
import * as employeeService from '../../services/employee.service';
import * as leaveService from '../../services/leave.service';

/**
 * If an approved person is a manager, check for pending approvals during their leave
 * and reassign them.
 */
export async function handleManagerReassignment(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  const employee = await employeeService.getEmployeeById(lr.employee_id);

  if (!employee || employee.role !== 'manager') return;

  const reassigned = await leaveService.reassignPendingApprovals(
    employee.id,
    new Date(lr.start_date),
    new Date(lr.end_date)
  );

  if (reassigned > 0) {
    console.log(`[ReassignmentHandler] Reassigned ${reassigned} pending approval(s) from manager #${employee.id}`);
  }
}
