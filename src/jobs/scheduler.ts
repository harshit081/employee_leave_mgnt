import cron from 'node-cron';
import pool from '../config/database';
import * as notificationService from '../services/notification.service';
import * as delegationService from '../services/delegation.service';

/**
 * Scheduled jobs for the leave management system.
 *
 * Rule 4 — Sick leave document handling:
 * - Document deadline: 3 days after request creation.
 * - Reminder 1: sent at ≈24 hours before deadline.
 * - Reminder 2: sent at ≈12 hours before deadline.
 * - Auto-reject: when deadline passes.
 *
 * Delegation Chain — 48h stale approval escalation:
 * - When a leave request's current approver hasn't responded within
 *   48 hours, automatically delegate to the next person up the chain.
 *
 * Runs every hour for documents, every 30 min for stale approvals.
 */

export function startScheduledJobs() {
  // Document deadline check — every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Scheduler] Running document deadline check...');
    await processDocumentDeadlines();
  });

  // Stale approval escalation — every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[Scheduler] Running stale approval escalation check...');
    try {
      const escalated = await delegationService.processStaleApprovals();
      if (escalated > 0) {
        console.log(`[Scheduler] Escalated ${escalated} stale approval(s)`);
      }
    } catch (err) {
      console.error('[Scheduler] Error processing stale approvals:', err);
    }
  });

  console.log('[Scheduler] Scheduled jobs started (document check hourly, stale approval check every 30min)');
}

async function processDocumentDeadlines() {
  try {
    // Find all pending_document requests
    const result = await pool.query(
      `SELECT lr.*, e.name as employee_name
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       WHERE lr.status = 'pending_document'
         AND lr.document_deadline IS NOT NULL`
    );

    const now = new Date();

    for (const lr of result.rows) {
      const deadline = new Date(lr.document_deadline);
      const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (hoursUntilDeadline <= 0) {
        // ── Auto-reject: deadline passed ────────────────────────────────
        await pool.query(
          `UPDATE leave_requests
           SET status = 'rejected',
               rejection_reason = 'Auto-rejected: medical document not uploaded within deadline (3 days)',
               updated_at = NOW()
           WHERE id = $1`,
          [lr.id]
        );

        await notificationService.createNotification(
          lr.employee_id,
          'document_expired',
          `Your sick leave request #${lr.id} has been auto-rejected because the medical document was not uploaded within the 3-day deadline.`,
          lr.id
        );

        console.log(`[Scheduler] Auto-rejected leave #${lr.id} — document deadline passed`);

      } else if (hoursUntilDeadline <= 12 && lr.document_reminder_count < 2) {
        // ── Reminder 2: 12 hours before deadline ────────────────────────
        await pool.query(
          'UPDATE leave_requests SET document_reminder_count = 2 WHERE id = $1',
          [lr.id]
        );

        await notificationService.createNotification(
          lr.employee_id,
          'document_reminder_urgent',
          `URGENT: Your sick leave request #${lr.id} requires a medical document. Only ${Math.round(hoursUntilDeadline)} hours remaining before auto-rejection.`,
          lr.id
        );

        console.log(`[Scheduler] Sent urgent reminder for leave #${lr.id}`);

      } else if (hoursUntilDeadline <= 24 && lr.document_reminder_count < 1) {
        // ── Reminder 1: 24 hours before deadline ────────────────────────
        await pool.query(
          'UPDATE leave_requests SET document_reminder_count = 1 WHERE id = $1',
          [lr.id]
        );

        await notificationService.createNotification(
          lr.employee_id,
          'document_reminder',
          `Reminder: Your sick leave request #${lr.id} requires a medical document. Please upload within ${Math.round(hoursUntilDeadline)} hours to avoid auto-rejection.`,
          lr.id
        );

        console.log(`[Scheduler] Sent reminder for leave #${lr.id}`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error processing document deadlines:', err);
  }
}
