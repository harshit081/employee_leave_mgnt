import pool from '../config/database';
import { BlackoutPeriod } from '../types';
import { datesOverlap } from '../utils/helpers';

export async function getBlackoutPeriods(department: string): Promise<BlackoutPeriod[]> {
  const result = await pool.query(
    'SELECT * FROM blackout_periods WHERE department = $1 ORDER BY start_date',
    [department]
  );
  return result.rows;
}

export async function checkBlackoutConflict(
  department: string,
  startDate: Date,
  endDate: Date
): Promise<BlackoutPeriod[]> {
  const result = await pool.query(
    `SELECT * FROM blackout_periods
     WHERE department = $1
       AND start_date <= $3
       AND end_date >= $2`,
    [department, startDate, endDate]
  );
  return result.rows;
}

export async function createBlackoutPeriod(
  department: string,
  name: string,
  startDate: string,
  endDate: string,
  reason?: string
): Promise<BlackoutPeriod> {
  const result = await pool.query(
    `INSERT INTO blackout_periods (department, name, start_date, end_date, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [department, name, startDate, endDate, reason || null]
  );
  return result.rows[0];
}

export async function deleteBlackoutPeriod(id: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM blackout_periods WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
