/**
 * RetryScheduler - Persistent retry queue for failed webhooks
 *
 * When immediate retries (seconds-scale) are exhausted and a webhook still fails,
 * it's added to a persistent JSONL queue file. The scheduler checks the queue
 * every 60 seconds and retries at increasing intervals:
 *   - 1st deferred: 5 minutes
 *   - 2nd deferred: 30 minutes
 *   - 3rd deferred: 1 hour
 *
 * After all deferred attempts fail, the entry is removed and a final history
 * entry is written. Queue entries survive app restarts.
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './utils/debug.ts';
import { executeWebhookRequest, createWebhookHistoryEntry, nodeDnsResolveAll } from './webhook-utils.ts';
import { AUTOMATIONS_RETRY_QUEUE_FILE } from './constants.ts';
import { appendAutomationHistoryEntry } from './history-store.ts';
import type { WebhookAction, WebhookActionResult } from './types.ts';

const log = createLogger('retry-scheduler');

/**
 * Build the env for a deferred retry: merge the non-secret WEFT_* system env
 * captured at enqueue time with the live WEFT_WH_* webhook secrets re-read from
 * process.env. SECURITY (audit B1): no secret values are persisted to the
 * queue file — only the unexpanded action (templates intact) + non-secret
 * system env; the WEFT_WH_* secrets are re-read from process.env at retry time.
 */
function buildRetryEnv(systemEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...systemEnv };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('WEFT_WH_') && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// Deferred retry delays: 5m, 30m, 1h
const DEFERRED_DELAYS_MS = [
  5 * 60_000,    // 5 minutes
  30 * 60_000,   // 30 minutes
  60 * 60_000,   // 1 hour
];

const MAX_DEFERRED_ATTEMPTS = DEFERRED_DELAYS_MS.length;

/** Queue tick interval (how often we check the queue file) */
const TICK_INTERVAL_MS = 60_000; // 1 minute

// ============================================================================
// Queue Entry
// ============================================================================

export interface RetryQueueEntry {
  /** Unique entry ID */
  id: string;
  /** Matcher ID (for history correlation) */
  matcherId: string;
  /** The UNEXPANDED webhook action (templates intact); secrets are re-read
   *  from process.env at retry time so no secret values are persisted. */
  action: WebhookAction;
  /** Non-secret WEFT_* system env captured at enqueue time (event-derived
   *  metadata); merged with live WEFT_WH_* secrets at retry (buildRetryEnv). */
  systemEnv: Record<string, string>;
  /** Redacted URL of the last attempt (safe for logging/persistence). */
  expandedUrl: string;
  /** Number of deferred attempts already made (0 = first deferred pending) */
  deferredAttempt: number;
  /** Timestamp when the next retry should happen */
  nextRetryAt: number;
  /** Timestamp when this entry was created */
  createdAt: number;
  /** Last error message */
  lastError?: string;
}

// ============================================================================
// RetryScheduler
// ============================================================================

export interface RetrySchedulerOptions {
  workspaceRootPath: string;
}

export class RetryScheduler {
  private readonly workspaceRootPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(options: RetrySchedulerOptions) {
    this.workspaceRootPath = options.workspaceRootPath;
  }

