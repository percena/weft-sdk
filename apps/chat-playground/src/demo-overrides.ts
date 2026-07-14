/**
 * Demo-level overrides for the model picker and the reasoning-effort ladder.
 *
 * Loaded from Vite env vars (`.env` / `.env.local` in apps/chat-playground) so
 * a fork can curate the picker without touching source. See `.env.example` for
 * the full template.
 *
 * Merge semantics (the contract the rest of the demo relies on):
 *   - Models:   demo override → else SDK-discovered list (`listModels`).
 *   - Efforts:  demo override ladder → else built-in REASONING_EFFORT_OPTIONS.
 *   - Defaults: demo override default model → else SDK `defaultModel`; the
 *               default-selected effort always falls back to the SDK-detected
 *               `defaultEffort` when it matches the (possibly overridden)
 *               ladder (handled in App.tsx, not here).
 *
 * Note: provider ids are taken as strings to avoid an import cycle with
 * live-session-store; callers pass a `LiveProvider` which is assignable.
 */

export interface ModelOverride {
  models: string[]
  defaultModel?: string
}

export type EffortOption = { effort: string; label: string }

const ENV = import.meta.env as Record<string, string | undefined>

function splitList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function effortLabel(slug: string): string {
  if (!slug) return ''
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

/**
 * Returns the demo-curated model list for a provider, or `undefined` when no
 * `VITE_DEMO_MODELS_<PROVIDER>` is set. The default model is an explicit
 * `VITE_DEMO_DEFAULT_MODEL_<PROVIDER>` when it is present in the list, else
 * the first entry.
 */
export function getModelOverride(provider: string): ModelOverride | undefined {
  const models = splitList(ENV[`VITE_DEMO_MODELS_${provider.toUpperCase()}`])
  if (models.length === 0) return undefined
  const explicit = ENV[`VITE_DEMO_DEFAULT_MODEL_${provider.toUpperCase()}`]?.trim()
  const defaultModel = explicit && models.includes(explicit) ? explicit : models[0]
  return { models, defaultModel }
}

/**
 * Returns the demo-curated effort ladder for a provider, or `undefined` when
 * no `VITE_DEMO_EFFORTS_<PROVIDER>` is set. Labels are derived from the slug
 * (`xhigh` → `XHigh`).
 */
export function getEffortOverride(provider: string): EffortOption[] | undefined {
  const slugs = splitList(ENV[`VITE_DEMO_EFFORTS_${provider.toUpperCase()}`])
  if (slugs.length === 0) return undefined
  return slugs.map(slug => ({ effort: slug, label: effortLabel(slug) }))
}
