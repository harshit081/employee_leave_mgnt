import pool from '../config/database';
import { LeaveBalance, LeaveType } from '../types';

export async function getBalance(employeeId: number, leaveType: LeaveType, year: number): Promise<LeaveBalance | null> {
  const result = await pool.query(
    'SELECT * FROM leave_balances WHERE employee_id = $1 AND leave_type = $2 AND year = $3',
    [employeeId, leaveType, year]
  );
  return result.rows[0] || null;
}

export async function getAllBalances(employeeId: number, year: number): Promise<LeaveBalance[]> {
  const result = await pool.query(
    'SELECT * FROM leave_balances WHERE employee_id = $1 AND year = $2 ORDER BY leave_type',
    [employeeId, year]
  );
  return result.rows;
}

export async function deductBalance(employeeId: number, leaveType: LeaveType, year: number, days: number): Promise<void> {
  const result = await pool.query(
    `UPDATE leave_balances
     SET used_days = used_days + $4
     WHERE employee_id = $1 AND leave_type = $2 AND year = $3
     RETURNING *`,
    [employeeId, leaveType, year, days]
  );
  if (result.rowCount === 0) {
    throw new Error(`No balance record found for employee ${employeeId}, ${leaveType}, ${year}`);
  }
  const updated = result.rows[0];
  if (updated.used_days > updated.total_days) {
    throw new Error(`Insufficient ${leaveType} leave balance for employee ${employeeId}`);
  }
}

export async function creditBalance(employeeId: number, leaveType: LeaveType, year: number, days: number): Promise<void> {
  await pool.query(
    `UPDATE leave_balances
     SET used_days = GREATEST(0, used_days - $4)
     WHERE employee_id = $1 AND leave_type = $2 AND year = $3`,
    [employeeId, leaveType, year, days]
  );
}

export async function hasEnoughBalance(employeeId: number, leaveType: LeaveType, year: number, days: number): Promise<boolean> {
  const balance = await getBalance(employeeId, leaveType, year);
  if (!balance) return false;
  return (balance.total_days - balance.used_days) >= days;
}