  /**
   * Start the scheduler. Checks queue every minute.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    log.debug('[RetryScheduler] Started');
    // Run an initial tick after a short delay (don't block startup)
    setTimeout(() => this.tick(), 5_000);
  }

  /**
   * Stop the scheduler and clean up.
   */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.debug('[RetryScheduler] Disposed');
  }

  /**
   * Enqueue a failed webhook for deferred retry.
   * Called by WebhookHandler when immediate retries are exhausted.
   */
  async enqueue(
    matcherId: string,
    action: WebhookAction,
    systemEnv: Record<string, string>,
    redactedUrl: string,
    lastError?: string,
  ): Promise<void> {
    const entry: RetryQueueEntry = {
      id: `${matcherId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      matcherId,
      action,
      systemEnv,
      expandedUrl: redactedUrl,
      deferredAttempt: 0,
      nextRetryAt: Date.now() + DEFERRED_DELAYS_MS[0]!,
      createdAt: Date.now(),
      lastError,
    };

    const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);
    // SECURITY (audit B1): the queue file may contain webhook auth templates; it
    // must be owner-only (0600) in a 0700 workspace dir, matching the encrypted
    // credential backend's discipline — never world-readable.
    try { mkdirSync(this.workspaceRootPath, { recursive: true, mode: 0o700 }) } catch { /* best effort */ }
    try { chmodSync(this.workspaceRootPath, 0o700) } catch { /* best effort */ }
    await appendFile(queuePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 });
    // SECURITY (audit B1): appendFile's `mode` only applies on fresh creation — a
    // pre-existing queue file created by pre-fix code (default 0644) retains its
    // looser mode. chmodSync tightens it to 0600 on every append regardless.
    try { chmodSync(queuePath, 0o600) } catch { /* best effort */ }
    log.debug(`[RetryScheduler] Enqueued ${entry.id} — next retry in ${DEFERRED_DELAYS_MS[0]! / 60_000}m`);
  }

  /**
   * Process the queue: read entries, retry those that are due, rewrite the queue.
   */
  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const queuePath = join(this.workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE);

      // Read queue
      let raw: string;
      try {
        raw = await readFile(queuePath, 'utf-8');
      } catch {
        // No queue file — nothing to do
        return;
      }

      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return;

      const entries: RetryQueueEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as RetryQueueEntry);
        } catch {
          // Skip malformed lines
        }
      }

      if (entries.length === 0) return;

      const now = Date.now();
      const remaining: RetryQueueEntry[] = [];

      for (const entry of entries) {
        if (entry.nextRetryAt > now) {
          // Not due yet — keep in queue
          remaining.push(entry);
          continue;
        }

        // Attempt retry — re-expand the unexpanded action with the live
        // WEFT_WH_* secrets from process.env + the captured system env.
        log.debug(`[RetryScheduler] Retrying ${entry.id} (deferred attempt ${entry.deferredAttempt + 1}/${MAX_DEFERRED_ATTEMPTS})`);
        let result: WebhookActionResult;
        try {
          result = await executeWebhookRequest(entry.action, { timeoutMs: 30_000, resolveIps: nodeDnsResolveAll, env: buildRetryEnv(entry.systemEnv) });
        } catch (err) {
          result = {
            type: 'webhook',
            url: entry.expandedUrl,
            statusCode: 0,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }

        if (result.success) {
          // Success — write history entry and drop from queue
          log.debug(`[RetryScheduler] ${entry.id} succeeded on deferred attempt ${entry.deferredAttempt + 1}`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: true,
            method: entry.action.method,
            url: entry.expandedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          // Don't add to remaining — drop from queue
        } else if (entry.deferredAttempt + 1 >= MAX_DEFERRED_ATTEMPTS) {
          // Final attempt failed — write permanent failure to history
          log.debug(`[RetryScheduler] ${entry.id} permanently failed after ${MAX_DEFERRED_ATTEMPTS} deferred attempts`);
          const historyEntry = createWebhookHistoryEntry({
            matcherId: entry.matcherId,
            ok: false,
            method: entry.action.method,
            url: entry.expandedUrl,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            attempts: entry.deferredAttempt + 1,
            error: result.error ?? 'Unknown error',
          });
          try {
            await appendAutomationHistoryEntry(this.workspaceRootPath, historyEntry);
          } catch (e) {
            log.debug(`[RetryScheduler] Failed to write history: ${e}`);
          }
          // Don't add to remaining — drop from queue
        } else {
          // Still retryable — schedule next deferred attempt
          const nextDelay = DEFERRED_DELAYS_MS[entry.deferredAttempt + 1]!;
          remaining.push({
            ...entry,
            deferredAttempt: entry.deferredAttempt + 1,
            nextRetryAt: Date.now() + nextDelay,
            lastError: result.error,
          });
          log.debug(`[RetryScheduler] ${entry.id} failed — next retry in ${nextDelay / 60_000}m`);
        }
      }

      // Rewrite queue file with remaining entries (mode 0o600 — see enqueue)
      if (remaining.length === 0) {
        await writeFile(queuePath, '', { encoding: 'utf-8', mode: 0o600 });
      } else {
        const content = `${remaining.map(e => JSON.stringify(e)).join('\n')}\n`;
        await writeFile(queuePath, content, { encoding: 'utf-8', mode: 0o600 });
      }
      // SECURITY (audit B1): writeFile's `mode` only applies on fresh creation —
      // tighten the pre-existing file's mode regardless (see enqueue).
      try { chmodSync(queuePath, 0o600) } catch { /* best effort */ }
    } catch (err) {
      log.debug(`[RetryScheduler] Tick error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

}
