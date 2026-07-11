/**
 * ResponseCard.tsx
 *
 * The ResponseCard component and its helpers, extracted from TurnCard.tsx.
 * Handles rendering of AI responses and plan messages with annotation support.
 */

import type * as React from 'react'
import { useMemo, useEffect, useRef, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AnnotationV1 } from '@weft/core'
import {
  FileText,
  Copy,
  Check,
  Maximize2,
  ListTodo,
  GitBranch,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { Markdown } from '../markdown'
import { Spinner } from '../ui/LoadingIndicator'
import type { IslandTransitionConfig } from '../ui'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import {
  type PointerSnapshot,
  buildAnnotationChipEntryTransition,
  buildSelectionEntryTransition,
} from '../annotations/island-motion'
import { extractAnnotationSelectedText } from './follow-up-helpers'
import {
  formatAnnotationFollowUpTooltipText,
  getAnnotationNoteText,
} from '../annotations/follow-up-state'
import {
  ANNOTATION_PREFIX_SUFFIX_WINDOW,
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  hasExistingTextRangeAnnotation,
  createSelectionPreviewAnnotation,
  createTextSelectionAnnotation,
  collectTextSegments,
  getCanonicalText,
  resolveNodeOffset,
  type AnnotationOverlayRect,
} from '../annotations/annotation-core'
import {
  annotationColorToCss,
} from '../annotations/annotation-style-tokens'
import { clearBlockAnnotationMarkers, applyBlockAnnotationMarker } from '../annotations/block-markers'
import { canAnnotateMessage, shouldRenderAnnotationIslandInPortal } from '../annotations/annotation-host-config'
import { clearDomSelection } from '../annotations/selection-restore'
import {
  shouldIgnoreSelectionMouseUpTarget,
} from '../annotations/interaction-policy'
import { computeAnnotationOverlayGeometry } from '../annotations/annotation-overlay-geometry'
import type { AnnotationOverlayChip } from '../annotations/annotation-core'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import {
  getAnnotationInteractionAnchor,
  getAnnotationInteractionSourceKey,
  hasAnnotationInteraction,
} from '../annotations/interaction-selectors'
import type {
  AnnotationIslandMode,
} from '../annotations/interaction-state-machine'
import { useAnnotationInteractionController } from '../annotations/use-annotation-interaction-controller'
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation'
import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events'
import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore'
import { DocumentFormattedMarkdownOverlay } from '../overlay'
import { AcceptPlanDropdown } from './AcceptPlanDropdown'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'
import type { AnnotationInteractionMode, OpenAnnotationRequest } from './turn-types'
import { SIZE_CONFIG, BUFFER_CONFIG } from './turn-helpers'
import { shouldShowStreamingContent } from './tool-display'

// ============================================================================
// BranchDropdown
// ============================================================================

interface BranchDropdownProps {
  onBranch: (options?: { newPanel?: boolean }) => void
}

function BranchDropdown({ onBranch }: BranchDropdownProps) {
  const { t } = useTranslation()
  const handleBranchClick = () => {
    onBranch({ newPanel: true })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('chat.branchOptions')}
          title={t('chat.branch')}
          className={cn(
            "p-1 rounded-[4px] transition-colors select-none",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            "data-[state=open]:text-foreground data-[state=open]:bg-foreground/5",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          <GitBranch className={SIZE_CONFIG.iconSize} />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" minWidth="min-w-64" sideOffset={6}>
        <StyledDropdownMenuItem onClick={handleBranchClick} className="items-start py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-tight">{t('chat.branchFromThisMessage')}</span>
            <span className="max-w-[220px] whitespace-normal text-xs leading-tight text-muted-foreground">
              {t('chat.branchFromThisMessageDescription')}
            </span>
          </div>
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================================================
// Annotation DOM Helpers
// ============================================================================

const MAX_HEIGHT = 540

function clearAnnotationMarks(root: HTMLElement): void {
  const annotatedInlineCodeNodes = root.querySelectorAll<HTMLElement>('code[data-ca-annotation-inline-code="true"]')
  annotatedInlineCodeNodes.forEach((codeNode) => {
    codeNode.removeAttribute('data-ca-annotation-inline-code')
    codeNode.style.backgroundColor = ''
    codeNode.style.boxShadow = ''
  })

  const marks = root.querySelectorAll('span[data-ca-annotation-id]')
  marks.forEach(mark => {
    const parent = mark.parentNode
    if (!parent) return

    const badge = mark.querySelector('[data-ca-annotation-index]')
    if (badge) badge.remove()

    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
    parent.normalize()
  })
}

function createAnnotationIndexBadge(index: number): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.setAttribute('data-ca-annotation-index', String(index))
  chip.textContent = String(index)
  chip.style.position = 'absolute'
  chip.style.top = '-7px'
  chip.style.right = '-7px'
  chip.style.minWidth = '16px'
  chip.style.height = '15px'
  chip.style.padding = '0 3px'
  chip.style.borderRadius = '9999px'
  chip.style.backgroundColor = 'var(--info)'
  chip.style.color = 'rgba(15, 23, 42, 0.95)'
  chip.style.fontSize = '10px'
  chip.style.fontWeight = '600'
  chip.style.lineHeight = '15px'
  chip.style.textAlign = 'center'
  chip.classList.add('shadow-tinted')
  chip.style.setProperty('--shadow-color', 'var(--info-rgb)')
  chip.style.pointerEvents = 'none'
  chip.style.userSelect = 'none'
  return chip
}

function _applyTextHighlightRange(
  root: HTMLElement,
  range: { start: number; end: number },
  annotation: AnnotationV1,
  annotationIndex?: number,
): void {
  if (range.end <= range.start) return

  // Avoid visually highlighting trailing/leading hard newlines.
  // Those can produce extra apparent blank lines at line boundaries.
  const fullText = getCanonicalText(root)
  let displayStart = range.start
  let displayEnd = range.end
  while (displayStart < displayEnd && /[\n\r]/.test(fullText[displayStart] ?? '')) displayStart += 1
  while (displayEnd > displayStart && /[\n\r]/.test(fullText[displayEnd - 1] ?? '')) displayEnd -= 1
  if (displayEnd <= displayStart) return

  const segments = collectTextSegments(root, [])
  const createdMarks: HTMLSpanElement[] = []

  for (const segment of segments) {
    if (segment.end <= displayStart || segment.start >= displayEnd) continue

    const localStart = Math.max(displayStart, segment.start) - segment.start
    const localEnd = Math.min(displayEnd, segment.end) - segment.start
    if (localEnd <= localStart) continue

    const source = segment.node
    const after = source.splitText(localEnd)
    const selected = source.splitText(localStart)

    const inlineCodeParent = selected.parentElement?.closest<HTMLElement>('code')
    if (inlineCodeParent) {
      inlineCodeParent.setAttribute('data-ca-annotation-inline-code', 'true')
      inlineCodeParent.style.backgroundColor = annotationColorToCss(annotation.style?.color)
      inlineCodeParent.style.boxShadow = 'none'
    }

    const mark = document.createElement('span')
    mark.setAttribute('data-ca-annotation-id', annotation.id)
    mark.style.backgroundColor = annotationColorToCss(annotation.style?.color)
    mark.style.borderRadius = '0'
    mark.style.padding = '0'
    mark.style.margin = '0'
    mark.style.position = 'relative'
    selected.parentNode?.replaceChild(mark, selected)
    mark.appendChild(selected)
    createdMarks.push(mark)

    // Keep reference alive for TS and clarity
    void after
  }

  if (createdMarks.length > 0) {
    type RowBucket = { top: number; marks: HTMLSpanElement[] }
    const rows: RowBucket[] = []

    for (const mark of createdMarks) {
      const rect = mark.getBoundingClientRect()
      const row = rows.find(candidate => Math.abs(candidate.top - rect.top) <= 2)
      if (row) {
        row.marks.push(mark)
      } else {
        rows.push({ top: rect.top, marks: [mark] })
      }
    }

    for (const row of rows) {
      const rowMarks = row.marks
      const first = rowMarks[0]
      const last = rowMarks[rowMarks.length - 1]
      if (!first || !last) continue

      first.style.borderTopLeftRadius = '6px'
      first.style.borderBottomLeftRadius = '6px'
      last.style.borderTopRightRadius = '6px'
      last.style.borderBottomRightRadius = '6px'
    }
  }

  if (annotationIndex != null && createdMarks.length > 0) {
    // Prefer placing the index badge on non-code marks, then choose the top-right-most
    // mark on the first visible row for stable placement.
    const nonCodeMarks = createdMarks.filter(mark => !mark.closest('code'))
    const badgePool = nonCodeMarks.length > 0 ? nonCodeMarks : createdMarks

    const preferredInitial = badgePool[0]
    if (!preferredInitial) return

    let preferredMark = preferredInitial
    let preferredRect = preferredMark.getBoundingClientRect()

    for (const mark of badgePool.slice(1)) {
      const rect = mark.getBoundingClientRect()
      const isHigherRow = rect.top < preferredRect.top - 1
      const sameRow = Math.abs(rect.top - preferredRect.top) <= 2
      const isMoreRight = rect.right > preferredRect.right

      if (isHigherRow || (sameRow && isMoreRight)) {
        preferredMark = mark
        preferredRect = rect
      }
    }

    preferredMark.appendChild(createAnnotationIndexBadge(annotationIndex))
  }
}

// ============================================================================
// ResponseCardProps
// ============================================================================

export interface ResponseCardProps {
  /** The content to display (markdown) */
  text: string
  /** Whether the content is still streaming */
  isStreaming: boolean
  /** When streaming started - used for buffering timeout calculation */
  streamStartTime?: number
  /** Callback to open file in editor */
  onOpenFile?: (path: string) => void
  /** Callback to open URL */
  onOpenUrl?: (url: string) => void
  /** Callback to open response in Monaco editor */
  onPopOut?: () => void
  /** Card variant - 'response' for AI messages, 'plan' for plan messages */
  variant?: 'response' | 'plan'
  /** Parent session ID (used to reset local annotation/island UI state on session switches) */
  sessionId?: string
  /** Underlying message ID for annotation actions */
  messageId?: string
  /** Persisted annotations for this response */
  annotations?: AnnotationV1[]
  /** Callback when user accepts the plan (plan variant only) */
  onAccept?: () => void
  /** Callback when user accepts the plan with compaction (compact first, then execute) */
  onAcceptWithCompact?: () => void
  /** Whether this is the last response in the session (shows Accept Plan button only for last response) */
  isLastResponse?: boolean
  /** Whether to show the Accept Plan button (default: true) */
  showAcceptPlan?: boolean
  /** Hide footer for compact embedding (EditPopover) */
  compactMode?: boolean
  /** Callback to branch the session from this response */
  onBranch?: (options?: { newPanel?: boolean }) => void
  /** Callback to add annotation from selected text */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** Callback to remove persisted annotation */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** Callback to update persisted annotation */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback when follow-up is saved via "Save & Send" action */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** Whether there are active pending follow-up annotations in the session */
  hasActiveFollowUpAnnotations?: boolean
  /** External request to open a specific annotation in this response */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** Annotation interaction mode (viewer uses tooltip-only to suppress the island) */
  annotationInteractionMode?: AnnotationInteractionMode
}

// ============================================================================
// ResponseCard Component
// ============================================================================

/**
 * ResponseCard - Unified card component for AI responses and plans
 *
 * Variants:
 * - 'response': Buffered streaming response with smart content gating
 * - 'plan': Plan message with header and Accept Plan button
 *
 * Response variant implements smart buffering:
 * - Waits for 40+ words with structure OR
 * - High-confidence patterns (code blocks, headers, lists) with lower threshold OR
 * - Timeout after 2.5 seconds
 *
 * Performance optimization: Uses throttled static snapshots instead of re-rendering
 * on every character. Content updates every 300ms during streaming, avoiding
 * expensive markdown parsing on every delta.
 */
export function ResponseCard({
  text,
  isStreaming,
  streamStartTime,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  variant = 'response',
  sessionId,
  messageId,
  annotations,
  onAccept,
  onAcceptWithCompact,
  isLastResponse = true,
  showAcceptPlan = true,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: ResponseCardProps) {
  const { t } = useTranslation()
  // Throttled content for display - updates every CONTENT_THROTTLE_MS during streaming
  const [displayedText, setDisplayedText] = useState(text)
  const lastUpdateRef = useRef(Date.now())
  // Copy to clipboard state
  const [copied, setCopied] = useState(false)
  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Dark mode detection - scroll fade only shown in dark mode
  const [isDarkMode, setIsDarkMode] = useState(false)
  // Pending text selection waiting for explicit follow-up action
  const interaction = useAnnotationInteractionController()
  const {
    state: interactionState,
    setDraft: setFollowUpDraft,
    openFromSelection,
    openFollowUpFromSelection,
    openFromAnnotation,
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
    markDeleteSuccess,
    consumeExternalOpenRequest,
  } = interaction

  const pendingSelection = interactionState.pendingSelection
  const selectionMenuView = interactionState.selectionMenuView
  const followUpDraft = interactionState.followUpDraft
  const followUpMode = interactionState.followUpMode
  const activeAnnotationDetail = interactionState.activeAnnotationDetail

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )
  const [annotationOverlay, setAnnotationOverlay] = useState<{ rects: AnnotationOverlayRect[]; chips: AnnotationOverlayChip[] }>({ rects: [], chips: [] })
  const contentRef = useRef<HTMLDivElement>(null)
  const contentLayerRef = useRef<HTMLDivElement>(null)
  const lastPointerRef = useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = useRef<PointerSnapshot | null>(null)
  const selectionStartedInContentRef = useRef(false)

  const canAnnotate = canAnnotateMessage({
    hasAddAnnotationHandler: !!onAddAnnotation,
    hasMessageId: !!messageId,
    isStreaming,
  })
  const allowAnnotationIsland = annotationInteractionMode === 'interactive'

  // Detect dark mode from document class and listen for changes
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(document.documentElement.classList.contains('dark'))
    }
    checkDarkMode()

    // Observe class changes on documentElement for theme switches
    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const closeSelectionMenu = useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  const activeMenuAnchor = useMemo(() => {
    return getAnnotationInteractionAnchor(interactionState)
  }, [interactionState])

  const selectionMenuSourceKey = useMemo(() => {
    const messageScope = messageId ?? 'no-message'
    return getAnnotationInteractionSourceKey(interactionState, messageScope)
  }, [interactionState, messageId])

  const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
    resetPresentation,
  } = useAnnotationIslandPresentation({
    anchor: activeMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [text])

  const renderedAnnotations = useMemo(() => {
    const persisted = annotations ?? []

    if (!pendingSelection || !selectionMenuView || !messageId) {
      return persisted
    }

    if (hasExistingTextRangeAnnotation(persisted, pendingSelection.start, pendingSelection.end)) {
      return persisted
    }

    return [
      ...persisted,
      createSelectionPreviewAnnotation(messageId, pendingSelection, sessionId ?? ''),
    ]
  }, [annotations, pendingSelection, selectionMenuView, messageId, sessionId])

  const activeAnnotation = useMemo(() => {
    if (!activeAnnotationDetail) return null
    return (annotations ?? []).find(annotation => annotation.id === activeAnnotationDetail.annotationId) ?? null
  }, [annotations, activeAnnotationDetail])

  useEffect(() => {
    if (!activeAnnotationDetail) return
    if (!activeAnnotation) {
      closeSelectionMenu()
    }
  }, [activeAnnotationDetail, activeAnnotation, closeSelectionMenu])

  useEffect(() => {
    const root = contentLayerRef.current
    if (!root) {
      setAnnotationOverlay({ rects: [], chips: [] })
      return
    }

    const recomputeOverlay = () => {
      clearAnnotationMarks(root)
      clearBlockAnnotationMarkers(root)

      if (!renderedAnnotations.length) {
        setAnnotationOverlay({ rects: [], chips: [] })
        return
      }

      const geometry = computeAnnotationOverlayGeometry({
        root,
        renderedAnnotations,
        persistedAnnotations: annotations,
      })

      for (const annotation of renderedAnnotations) {
        applyBlockAnnotationMarker(root, annotation)
      }

      setAnnotationOverlay({ rects: geometry.rects, chips: geometry.chips })

      if (process.env.NODE_ENV !== 'production' && geometry.unresolved.length > 0) {
        console.debug('[annotations] unresolved annotations', {
          count: geometry.unresolved.length,
          ids: geometry.unresolved.map(item => item.annotation.id),
          reasons: geometry.unresolved.map(item => item.reason),
        })
      }
    }

    recomputeOverlay()
    window.addEventListener('resize', recomputeOverlay)
    return () => {
      window.removeEventListener('resize', recomputeOverlay)
    }
  }, [annotations, renderedAnnotations])

  useEffect(() => {
    if (!canAnnotate) {
      closeSelectionMenu()
    }
  }, [canAnnotate, closeSelectionMenu])

  useEffect(() => {
    // Session switches should fully reset local island UI state to avoid stale
    // "hot" instances suppressing entry animations in the newly focused session.
    closeSelectionMenu()
    resetPresentation()
    dragStartPointerRef.current = null
    lastPointerRef.current = null
  }, [closeSelectionMenu, resetPresentation])

  useEffect(() => {
    if (!hasAnnotationInteraction(interactionState) || !isSelectionMenuVisible) return

    const handleSelectionChange = () => {
      if (selectionMenuOpenedAtRef.current == null || Date.now() - selectionMenuOpenedAtRef.current < 180) {
        return
      }

      const root = contentLayerRef.current
      if (!root) {
        closeSelectionMenu()
        return
      }

      const selection = window.getSelection()
      // Keep the island open if selection was programmatically cleared by a render update.
      // This happens during streaming/DOM reconciliation and should not dismiss follow-up UI.
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const range = selection.getRangeAt(0)
      const common = range.commonAncestorContainer
      const commonElement = common.nodeType === Node.ELEMENT_NODE
        ? common as Element
        : common.parentElement

      // Selecting text inside the island (e.g. follow-up textarea) should not close it.
      if (commonElement && isTargetInsideAnnotationIsland(commonElement)) {
        return
      }

      if (!root.contains(common)) {
        closeSelectionMenu()
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [interactionState, isSelectionMenuVisible, closeSelectionMenu, isTargetInsideAnnotationIsland, selectionMenuOpenedAtRef])

  const handleOpenFollowUpView = useCallback(() => {
    if (!pendingSelection) return

    // Native browser selection steals typing focus from the follow-up textarea.
    // Keep semantic selection in pendingSelection and clear only the DOM selection.
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const saveFollowUp = useCallback(async (note: string): Promise<{
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  } | null> => {
    const normalizedNote = note.trim()

    if (!messageId) return null

    if (activeAnnotationDetail) {
      if (!onUpdateAnnotation || !activeAnnotation) {
        closeSelectionMenu()
        return null
      }

      const existingOtherBodies = activeAnnotation.body.filter(body => body.type !== 'highlight' && body.type !== 'note')
      const nextBody: AnnotationV1['body'] = [
        { type: 'highlight' },
        ...(normalizedNote.length > 0 ? [{ type: 'note', text: normalizedNote, format: 'plain' } as const] : []),
        ...existingOtherBodies,
      ]

      const nextMeta = { ...(activeAnnotation.meta ?? {}) }
      delete nextMeta.followUp

      try {
        await Promise.resolve(onUpdateAnnotation(messageId, activeAnnotationDetail.annotationId, {
          body: nextBody,
          intent: normalizedNote.length > 0 ? 'comment' : 'highlight',
          updatedAt: Date.now(),
          meta: normalizedNote.length > 0
            ? {
                ...nextMeta,
                followUp: {
                  text: normalizedNote,
                  updatedAt: Date.now(),
                },
              }
            : (Object.keys(nextMeta).length > 0 ? nextMeta : undefined),
        }))
      } catch {
        return null
      }

      markSubmitSuccess()

      if (normalizedNote.length === 0) return null

      return {
        messageId,
        annotationId: activeAnnotationDetail.annotationId,
        note: normalizedNote,
        selectedText: extractAnnotationSelectedText(activeAnnotation, text),
      }
    }

    if (!onAddAnnotation || !pendingSelection) return null

    if (hasExistingTextRangeAnnotation(annotations ?? [], pendingSelection.start, pendingSelection.end)) {
      closeSelectionMenu()
      return null
    }

    const annotation = createTextSelectionAnnotation(messageId, sessionId ?? '', pendingSelection.start, pendingSelection.end, pendingSelection.exact ?? (activeAnnotation ? extractAnnotationSelectedText(activeAnnotation, text) : ''), normalizedNote)

    try {
      await Promise.resolve(onAddAnnotation(messageId, annotation))
    } catch {
      return null
    }

    markSubmitSuccess()
    clearDomSelection()

    if (normalizedNote.length === 0) return null

    return {
      messageId,
      annotationId: annotation.id,
      note: normalizedNote,
      selectedText: pendingSelection.selectedText ?? '',
    }
  }, [
    messageId,
    activeAnnotationDetail,
    activeAnnotation,
    onUpdateAnnotation,
    onAddAnnotation,
    pendingSelection,
    annotations,
    closeSelectionMenu,
    sessionId,
    markSubmitSuccess,
    text,
  ])

  const handleSubmitFollowUp = useCallback((note: string) => {
    void saveFollowUp(note)
  }, [saveFollowUp])

  const handleSubmitAndSendFollowUp = useCallback((note: string) => {
    void saveFollowUp(note).then((savedFollowUp) => {
      if (!savedFollowUp) return
      onSaveAndSendFollowUp?.(savedFollowUp)
    })
  }, [saveFollowUp, onSaveAndSendFollowUp])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentLayerRef,
    cancelFollowUp,
  })

  const handleOpenAnnotationDetail = useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: AnnotationIslandMode = 'view'
  ) => {
    if (!allowAnnotationIsland) return

    const annotation = (annotations ?? []).find(item => item.id === annotationId)
    const noteText = annotation ? getAnnotationNoteText(annotation) : ''

    const transition = buildAnnotationChipEntryTransition()

    setSelectionMenuTransitionConfig(transition)
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
  }, [allowAnnotationIsland, annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

  useEffect(() => {
    if (!allowAnnotationIsland) return

    const contentRect = contentLayerRef.current?.getBoundingClientRect()
    const fallbackAnchor = {
      x: contentRect ? contentRect.left + contentRect.width / 2 : window.innerWidth / 2,
      y: contentRect ? contentRect.top + 20 : Math.max(24, window.innerHeight * 0.2),
    }

    const consumed = consumeExternalOpenRequest(openAnnotationRequest, {
      messageId,
      annotations,
      getNoteText: getAnnotationNoteText,
      fallbackAnchor,
    })

    if (!consumed) return

    setSelectionMenuTransitionConfig(buildAnnotationChipEntryTransition())
    triggerSelectionMenuEntryReplay()
  }, [
    allowAnnotationIsland,
    openAnnotationRequest,
    messageId,
    annotations,
    consumeExternalOpenRequest,
    triggerSelectionMenuEntryReplay,
  ])

  const handleDeleteActiveAnnotation = useCallback(() => {
    if (!onRemoveAnnotation || !messageId || !activeAnnotationDetail) return

    onRemoveAnnotation(messageId, activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, messageId, activeAnnotationDetail, markDeleteSuccess])

  const handleSelectionPointerDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    selectionStartedInContentRef.current = true
    const snapshot = {
      x: event.clientX,
      y: event.clientY,
      timestamp: Date.now(),
    }

    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

  const showSelectionMenuFromCurrentSelection = useCallback(() => {
    const root = contentLayerRef.current
    if (!root) return

    requestAnimationFrame(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        closeSelectionMenu()
        return
      }

      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        closeSelectionMenu()
        return
      }

      const start = resolveNodeOffset(root, range.startContainer, range.startOffset)
      const end = resolveNodeOffset(root, range.endContainer, range.endOffset)
      if (start == null || end == null || end <= start) {
        closeSelectionMenu()
        return
      }

      const selectedText = range.toString()
      if (!selectedText || !/\S/.test(selectedText)) {
        closeSelectionMenu()
        return
      }

      if (hasExistingTextRangeAnnotation(annotations ?? [], start, end)) {
        closeSelectionMenu()
        return
      }

      const fullText = getCanonicalText(root)
      const prefix = fullText.slice(Math.max(0, start - ANNOTATION_PREFIX_SUFFIX_WINDOW), start)
      const suffix = fullText.slice(end, end + ANNOTATION_PREFIX_SUFFIX_WINDOW)

      // Prefer fragmented client rects over union bounds for wrapped selections.
      // The union rect often produces an x-axis anchor that feels detached.
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.timestamp) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null
      const pointerY = hasRecentPointer && pointer ? pointer.y : null

      let anchorRect: DOMRect
      if (rects.length > 0) {
        if (pointerY != null) {
          const rowCandidates = rects.filter(rect => pointerY >= rect.top && pointerY <= rect.bottom)

          if (rowCandidates.length > 0) {
            if (pointerX != null) {
              const xContaining = rowCandidates.filter(rect => pointerX >= rect.left && pointerX <= rect.right)
              if (xContaining.length > 0) {
                anchorRect = xContaining.reduce((best, rect) => (rect.width > best.width ? rect : best))
              } else {
                anchorRect = rowCandidates.reduce((best, rect) => {
                  const bestDistance = Math.min(Math.abs(pointerX - best.left), Math.abs(pointerX - best.right))
                  const rectDistance = Math.min(Math.abs(pointerX - rect.left), Math.abs(pointerX - rect.right))
                  return rectDistance < bestDistance ? rect : best
                })
              }
            } else {
              anchorRect = rowCandidates.reduce((best, rect) => (rect.width > best.width ? rect : best))
            }
          } else {
            anchorRect = rects.reduce((best, rect) => {
              const bestDistance = Math.abs((best.top + best.bottom) / 2 - pointerY)
              const rectDistance = Math.abs((rect.top + rect.bottom) / 2 - pointerY)
              return rectDistance < bestDistance ? rect : best
            })
          }
        } else {
          anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
        }
      } else {
        anchorRect = range.getBoundingClientRect()
      }

      const anchorRowRects = rects.length > 0
        ? rects.filter(rect => Math.abs(rect.top - anchorRect.top) <= 2)
        : []
      const clampRects = anchorRowRects.length > 0 ? anchorRowRects : (rects.length > 0 ? rects : [anchorRect])

      const selectionMinX = Math.min(...clampRects.map(rect => rect.left))
      const selectionMaxX = Math.max(...clampRects.map(rect => rect.right))

      // Prefer mouse-release position, but clamp to the chosen anchor row so
      // multiline selections stay attached to actual text on that line.
      const anchorX = pointerX != null
        ? clamp(pointerX, selectionMinX, selectionMaxX)
        : (anchorRect.left + (anchorRect.width / 2))
      const anchorY = anchorRect.top - 8

      const transition = buildSelectionEntryTransition(dragStartPointerRef.current, pointer)

      setSelectionMenuTransitionConfig(transition)
      triggerSelectionMenuEntryReplay()
      openFromSelection({
        start,
        end,
        exact: selectedText,
        selectedText,
        prefix,
        suffix,
        anchorX,
        anchorY,
      })
      dragStartPointerRef.current = null
    })
  }, [annotations, closeSelectionMenu, triggerSelectionMenuEntryReplay, openFromSelection])

  const handleTextSelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return
    const root = contentLayerRef.current
    if (!root) return

    if (shouldIgnoreSelectionMouseUpTarget(event.target)) {
      selectionStartedInContentRef.current = false
      return
    }

    // Mouseup location reflects the user's final intent for popup anchoring.
    lastPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      timestamp: Date.now(),
    }

    // Block annotation gesture: Shift+click on a block wrapper
    if (event.shiftKey) {
      const targetElement = event.target instanceof Element ? event.target : null
      const blockElement = targetElement?.closest<HTMLElement>('[data-ca-block-path]')
      if (blockElement) {
        const blockPath = blockElement.getAttribute('data-ca-block-path') || ''
        const blockType = blockElement.getAttribute('data-ca-block-type') || 'paragraph'
        const blockId = blockElement.getAttribute('data-ca-block-id') || undefined

        if (blockPath) {
          const alreadyExists = (annotations ?? []).some(annotation => {
            const blockSelector = annotation.target.selectors.find(s => s.type === 'block') as Extract<
              AnnotationV1['target']['selectors'][number],
              { type: 'block' }
            > | undefined
            if (!blockSelector) return false
            if (blockId && blockSelector.blockId) return blockSelector.blockId === blockId
            return blockSelector.path === blockPath
          })

          if (!alreadyExists) {
            const annotation: AnnotationV1 = {
              id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              schemaVersion: 1,
              createdAt: Date.now(),
              intent: 'highlight',
              body: [{ type: 'highlight' }],
              target: {
                source: {
                  sessionId: '',
                  messageId,
                },
                selectors: [
                  {
                    type: 'block',
                    blockType: blockType as Extract<AnnotationV1['target']['selectors'][number], { type: 'block' }>['blockType'],
                    path: blockPath,
                    ...(blockId ? { blockId } : {}),
                  },
                ],
              },
              style: { color: 'yellow' },
            }
            onAddAnnotation(messageId, annotation)
          }
        }
      }
      selectionStartedInContentRef.current = false
      closeSelectionMenu()
      return
    }

    selectionStartedInContentRef.current = false
    showSelectionMenuFromCurrentSelection()
  }, [canAnnotate, onAddAnnotation, messageId, annotations, showSelectionMenuFromCurrentSelection, closeSelectionMenu])

  useEffect(() => {
    if (!canAnnotate || !onAddAnnotation || !messageId) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      if (!selectionStartedInContentRef.current) return
      selectionStartedInContentRef.current = false

      // Mouseup location reflects the user's final intent for popup anchoring.
      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        timestamp: Date.now(),
      }

      const root = contentLayerRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) {
        // In-bounds mouseup is already handled by onMouseUp on the content container.
        return
      }

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, onAddAnnotation, messageId, showSelectionMenuFromCurrentSelection])

  const handleSelectionMenuRequestBack = useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }

    return false
  }, [selectionMenuView, handleCancelFollowUp])

  useAnnotationIslandEvents({
    enabled: allowAnnotationIsland && hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  const selectionMenu = allowAnnotationIsland ? (
    <AnnotationIslandMenu
      anchor={selectionMenuRenderAnchor}
      sourceKey={selectionMenuRenderSourceKey}
      replayNonce={selectionMenuShowNonce}
      isVisible={isSelectionMenuVisible}
      activeView={selectionMenuView}
      mode={followUpMode}
      draft={followUpDraft}
      onDraftChange={setFollowUpDraft}
      onOpenFollowUp={handleOpenFollowUpView}
      onCancel={handleCancelFollowUp}
      onRequestBack={handleSelectionMenuRequestBack}
      onRequestEdit={handleRequestFollowUpEdit}
      onSubmit={handleSubmitFollowUp}
      onSubmitAndSend={handleSubmitAndSendFollowUp}
      onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
      sendMessageKey={sendMessageKey}
      transitionConfig={selectionMenuTransitionConfig}
      onExitComplete={handleSelectionMenuExitComplete}
      usePortal={shouldRenderAnnotationIslandInPortal('turncard')}
    />
  ) : null

  const annotationOverlayLayer = (
    <AnnotationOverlayLayer
      rects={annotationOverlay.rects}
      chips={annotationOverlay.chips}
      annotations={renderedAnnotations}
      getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
      allowChipOpen={allowAnnotationIsland}
      onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
        handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
      }}
    />
  )

  // Throttle content updates during streaming for performance
  // Updates immediately when streaming ends to show final content
  useEffect(() => {
    if (!isStreaming) {
      // Streaming ended - show final content immediately
      setDisplayedText(text)
      return
    }

    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    if (elapsed >= BUFFER_CONFIG.CONTENT_THROTTLE_MS) {
      // Enough time passed - update immediately
      setDisplayedText(text)
      lastUpdateRef.current = now
    } else {
      // Schedule update for remaining time
      const timeout = setTimeout(() => {
        setDisplayedText(text)
        lastUpdateRef.current = Date.now()
      }, BUFFER_CONFIG.CONTENT_THROTTLE_MS - elapsed)
      return () => clearTimeout(timeout)
    }
  }, [text, isStreaming])

  // Calculate buffering decision based on current text (not displayed text)
  const bufferDecision = useMemo(() => {
    return shouldShowStreamingContent(text, isStreaming, streamStartTime)
  }, [text, isStreaming, streamStartTime])

  const isCompleted = !isStreaming
  const isBuffering = isStreaming && !bufferDecision.shouldShow

  // While buffering, return null - TurnCard will show a subtle indicator instead
  if (isBuffering) {
    return null
  }

  // Completed response or plan - show with max height and footer
  if (isCompleted || variant === 'plan') {
    const isPlan = variant === 'plan'

    return (
      <>
        <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden relative group">
          {/* Fullscreen button - desktop only; compact mode keeps message chrome minimal */}
          {!compactMode && (
          <button type="button"
            onClick={() => setIsFullscreen(true)}
            className={cn(
              "absolute top-2 right-2 p-1 rounded-[6px] transition-all z-10 select-none",
              "opacity-0 group-hover:opacity-100",
              "bg-background shadow-minimal",
              "text-muted-foreground/50 hover:text-foreground",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          )}

          {/* Plan header - only shown for plan variant */}
          {isPlan && (
            <div
              className={cn(
                "px-4 py-2 border-b border-border/30 flex items-center gap-2 bg-success/5 select-none",
                SIZE_CONFIG.fontSize
              )}
            >
              <ListTodo className={cn(SIZE_CONFIG.iconSize, "text-success")} />
              <span className="font-medium text-success">Plan</span>
            </div>
          )}

          {/* Scrollable content area with subtle fade at edges (dark mode only) */}
          <div
            ref={contentRef}
            data-search-root="response"
            onMouseDown={handleSelectionPointerDown}
            onMouseUp={handleTextSelection}
            className="pl-[22px] pr-[16px] py-3 text-sm overflow-y-auto scrollbar-hover"
            style={{
              maxHeight: MAX_HEIGHT,
              // Subtle fade at top and bottom edges (16px) - only in dark mode for better contrast
              ...(isDarkMode && {
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
              }),
            }}
          >
            <div ref={contentLayerRef} className="relative">
              <Markdown
                mode="minimal"
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
              >
                {text}
              </Markdown>
              {annotationOverlayLayer}
            </div>
          </div>

          {/* Footer with actions - hidden in compact mode */}
          {!compactMode && (
            <div className={cn(
              "pl-4 pr-2.5 py-2 border-t border-border/30 flex items-center justify-between bg-muted/20",
              SIZE_CONFIG.fontSize
            )}>
              {/* Left side - Copy, View as Markdown, Annotation hint */}
              <div className="flex items-center gap-3">
                <button type="button"
                  onClick={handleCopy}
                  className={cn(
                    "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                    copied ? "text-success" : "text-muted-foreground hover:text-foreground",
                    "focus:outline-none focus-visible:underline"
                  )}
                >
                  {copied ? (
                    <>
                      <Check className={SIZE_CONFIG.iconSize} />
                      <span>{t("common.copied")}</span>
                    </>
                  ) : (
                    <>
                      <Copy className={SIZE_CONFIG.iconSize} />
                      <span>{t("common.copy")}</span>
                    </>
                  )}
                </button>
                {onPopOut && (
                  <button type="button"
                    onClick={onPopOut}
                    className={cn(
                      "turn-action-btn flex items-center gap-1.5 transition-colors select-none",
                      "text-muted-foreground hover:text-foreground",
                      "focus:outline-none focus-visible:underline"
                    )}
                  >
                    <FileText className={SIZE_CONFIG.iconSize} />
                    <span>Markdown</span>
                  </button>
                )}
              </div>

              {/* Right side */}
              <div className="flex items-center gap-3">
                {/* Accept Plan dropdown (plan variant only, last response) */}
                {isPlan && showAcceptPlan && onAccept && onAcceptWithCompact && (
                  <div
                    className={cn(
                      "flex items-center gap-3 transition-all duration-200",
                      isLastResponse
                        ? "opacity-100 translate-x-0"
                        : "opacity-0 translate-x-2 pointer-events-none"
                    )}
                  >
                    <AcceptPlanDropdown
                      onAccept={onAccept}
                      onAcceptWithCompact={onAcceptWithCompact}
                      acceptLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.acceptPlan')}
                      acceptOptionLabel={hasActiveFollowUpAnnotations ? t('plan.acceptAndSendFollowups') : t('plan.accept')}
                    />
                  </div>
                )}
                {onBranch && <BranchDropdown onBranch={onBranch} />}
              </div>
            </div>
          )}
        </div>

        {/* Fullscreen overlay for reading/annotating response and plan content. */}
        <DocumentFormattedMarkdownOverlay
          content={text}
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          variant={isPlan ? 'plan' : undefined}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
          sessionId={sessionId}
          messageId={messageId}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          sendMessageKey={sendMessageKey}
          openAnnotationRequest={openAnnotationRequest}
          isStreaming={isStreaming}
        />
        {selectionMenu}
      </>
    )
  }

  // Streaming response - show throttled content with spinner
  return (
    <>
      <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden group">
        {/* Content area - uses displayedText (throttled) for performance */}
        {/* Subtle fade at top and bottom edges (dark mode only) */}
        <div
          ref={contentRef}
          data-search-root="response"
          onMouseDown={handleSelectionPointerDown}
          onMouseUp={handleTextSelection}
          className="pl-[22px] pr-4 py-3 text-sm overflow-y-auto scrollbar-hover"
          style={{
            maxHeight: MAX_HEIGHT,
            // Subtle fade at top and bottom edges (16px) - only in dark mode for better contrast
            ...(isDarkMode && {
              maskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)',
            }),
          }}
        >
          <div ref={contentLayerRef} className="relative">
            <Markdown
              mode="minimal"
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            >
              {displayedText}
            </Markdown>
            {annotationOverlayLayer}
          </div>
        </div>

        {/* Footer - hidden in compact mode */}
        {!compactMode && (
          <div className={cn("px-4 py-2 border-t border-border/30 flex items-center bg-muted/20", SIZE_CONFIG.fontSize)}>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner className={SIZE_CONFIG.spinnerSize} />
              <span>Streaming...</span>
            </div>
          </div>
        )}
      </div>
      {selectionMenu}
    </>
  )
}
