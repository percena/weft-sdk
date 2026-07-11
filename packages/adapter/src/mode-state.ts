import { debug } from './utils/debug.ts';
import {
  type PermissionMode,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
} from './mode-types.ts';


/**
 * State for a single session's permission mode
 */
export type PermissionModeChangedBy = 'user' | 'system' | 'restore' | 'automation' | 'unknown';

export interface ModeState {
  /** Session ID */
  sessionId: string;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Previous permission mode (if any mode transition has occurred) */
  previousPermissionMode?: PermissionMode;
  /** Monotonic version incremented each time the mode changes */
  modeVersion: number;
  /** ISO timestamp for the last mode change */
  lastChangedAt: string;
  /** Actor that initiated the last mode change */
  lastChangedBy: PermissionModeChangedBy;
  /** Last user-mode modeVersion for which one-turn signal has been consumed */
  lastUserSignalConsumedModeVersion?: number;
  /** Callback when mode state changes */
  onStateChange?: (state: ModeState) => void;
}

/**
 * Callbacks for mode changes
 */
export interface ModeCallbacks {
  onStateChange?: (state: ModeState) => void;
}

// ============================================================
// Mode Manager Class
// ============================================================

/**
 * Manager for per-session permission mode state.
 * Each session has its own state - NO GLOBAL STATE.
 */
class ModeManager {
  private states: Map<string, ModeState> = new Map();
  private callbacks: Map<string, ModeCallbacks> = new Map();
  private subscribers: Map<string, Set<() => void>> = new Map();

  /**
   * Hydrate persisted transition context (previous mode) without mutating current mode/version.
   * Used on session restore so transition metadata can survive app restarts.
   */
  setPreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
    const existing = this.getState(sessionId);
    if (existing.previousPermissionMode === previousPermissionMode) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      previousPermissionMode,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * Get or create state for a session
   */
  getState(sessionId: string): ModeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        permissionMode: 'ask', // Default to 'ask' until initialized
        modeVersion: 0,
        lastChangedAt: new Date().toISOString(),
        lastChangedBy: 'system',
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * Set permission mode for a session.
   * @returns true when state changed, false when mode was unchanged
   */
  setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
    metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
  ): boolean {
    const existing = this.getState(sessionId);

    // No-op when mode is unchanged (prevents duplicate logs/events)
    if (existing.permissionMode === mode) {
      return false;
    }

    const changedAt = metadata?.changedAt ?? new Date().toISOString();
    const changedBy = metadata?.changedBy ?? 'unknown';

    const shouldTrackTransition = !(existing.modeVersion === 0 && changedBy === 'restore');

    const newState: ModeState = {
      ...existing,
      previousPermissionMode: shouldTrackTransition ? existing.permissionMode : undefined,
      permissionMode: mode,
      modeVersion: existing.modeVersion + 1,
      lastChangedAt: changedAt,
      lastChangedBy: changedBy,
    };
    this.states.set(sessionId, newState);

    debug(`[Mode] Set permission mode to ${mode} for session ${sessionId} (changedBy=${changedBy}, modeVersion=${newState.modeVersion})`);

    // Notify callbacks (for agent runtime internal sync)
    const callbacks = this.callbacks.get(sessionId);
    if (callbacks?.onStateChange) {
      callbacks.onStateChange(newState);
    }

    // Notify React subscribers (for useSyncExternalStore)
    this.subscribers.get(sessionId)?.forEach(cb => cb());
    return true;
  }

  /**
   * Mark the current user-origin mode change signal as consumed.
   * No-op unless the latest mode change was user-initiated.
   */
  consumeUserModeSignal(sessionId: string): void {
    const existing = this.getState(sessionId);
    if (existing.lastChangedBy !== 'user') {
      return;
    }

    if (existing.lastUserSignalConsumedModeVersion === existing.modeVersion) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      lastUserSignalConsumedModeVersion: existing.modeVersion,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * Register callbacks for a session
   */
  registerCallbacks(sessionId: string, callbacks: ModeCallbacks): void {
    this.callbacks.set(sessionId, callbacks);
  }

  /**
   * Unregister callbacks for a session
   */
  unregisterCallbacks(sessionId: string): void {
    this.callbacks.delete(sessionId);
  }

  /**
   * Clean up a session's state
   */
  cleanupSession(sessionId: string): void {
    this.states.delete(sessionId);
    this.callbacks.delete(sessionId);
    this.subscribers.delete(sessionId);
  }

  /**
   * Subscribe to mode changes for a session (for React useSyncExternalStore)
   * Returns an unsubscribe function
   */
  subscribe(sessionId: string, callback: () => void): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.get(sessionId)?.delete(callback);
    };
  }
}

