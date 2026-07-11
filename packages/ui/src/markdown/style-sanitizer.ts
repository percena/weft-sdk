/**
 * Inline-`style` AND `className` sanitizer for rendered Markdown.
 *
 * `rehype-sanitize`'s schema can allow or drop the `style`/`className` ATTRIBUTE
 * on an element, but it cannot filter the VALUE. KaTeX struts rely on inline
 * `style="height:…em; vertical-align:…"` on `<span>`s, and KaTeX/GFM rely on
 * `className` tokens, so both attributes must be allowed — but allowing them
 * globally lets untrusted model output inject CSS that exfiltrates data
 * (`background-image:url(https://attacker/…)`, which the browser auto-fetches,
 * leaking the page origin via Referer) or redresses the UI
 * (`position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;opacity:0`
 * to overlay the Ask permission prompt). For `className`, the equivalent
 * UI-redress vector on a Tailwind host is `class="fixed inset-0 opacity-0
 * pointer-events-none z-[9999]"`.
 *
 * `filterInlineStyle` keeps only a tight allowlist of layout properties KaTeX
 * struts need and blocks any `url(…)` value regardless of property.
 * `filterClassName` strips dangerous Tailwind utility tokens (positioning,
 * offsets, inset, z-index, opacity, pointer-events, transform) that enable UI
 * redress/clickjacking, while preserving KaTeX/GFM class names. The rehype
 * plugin applies both after `rehype-sanitize` so the attributes survive but the
 * dangerous values do not.
 */

/** CSS properties safe to keep (KaTeX strut layout). Everything else is dropped. */
const SAFE_STYLE_PROPS: ReadonlySet<string> = new Set([
  'height', 'min-height', 'max-height',
  'vertical-align', 'text-align',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'line-height',
])

/** Match any `url(…)` value (case-insensitive) — blocks CSS-driven fetches. */
const URL_RE = /url\s*\(/i

/**
 * Filter a single style declaration `value` (already property-keyed). Returns
 * whether the property is allowlisted AND the value carries no `url(…)`.
 */
function isSafeDeclaration(prop: string, value: string): boolean {
  return SAFE_STYLE_PROPS.has(prop) && !URL_RE.test(value)
}

/**
 * Normalize a `style` value (string OR hast properties object) into a filtered
 * CSS string of safe declarations. Returns `undefined` if nothing safe remains
 * (so the caller can drop the attribute entirely).
 *
 * The output is a STRING (kebab-case declarations, the raw-CSS form) so that
 * `hast-util-to-jsx-runtime`'s `parseStyle` → `styleToJs(value,
 * {reactCompat: true})` runs on it as it normally would, producing the
 * camelCase object React expects. Returning an object directly would bypass
 * `parseStyle` and ship kebab-case keys to React, which silently ignores them
 * (breaking KaTeX `vertical-align`/`text-align`/`margin-*`).
 */
export function filterInlineStyle(style: unknown): string | undefined {
  const entries: Array<[string, string]> = []
  if (typeof style === 'string') {
    for (const decl of style.split(';')) {
      const trimmed = decl.trim()
      if (!trimmed) continue
      const colon = trimmed.indexOf(':')
      if (colon === -1) continue
      entries.push([trimmed.slice(0, colon).trim().toLowerCase(), trimmed.slice(colon + 1).trim()])
    }
  } else if (style && typeof style === 'object') {
    for (const [k, v] of Object.entries(style as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') {
        entries.push([k.toLowerCase(), String(v)])
      }
    }
  } else {
    return undefined
  }
  const safe: string[] = []
  for (const [prop, value] of entries) {
    if (isSafeDeclaration(prop, value)) safe.push(`${prop}: ${value}`)
  }
  return safe.length > 0 ? safe.join('; ') : undefined
}

/** rehype plugin: walk the tree and filter every element's inline `style` + `className`. */
export function rehypeSanitizeInlineStyle() {
  return (tree: unknown): unknown => {
    visit(tree as HastNode)
    return tree
  }
}

interface HastNode {
  type?: string
  properties?: Record<string, unknown> | null
  children?: HastNode[]
}

/**
 * Tailwind utility tokens that enable UI redress / clickjacking when injected by
 * untrusted model output: positioning, offsets, inset, z-index, opacity
 * (invisibility), pointer-events (click-through), transforms, and visual
 * reordering (order). KaTeX/GFM class names do not match any of these.
 * SECURITY.
 *
 * The leading `(?:-)?` catches Tailwind NEGATIVE variants (`-translate-x-4`,
 * `-top-10`, `-z-50`) which the anchored `^` regex would otherwise let through.
 * `transform` (with the `[-[]` suffix) catches arbitrary-value transforms
 * (`transform-[translateX(100px)]`, `transform-gpu`) — the bare `transform`
 * utility is a no-op without a translate/rotate/scale, so it's intentionally
 * NOT matched. `order` reorders flex children (a fake button injected with
 * `order-first` visually swaps into a real button's slot) — `flex-*-reverse`
 * and the `pe-none`/`pe-auto` pointer-events aliases are matched by the
 * precise companion regexes below so benign `pe-<n>` (padding-inline-end) and
 * `flex-<n>` (flex-grow/basis) are NOT stripped.
 */
const DANGEROUS_CLASS_RE =
  /^(fixed|absolute|relative|sticky)$|^(?:-)?(inset|top|left|right|bottom|z|opacity|pointer-events|translate|rotate|scale|transform|order)[-[]/

/** `pe-none`/`pe-auto` — the pointer-events aliases (click-through). Precise so
 * `pe-<n>` (padding-inline-end, benign) survives. */
const PE_ALIAS_RE = /^pe-(none|auto)$/

/** `flex-row-reverse`/`flex-col-reverse` — reverses flex direction, reordering
 * all children (a UI-redress vector). Precise so `flex-<n>` (grow/basis) survives. */
const FLEX_REVERSE_RE = /^flex-(row|col)-reverse$/

const isDangerousClass = (t: string): boolean =>
  DANGEROUS_CLASS_RE.test(t) || PE_ALIAS_RE.test(t) || FLEX_REVERSE_RE.test(t)

/**
 * Filter a `className` value (space-separated string OR token array) by dropping
 * dangerous Tailwind utility tokens. Returns the filtered form (string if input
 * was a string, array if input was an array), or `undefined` if nothing remains.
 */
export function filterClassName(className: unknown): string | string[] | undefined {
  if (typeof className === 'string') {
    const tokens = className.split(/\s+/).filter((t) => t.length > 0 && !isDangerousClass(t))
    return tokens.length > 0 ? tokens.join(' ') : undefined
  }
  if (Array.isArray(className)) {
    const tokens = className.filter((t) => typeof t === 'string' && t.length > 0 && !isDangerousClass(t))
    return tokens.length > 0 ? tokens : undefined
  }
  return undefined
}

function visit(node: HastNode | undefined | null): void {
  if (!node) return
  if (node.properties) {
    if ('style' in node.properties) {
      const filtered = filterInlineStyle(node.properties.style)
      if (filtered) {
        node.properties.style = filtered
      } else {
        delete node.properties.style
      }
    }
    if ('className' in node.properties) {
      const filtered = filterClassName(node.properties.className)
      if (filtered) {
        node.properties.className = filtered
      } else {
        delete node.properties.className
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child)
  }
}
