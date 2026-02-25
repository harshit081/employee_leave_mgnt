import pool from '../config/database';
import { Employee } from '../types';

export async function getAllEmployees(): Promise<Employee[]> {
  const result = await pool.query(
    `SELECT e.*, m.name as manager_name
     FROM employees e
     LEFT JOIN employees m ON e.reporting_manager_id = m.id
     ORDER BY e.id`
  );
  return result.rows;
}

export async function getEmployeeById(id: number): Promise<Employee | null> {
  const result = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getDirectReports(managerId: number): Promise<Employee[]> {
  const result = await pool.query(
    'SELECT * FROM employees WHERE reporting_manager_id = $1',
    [managerId]
  );
  return result.rows;
}

export async function getTeamMembers(department: string): Promise<Employee[]> {
  const result = await pool.query(
    'SELECT * FROM employees WHERE department = $1',
    [department]
  );
  return result.rows;
}

export async function getTeamSize(department: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM employees WHERE department = $1',
    [department]
  );
  return parseInt(result.rows[0].count);
}

export async function getHREmployees(): Promise<Employee[]> {
  const result = await pool.query("SELECT * FROM employees WHERE role = 'hr'");
  return result.rows;
}

/**
 * Find who should approve a given employee's leave.
 * Rule 5: Manager can't approve their own leave.
 * - Normal employee → their reporting manager
 * - Manager → their reporting manager (or HR if none)
 */
export async function getApproverFor(employee: Employee): Promise<{ managerId: number | null; needsHRAsManager: boolean }> {
  if (employee.role === 'manager' || employee.role === 'hr') {
    // Rule 5: escalate up
    if (employee.reporting_manager_id) {
      return { managerId: employee.reporting_manager_id, needsHRAsManager: false };
    }
    // No manager above → HR acts as approver
    return { managerId: null, needsHRAsManager: true };
  }
  return { managerId: employee.reporting_manager_id, needsHRAsManager: false };
}
