import pool from '../config/database';

/*
  Seed Data:
  - 3 departments: Engineering, Finance, Marketing
  - HR person (reports to no one)
  - 3 managers (1 per department), each reports to HR or has no manager
  - 12 employees spread across departments
  - Leave balances for current year (2026)
  - Blackout periods for Finance (month-end) and Engineering (launch week)
*/

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Clear existing data ──────────────────────────────────────────────────
    await client.query('DELETE FROM team_availability');
    await client.query('DELETE FROM notifications');
    await client.query('DELETE FROM approval_actions');
    await client.query('DELETE FROM leave_requests');
    await client.query('DELETE FROM leave_balances');
    await client.query('DELETE FROM blackout_periods');
    await client.query('DELETE FROM employees');

    // Reset sequences
    await client.query("ALTER SEQUENCE employees_id_seq RESTART WITH 1");
    await client.query("ALTER SEQUENCE leave_balances_id_seq RESTART WITH 1");
    await client.query("ALTER SEQUENCE blackout_periods_id_seq RESTART WITH 1");

    // ── HR ────────────────────────────────────────────────────────────────────
    const hrResult = await client.query(
      `INSERT INTO employees (name, email, role, department, reporting_manager_id)
       VALUES ('Priya Sharma', 'priya.sharma@company.com', 'hr', 'HR', NULL)
       RETURNING id`
    );
    const hrId = hrResult.rows[0].id;

    // ── Managers ─────────────────────────────────────────────────────────────
    const mgr1 = await client.query(
      `INSERT INTO employees (name, email, role, department, reporting_manager_id)
       VALUES ('Rajesh Kumar', 'rajesh.kumar@company.com', 'manager', 'Engineering', $1)
       RETURNING id`, [hrId]
    );
    const engMgrId = mgr1.rows[0].id;

    const mgr2 = await client.query(
      `INSERT INTO employees (name, email, role, department, reporting_manager_id)
       VALUES ('Anita Desai', 'anita.desai@company.com', 'manager', 'Finance', $1)
       RETURNING id`, [hrId]
    );
    const finMgrId = mgr2.rows[0].id;

    const mgr3 = await client.query(
      `INSERT INTO employees (name, email, role, department, reporting_manager_id)
       VALUES ('Vikram Patel', 'vikram.patel@company.com', 'manager', 'Marketing', $1)
       RETURNING id`, [hrId]
    );
    const mktMgrId = mgr3.rows[0].id;

    // ── Employees ────────────────────────────────────────────────────────────
    const employees = [
      // Engineering (4 employees + 1 manager = 5 total)
      ['Amit Verma',     'amit.verma@company.com',     'employee', 'Engineering', engMgrId],
      ['Sneha Reddy',    'sneha.reddy@company.com',    'employee', 'Engineering', engMgrId],
      ['Karan Singh',    'karan.singh@company.com',    'employee', 'Engineering', engMgrId],
      ['Deepa Nair',     'deepa.nair@company.com',     'employee', 'Engineering', engMgrId],
      // Finance (4 employees + 1 manager = 5 total)
      ['Rohit Mehta',    'rohit.mehta@company.com',    'employee', 'Finance', finMgrId],
      ['Suman Joshi',    'suman.joshi@company.com',    'employee', 'Finance', finMgrId],
      ['Pooja Gupta',    'pooja.gupta@company.com',    'employee', 'Finance', finMgrId],
      ['Arjun Das',      'arjun.das@company.com',      'employee', 'Finance', finMgrId],
      // Marketing (4 employees + 1 manager = 5 total)
      ['Neha Kapoor',    'neha.kapoor@company.com',    'employee', 'Marketing', mktMgrId],
      ['Ravi Shankar',   'ravi.shankar@company.com',   'employee', 'Marketing', mktMgrId],
      ['Meera Iyer',     'meera.iyer@company.com',     'employee', 'Marketing', mktMgrId],
      ['Tarun Bhatia',   'tarun.bhatia@company.com',   'employee', 'Marketing', mktMgrId],
    ];

    for (const emp of employees) {
      await client.query(
        `INSERT INTO employees (name, email, role, department, reporting_manager_id)
         VALUES ($1, $2, $3, $4, $5)`,
        emp
      );
    }

    // ── Leave Balances (for all employees, current year 2026) ────────────────
    const allEmployeesResult = await client.query('SELECT id FROM employees');
    const currentYear = 2026;
    const leaveDefaults: [string, number][] = [
      ['casual', 12],
      ['sick', 8],
      ['earned', 15],
    ];

    for (const emp of allEmployeesResult.rows) {
      for (const [leaveType, totalDays] of leaveDefaults) {
        await client.query(
          `INSERT INTO leave_balances (employee_id, leave_type, year, total_days, used_days)
           VALUES ($1, $2, $3, $4, 0)`,
          [emp.id, leaveType, currentYear, totalDays]
        );
      }
    }

    // ── Blackout Periods ─────────────────────────────────────────────────────
    // Finance: month-end closing periods
    await client.query(
      `INSERT INTO blackout_periods (department, name, start_date, end_date, reason)
       VALUES
         ('Finance', 'Q1 Month-End Close', '2026-03-28', '2026-03-31', 'Quarterly financial closing — all hands needed'),
         ('Finance', 'Q2 Month-End Close', '2026-06-27', '2026-06-30', 'Quarterly financial closing — all hands needed'),
         ('Finance', 'Year-End Close',     '2026-12-28', '2026-12-31', 'Year-end financial closing')`
    );

    // Engineering: launch week
    await client.query(
      `INSERT INTO blackout_periods (department, name, start_date, end_date, reason)
       VALUES
         ('Engineering', 'Product Launch Week', '2026-04-13', '2026-04-17', 'Major product launch — engineering freeze'),
         ('Engineering', 'Hackathon Week',      '2026-09-07', '2026-09-11', 'Company hackathon — full participation expected')`
    );

    await client.query('COMMIT');
    console.log('✓ Seed data inserted successfully');
    console.log('  - 1 HR person');
    console.log('  - 3 managers (Engineering, Finance, Marketing)');
    console.log('  - 12 employees (4 per department)');
    console.log('  - Leave balances initialized for 2026');
    console.log('  - 5 blackout periods created');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