// Singleton manager instance
export const modeManager = new ModeManager();

// ============================================================
// Permission Mode API
// ============================================================

/**
 * Get the current permission mode for a session
 */
export function getPermissionMode(sessionId: string): PermissionMode {
  return modeManager.getState(sessionId).permissionMode;
}

/**
 * Set the permission mode for a session.
 * @returns true when state changed, false when mode was unchanged
 */
export function setPermissionMode(
  sessionId: string,
  mode: PermissionMode,
  metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
): boolean {
  return modeManager.setPermissionMode(sessionId, mode, metadata);
}

/**
 * Consume one-turn user mode-change signal for the current modeVersion.
 */
export function consumeUserModeSignal(sessionId: string): void {
  modeManager.consumeUserModeSignal(sessionId);
}

/**
 * Cycle to the next permission mode (for SHIFT+TAB)
 * @param sessionId - The session to cycle mode for
 * @param enabledModes - Optional list of enabled modes to cycle through (defaults to all 3)
 * Returns the new mode
 */
export function cyclePermissionMode(
  sessionId: string,
  enabledModes?: PermissionMode[]
): PermissionMode {
  const currentMode = getPermissionMode(sessionId);
  // Use provided modes or default to all modes
  const modes = enabledModes && enabledModes.length >= 2 ? enabledModes : PERMISSION_MODE_ORDER;
  const currentIndex = modes.indexOf(currentMode);

  // If current mode not in enabled list, jump to first enabled mode
  if (currentIndex === -1) {
    const nextMode = modes[0] ?? 'ask';
    setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
    return nextMode;
  }

  const nextIndex = (currentIndex + 1) % modes.length;
  // Safe assertion: nextIndex is always valid due to modulo operation
  const nextMode = modes[nextIndex] as PermissionMode;
  setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
  return nextMode;
}

/**
 * Subscribe to mode changes for a session (for React useSyncExternalStore)
 * Returns an unsubscribe function
 */
export function subscribeModeChanges(sessionId: string, callback: () => void): () => void {
  return modeManager.subscribe(sessionId, callback);
}

/**
 * Get mode state for a session
 */
export function getModeState(sessionId: string): ModeState {
  return modeManager.getState(sessionId);
}

/**
 * Hydrate persisted transition context for a session without changing current mode.
 */
export function hydratePreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
  modeManager.setPreviousPermissionMode(sessionId, previousPermissionMode);
}

/**
 * Lightweight diagnostics for permission denials and debugging.
 */
export function getPermissionModeDiagnostics(sessionId: string): {
  permissionMode: PermissionMode;
  previousPermissionMode?: PermissionMode;
  transitionDisplay?: string;
  modeVersion: number;
  lastChangedAt: string;
  lastChangedBy: PermissionModeChangedBy;
  userModeSignalPending: boolean;
} {
  const state = modeManager.getState(sessionId);
  const transitionDisplay = state.previousPermissionMode
    ? `${PERMISSION_MODE_CONFIG[state.previousPermissionMode].displayName} -> ${PERMISSION_MODE_CONFIG[state.permissionMode].displayName}`
    : undefined;
  const userModeSignalPending =
    state.lastChangedBy === 'user' &&
    state.modeVersion > 0 &&
    state.lastUserSignalConsumedModeVersion !== state.modeVersion;

  return {
    permissionMode: state.permissionMode,
    previousPermissionMode: state.previousPermissionMode,
    transitionDisplay,
    modeVersion: state.modeVersion,
    lastChangedAt: state.lastChangedAt,
    lastChangedBy: state.lastChangedBy,
    userModeSignalPending,
  };
}

/**
 * Initialize permission mode state for a session with callbacks
 */
export function initializeModeState(
  sessionId: string,
  initialMode: PermissionMode | { permissionMode?: PermissionMode },
  callbacks?: ModeCallbacks
): void {
  let mode: PermissionMode;

  if (typeof initialMode === 'string') {
    mode = initialMode;
  } else if ('permissionMode' in initialMode && initialMode.permissionMode) {
    mode = initialMode.permissionMode;
  } else {
    // Default to 'ask' if not specified
    mode = 'ask';
  }

  // IMPORTANT: Register callbacks BEFORE setting mode so the initial
  // state change triggers the callback.
  if (callbacks) {
    modeManager.registerCallbacks(sessionId, callbacks);
  }
  modeManager.setPermissionMode(sessionId, mode, { changedBy: 'restore' });
}

/**
 * Clean up mode state for a session
 */
export function cleanupModeState(sessionId: string): void {
  modeManager.cleanupSession(sessionId);
}
