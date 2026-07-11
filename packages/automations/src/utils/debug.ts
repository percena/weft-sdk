/**
 * Debug Utility Stub
 *
 * Provides logger creation for automations.
 * Stubbed for OSS extraction — the real debug module uses Electron logging.
 *
 * SECURITY (audit B6): gate every level on WEFT_DEBUG === '1' to match the
 * @weft/sources package, so webhook URLs (which may embed a secret in the
 * path — Slack/Discord inbound tokens) and other diagnostics never reach
 * stdout/container logs by default. In Node.js console.debug is an alias for
 * console.log and always writes to stdout (unlike the browser, which hides it),
 * so the gate is required for the OSS package.
 */

const WEFT_DEBUG_ON = typeof process !== 'undefined' && process.env?.WEFT_DEBUG === '1';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Create a scoped logger instance.
 * Stub: logs to console in OSS package, gated on WEFT_DEBUG=1.
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.debug(`[${scope}]`, ...args) },
    info: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.info(`[${scope}]`, ...args) },
    warn: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.warn(`[${scope}]`, ...args) },
    error: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.error(`[${scope}]`, ...args) },
  };
}