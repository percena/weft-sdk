/**
 * weft/action-bridge — Automated-live-cursor action replay for agentic UIs.
 *
 * Inlined source (from the former @weft/action-bridge package): both the
 * framework-agnostic core and the React glue, bundled so @percena/weft has
 * zero @percena transitive deps.
 */
export * from './action-bridge/core.ts'
export { ActionReplayLayer, useActionBridge } from './action-bridge/react.tsx'
export type { ActionReplayLayerProps } from './action-bridge/react.tsx'
