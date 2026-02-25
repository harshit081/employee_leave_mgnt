import pool from '../config/database';
import { Notification } from '../types';

/**
 * Create a notification record. In a real system this would also trigger
 * an email/Slack/push notification. Here we just persist it.
 */
export async function createNotification(
  employeeId: number,
  type: string,
  message: string,
  leaveRequestId?: number
): Promise<Notification> {
  const result = await pool.query(
    `INSERT INTO notifications (employee_id, type, message, related_leave_request_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [employeeId, type, message, leaveRequestId || null]
  );
  return result.rows[0];
}

export async function getNotifications(employeeId: number, unreadOnly = false): Promise<Notification[]> {
  let query = 'SELECT * FROM notifications WHERE employee_id = $1';
  if (unreadOnly) query += ' AND is_read = FALSE';
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, [employeeId]);
  return result.rows;
}

export async function markAsRead(notificationId: number): Promise<void> {
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1', [notificationId]);
}

export async function notifyTeam(department: string, message: string, leaveRequestId: number, excludeEmployeeId?: number): Promise<void> {
  const result = await pool.query(
    'SELECT id FROM employees WHERE department = $1' + (excludeEmployeeId ? ' AND id != $2' : ''),
    excludeEmployeeId ? [department, excludeEmployeeId] : [department]
  );

  for (const row of result.rows) {
    await createNotification(row.id, 'team_update', message, leaveRequestId);
  }
}
