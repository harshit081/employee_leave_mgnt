import { LeaveEvent } from '../../types';
import * as availabilityService from '../../services/availability.service';
import * as employeeService from '../../services/employee.service';
import * as leaveService from '../../services/leave.service';

/**
 * Update team availability when leave is approved.
 */
export async function handleAvailabilityUpdate(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  const employee = await employeeService.getEmployeeById(lr.employee_id);
  if (!employee) return;

  await availabilityService.addLeaveToAvailability(
    employee.department,
    employee.id,
    lr.id,
    new Date(lr.start_date),
    new Date(lr.end_date)
  );

  console.log(`[AvailabilityHandler] Updated team availability for leave #${lr.id}`);
}

/**
 * Remove from team availability on cancellation, then re-evaluate warnings.
 */
export async function handleAvailabilityRemoval(event: LeaveEvent): Promise<void> {
  const lr = event.leaveRequest;
  const employee = await employeeService.getEmployeeById(lr.employee_id);
  if (!employee) return;

  await availabilityService.removeLeaveFromAvailability(lr.id);

  // Re-evaluate capacity warnings for pending requests in this department
  const cleared = await leaveService.reevaluateCapacityWarnings(employee.department);
  if (cleared > 0) {
    console.log(`[AvailabilityHandler] Cleared capacity warnings for ${cleared} request(s) in ${employee.department}`);
  }

  console.log(`[AvailabilityHandler] Removed availability for cancelled leave #${lr.id}`);
}
