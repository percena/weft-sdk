/**
 * Automation Event Logger Stub
 *
 * Provides event logging interface for automations.
 * Stubbed for OSS extraction — the real logger writes to JSONL files.
 */

export interface LoggedAutomationEvent {
  timestamp: number;
  /** Event type (renamed from 'type' to match LoggedAutomationEventInput) */
  event: string;
  workspaceId: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface LoggedAutomationEventInput {
  /** Event name */
  event: string;
  workspaceId: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

/**
 * Automation Event Logger — stub implementation.
 * The real logger persists events to workspace-scoped JSONL files.
 */
export class AutomationEventLogger {
  /** Callback when an event is lost due to buffer overflow */
  onEventLost: ((event: LoggedAutomationEvent) => void) | null = null;

  constructor(_workspaceRootPath?: string) {
    // Stub — optional workspace root for type compatibility
  }

  /**
   * Log an automation event.
   * Stub: no persistence in OSS package.
   */
  log(_input: LoggedAutomationEventInput): void {
    // Stub — no persistence in OSS package
  }

  /**
   * Get the path to the event log file.
   * Stub: returns empty string.
   */
  getLogPath(): string {
    return '';
  }

  /**
   * Dispose the logger, flushing buffered events.
   * Stub: no-op.
   */
  async dispose(): Promise<void> {
    // Stub — no-op
  }
}