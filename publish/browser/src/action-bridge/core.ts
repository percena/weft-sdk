/**
 * @weft/action-bridge — productized action replay.
 *
 * Hosts annotate clickable elements with `data-weft-action` (via
 * `weftAction(...)`), push standard action descriptors (usually derived from
 * their own business event stream, with `actor` taken from the
 * `X-Weft-Actor` header Flitro stamps on agent tool calls), and the bridge
 * replays each agent action on the live page: an automated live cursor moves to the
 * element, clicks (ripple), the element flashes, then `onReplayed` fires so
 * the host can refresh its data. Elements that are not on screen degrade
 * gracefully: the animation is skipped but `onReplayed` still fires.
 *
 * Framework-agnostic and dependency-free; React glue lives in
 * `@weft/action-bridge/react`.
 */

/** Standard action descriptor. */
export interface WeftActionEvent {
  /** `agent` events are replayed; anything else is passed through. */
  actor: string
  /** Business semantic, host-defined (e.g. `form.submitted`). */
  action?: string
  /** Matches `data-weft-action` on the page (e.g. `submit-form:contact-form`). */
  target?: string | null
  /** Cursor bubble copy (e.g. `Submit form: contact request`). */
  label?: string
  /** Scopes replay to one panel/session when several are mounted. */
  session?: string
}

export type CursorMode = 'ghost' | 'highlight' | 'off'

/** Replay choreography timing. */
export interface ActionBridgeTiming {
  cursorMoveMs: number
  rippleMs: number
  flashMs: number
  cursorHideMs: number
  /** Pause after `onReplayed` before the next queued event. */
  settleMs: number
}

export const DEFAULT_TIMING: ActionBridgeTiming = {
  cursorMoveMs: 550,
  rippleMs: 450,
  flashMs: 900,
  cursorHideMs: 2600,
  settleMs: 180,
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void
  removeEventListener?(type: string, listener: (event: { data: string }) => void): void
}

export interface ActionBridgeOptions {
  /** `ghost` (cursor + ripple + flash), `highlight` (flash only), `off`. */
  cursor?: CursorMode
  /** Only replay events whose `session` matches (when both are set). */
  session?: string
  /** Called after each agent event (replayed or degraded) settles. */
  onReplayed?: (event: WeftActionEvent) => void | Promise<void>
  timing?: Partial<ActionBridgeTiming>
  /** Cursor bubble prefix (default `AI`). */
  labelPrefix?: string
  document?: Document
}

export interface ConnectOptions<TRaw = unknown> {
  /** SSE event name to listen for (default `weft-action`). */
  eventName?: string
  /**
   * Translate the host's raw event payload into a descriptor. Return null to
   * ignore the event. Defaults to treating the payload as a descriptor.
   */
  map?: (raw: TRaw) => WeftActionEvent | null
}

export interface ActionBridge {
  /** Queue one descriptor for replay (agent events only). */
  dispatch(event: WeftActionEvent): void
  /** Subscribe to an EventSource/WebSocket-like emitter of descriptors. */
  connect<TRaw = unknown>(source: EventSourceLike, options?: ConnectOptions<TRaw>): () => void
  /** Wait until everything queued so far has been replayed. */
  flush(): Promise<void>
  dispose(): void
}

/** Build the `data-weft-action` attribute: `weftAction('submit-form', 'contact-form')`. */
export function weftAction(action: string, id?: string | number): { 'data-weft-action': string } {
  return { 'data-weft-action': id === undefined ? action : `${action}:${id}` }
}

/** Selector for a descriptor target. */
export function weftActionSelector(target: string): string {
  return `[data-weft-action=${JSON.stringify(target)}]`
}

const FLASH_CLASS = 'weft-action-flash'
const STYLE_ID = 'weft-action-bridge-styles'

