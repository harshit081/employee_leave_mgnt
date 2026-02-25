import express from 'express';
import dotenv from 'dotenv';
import { errorHandler, notFound } from './middleware/errorHandler';
import employeeRoutes from './routes/employee.routes';
import leaveRoutes from './routes/leave.routes';
import blackoutRoutes from './routes/blackout.routes';
import { registerAllHandlers } from './events/register';
import { startScheduledJobs } from './jobs/scheduler';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '8000');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/employees', employeeRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/blackout-periods', blackoutRoutes);

// ─── Error handling ──────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────────────────────────────
registerAllHandlers();
startScheduledJobs();

app.listen(PORT, () => {
  console.log(`\n🚀 Smart Leave Approval System running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Employees: http://localhost:${PORT}/api/employees`);
  console.log(`   Leaves: http://localhost:${PORT}/api/leaves`);
  console.log(`   Blackouts: http://localhost:${PORT}/api/blackout-periods\n`);
});

export default app;
