/**
 * Scheduler Service Stub
 *
 * Provides scheduler service interface used by automations.
 * Stubbed for OSS extraction — the real scheduler runs cron jobs via node-cron.
 */

/**
 * Payload delivered on each scheduler tick.
 */
export interface SchedulerTickPayload {
  /** Workspace root path for resolving automations */
  workspaceRootPath: string;
  /** Timestamp of the tick (ISO string for UTC time) */
  utcTime: string;
  /** Local time as ISO string */
  localTime: string;
  /** Numeric timestamp */
  timestamp: number;
}

/**
 * Scheduler Service — stub implementation.
 * The real service manages cron-based automation execution.
 * Stub: no-op in OSS package.
 */
export class SchedulerService {
  private callback?: (payload: SchedulerTickPayload) => Promise<void>;

  constructor(callback?: (payload: SchedulerTickPayload) => Promise<void>) {
    this.callback = callback;
  }

  start(): void {
    // Stub — no-op
  }

  stop(): void {
    // Stub — no-op
  }
}