function injectStyles(doc: Document, timing: ActionBridgeTiming): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.weft-ghost-cursor{position:fixed;left:0;top:0;z-index:9999;pointer-events:none;transition:transform ${timing.cursorMoveMs}ms cubic-bezier(.22,1,.36,1),opacity .3s ease}
.weft-ghost-cursor svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.weft-ghost-cursor .weft-cursor-label{position:absolute;left:18px;top:18px;white-space:nowrap;background:rgba(30,30,40,.92);color:#fff;font:12px/1.6 system-ui,sans-serif;padding:2px 8px;border-radius:6px}
.weft-ghost-cursor .weft-cursor-ripple{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(120,90,220,.8);opacity:0;transform:scale(.3)}
.weft-ghost-cursor.weft-clicking .weft-cursor-ripple{animation:weft-cursor-ripple ${timing.rippleMs}ms ease-out}
@keyframes weft-cursor-ripple{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.6)}}
.${FLASH_CLASS}{animation:weft-action-flash ${timing.flashMs}ms ease-out}
@keyframes weft-action-flash{0%{box-shadow:0 0 0 3px rgba(120,90,220,.65)}100%{box-shadow:0 0 0 3px rgba(120,90,220,0)}}
`
  doc.head.appendChild(style)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createActionBridge(options: ActionBridgeOptions = {}): ActionBridge {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : undefined)
  const cursorMode: CursorMode = options.cursor ?? 'ghost'
  const timing: ActionBridgeTiming = { ...DEFAULT_TIMING, ...options.timing }
  const labelPrefix = options.labelPrefix ?? 'AI'

  let queue: Promise<void> = Promise.resolve()
  let disposed = false
  let cursorEl: HTMLElement | null = null
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const disconnects: Array<() => void> = []

  function ensureCursor(): HTMLElement | null {
    if (!doc || cursorMode !== 'ghost') return null
    if (cursorEl) return cursorEl
    injectStyles(doc, timing)
    cursorEl = doc.createElement('div')
    cursorEl.className = 'weft-ghost-cursor'
    cursorEl.style.opacity = '0'
    cursorEl.innerHTML =
      '<div class="weft-cursor-ripple"></div>' +
      '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 2l16 8.5-7 1.8L9.4 19z" fill="#fff" stroke="#333" stroke-width="1.4"/></svg>' +
      '<span class="weft-cursor-label"></span>'
    doc.body.appendChild(cursorEl)
    return cursorEl
  }

  async function replay(event: WeftActionEvent): Promise<void> {
    if (disposed || !doc) return
    const el = event.target ? (doc.querySelector(weftActionSelector(event.target)) as HTMLElement | null) : null

    if (el && cursorMode !== 'off') {
      injectStyles(doc, timing)
      const rect = el.getBoundingClientRect()
      const cursor = ensureCursor()
      if (cursor) {
        const label = cursor.querySelector('.weft-cursor-label') as HTMLElement
        label.textContent = event.label ? `${labelPrefix} ${event.label}` : labelPrefix
        cursor.style.transform = `translate(${rect.left + rect.width / 2}px, ${rect.top + rect.height / 2}px)`
        cursor.style.opacity = '1'
        await sleep(timing.cursorMoveMs + 70)
        if (disposed) return
        cursor.classList.add('weft-clicking')
      }
      el.classList.add(FLASH_CLASS)
      setTimeout(() => el.classList.remove(FLASH_CLASS), timing.flashMs + 50)
      await sleep(timing.rippleMs)
      cursor?.classList.remove('weft-clicking')
    }

    // Replayed-or-degraded: the host refresh callback always runs, so a
    // missing element never desynchronizes page state.
    await options.onReplayed?.(event)
    await sleep(timing.settleMs)
    if (cursorEl) {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        if (cursorEl) cursorEl.style.opacity = '0'
      }, timing.cursorHideMs)
    }
  }

  function accepts(event: WeftActionEvent): boolean {
    if (event.actor !== 'agent') return false
    if (options.session && event.session && event.session !== options.session) return false
    return true
  }

  return {
    dispatch(event: WeftActionEvent): void {
      if (disposed || !accepts(event)) return
      queue = queue.then(() => replay(event)).catch(() => {})
    },
    connect<TRaw = unknown>(source: EventSourceLike, connectOptions?: ConnectOptions<TRaw>): () => void {
      const eventName = connectOptions?.eventName ?? 'weft-action'
      const map = connectOptions?.map ?? ((raw: TRaw) => raw as unknown as WeftActionEvent)
      const listener = (e: { data: string }) => {
        let raw: TRaw
        try {
          raw = JSON.parse(e.data) as TRaw
        } catch {
          return
        }
        const event = map(raw)
        if (event) this.dispatch(event)
      }
      source.addEventListener(eventName, listener)
      const disconnect = () => source.removeEventListener?.(eventName, listener)
      disconnects.push(disconnect)
      return disconnect
    },
    flush(): Promise<void> {
      return queue
    },
    dispose(): void {
      disposed = true
      for (const disconnect of disconnects) disconnect()
      if (hideTimer) clearTimeout(hideTimer)
      cursorEl?.remove()
      cursorEl = null
      doc?.getElementById(STYLE_ID)?.remove()
    },
  }
}
