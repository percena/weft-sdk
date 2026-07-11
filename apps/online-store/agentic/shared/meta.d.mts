// Type declarations for meta.mjs (consumed by src/ via TypeScript).

export declare const ORDER_STATES: readonly string[]
export declare const TRANSITIONS: Record<string, { from: string[]; to: string }>
export declare function allowedActions(status: string): string[]
export declare const STATUS_LABELS: Record<string, string>
export declare const ACTION_LABELS: Record<string, string>
export declare const ACTION_PATHS: Record<string, (id: string) => string>
