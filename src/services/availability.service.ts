import pool from '../config/database';
import { getDateRange } from '../utils/helpers';

/**
 * Record that an employee will be on leave for the given dates.
 */
export async function addLeaveToAvailability(
  department: string,
  employeeId: number,
  leaveRequestId: number,
  startDate: Date,
  endDate: Date
): Promise<void> {
  const dates = getDateRange(startDate, endDate);
  for (const date of dates) {
    await pool.query(
      `INSERT INTO team_availability (department, date, employee_id, leave_request_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (department, date, employee_id) DO NOTHING`,
      [department, date, employeeId, leaveRequestId]
    );
  }
}

/**
 * Remove leave records from availability (e.g., on cancellation).
 */
export async function removeLeaveFromAvailability(leaveRequestId: number): Promise<void> {
  await pool.query(
    'DELETE FROM team_availability WHERE leave_request_id = $1',
    [leaveRequestId]
  );
}

/**
 * Get the count of employees on leave for a specific department and date.
 */
export async function getOnLeaveCount(department: string, date: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(DISTINCT employee_id) as count FROM team_availability WHERE department = $1 AND date = $2',
    [department, date]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Check if approving leave would breach 30% team capacity for any date in the range.
 * Returns the worst-case dates and percentages.
 */
export async function checkTeamCapacity(
  department: string,
  employeeId: number,
  startDate: Date,
  endDate: Date,
  teamSize: number
): Promise<{ wouldBreach: boolean; details: { date: string; onLeave: number; percentage: number }[] }> {
  const dates = getDateRange(startDate, endDate);
  const threshold = Math.floor(teamSize * 0.3);
  const details: { date: string; onLeave: number; percentage: number }[] = [];
  let wouldBreach = false;

  for (const date of dates) {
    const currentOnLeave = await getOnLeaveCount(department, date);
    // +1 for the new request
    const projected = currentOnLeave + 1;
    const percentage = Math.round((projected / teamSize) * 100);

    if (projected > threshold) {
      wouldBreach = true;
      details.push({ date, onLeave: projected, percentage });
    }
  }

  return { wouldBreach, details };
}
