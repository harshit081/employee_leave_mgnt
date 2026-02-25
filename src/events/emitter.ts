import { EventEmitter } from 'events';
import { LeaveEvent } from '../types';

/**
 * Application-wide event bus for leave lifecycle events.
 *
 * Design decisions:
 * - Using Node's built-in EventEmitter for simplicity (no external MQ needed).
 * - All handlers run asynchronously and do NOT block the API response.
 * - Each handler catches its own errors — one failing handler doesn't affect others.
 * - If a downstream action fails, it logs the error for retry via a separate mechanism.
 *   The approval itself is NOT rolled back, because the approval is the source-of-truth
 *   state change; downstream effects are eventual-consistency operations.
 * - Adding a new downstream action = registering a new handler. No approval code changes.
 */

class LeaveEventBus extends EventEmitter {
  emitLeaveEvent(event: LeaveEvent) {
    console.log(`[EventBus] Emitting ${event.type} for leave #${event.leaveRequest.id}`);
    this.emit(event.type, event);
  }

  /**
   * Register a handler that runs asynchronously and catches its own errors.
   */
  onLeaveEvent(eventType: LeaveEvent['type'], handler: (event: LeaveEvent) => Promise<void>) {
    this.on(eventType, (event: LeaveEvent) => {
      // Fire-and-forget with error isolation
      handler(event).catch((err) => {
        console.error(
          `[EventBus] Handler failed for ${eventType} on leave #${event.leaveRequest.id}:`,
          err.message
        );
        // In production: push to a dead-letter queue / retry table
      });
    });
  }
}

export const leaveEventBus = new LeaveEventBus();
