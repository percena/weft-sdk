/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional demo-curated model picker list (comma-separated ids). When set
   * for a provider, the picker shows these ids and the SDK `listModels`
   * discovery is only used for the effort-default fallback. When unset, the
   * picker falls back to the SDK-discovered list.
   */
  readonly VITE_DEMO_MODELS_CLAUDE?: string
  readonly VITE_DEMO_MODELS_CODEX?: string
  /** Optional explicit default model id (must be in the list above). */
  readonly VITE_DEMO_DEFAULT_MODEL_CLAUDE?: string
  readonly VITE_DEMO_DEFAULT_MODEL_CODEX?: string
  /**
   * Optional demo-curated reasoning-effort ladder (comma-separated slugs).
   * When set, the effort picker shows exactly these slugs; when unset, the
   * built-in REASONING_EFFORT_OPTIONS ladder is used. The default-selected
   * effort still falls back to the SDK-detected `defaultEffort` (App.tsx).
   */
  readonly VITE_DEMO_EFFORTS_CLAUDE?: string
  readonly VITE_DEMO_EFFORTS_CODEX?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
