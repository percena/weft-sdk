/**
 * interaction-state-machine — stub for annotation interaction state machine.
 */


export type AnnotationIslandMode = 'view' | 'edit' | 'follow-up'

export interface AnchoredSelection {
  anchorX: number
  anchorY: number
  start: number
  end: number
  exact: string
  selectedText?: string
  prefix?: string
  suffix?: string
}

export interface ActiveAnnotationDetail {
  annotationId: string
  index: number
  anchorX: number
  anchorY: number
}

export interface AnnotationInteractionState {
  isOpen: boolean
  mode: AnnotationIslandMode
  activeDetail: ActiveAnnotationDetail | null
  draft: string
  pendingSelection: AnchoredSelection | null
  /** Selection menu view state — string enum or null */
  selectionMenuView: 'compact' | 'confirm-follow-up' | 'expanded' | null
  /** Follow-up draft text for annotation island */
  followUpDraft: string
  /** Follow-up mode: composing or submitted */
  followUpMode: 'composing' | 'submitted' | 'none'
  /** Currently active annotation detail for island display */
  activeAnnotationDetail: ActiveAnnotationDetail | null
}

export const initialAnnotationInteractionState: AnnotationInteractionState = {
  isOpen: false,
  mode: 'view',
  activeDetail: null,
  draft: '',
  pendingSelection: null,
  selectionMenuView: null,
  followUpDraft: '',
  followUpMode: 'none',
  activeAnnotationDetail: null,
}

export const annotationInteractionActions = {
  setDraft: (_draft: string) => ({ type: 'setDraft' as const, draft: _draft }),
  openFromSelection: (_selection: AnchoredSelection) => ({ type: 'openFromSelection' as const, selection: _selection }),
  openFollowUpFromSelection: () => ({ type: 'openFollowUpFromSelection' as const }),
  openFromAnnotation: (_detail: ActiveAnnotationDetail, _noteText: string, _mode: AnnotationIslandMode) => ({ type: 'openFromAnnotation' as const, detail: _detail, noteText: _noteText, mode: _mode }),
  requestEdit: () => ({ type: 'requestEdit' as const }),
  cancelFollowUp: () => ({ type: 'cancelFollowUp' as const }),
  closeAll: () => ({ type: 'closeAll' as const }),
  submitSuccess: () => ({ type: 'submitSuccess' as const }),
  deleteSuccess: () => ({ type: 'deleteSuccess' as const }),
}

export type AnnotationInteractionAction =
  | ReturnType<typeof annotationInteractionActions.setDraft>
  | ReturnType<typeof annotationInteractionActions.openFromSelection>
  | ReturnType<typeof annotationInteractionActions.openFollowUpFromSelection>
  | ReturnType<typeof annotationInteractionActions.openFromAnnotation>
  | ReturnType<typeof annotationInteractionActions.requestEdit>
  | ReturnType<typeof annotationInteractionActions.cancelFollowUp>
  | ReturnType<typeof annotationInteractionActions.closeAll>
  | ReturnType<typeof annotationInteractionActions.submitSuccess>
  | ReturnType<typeof annotationInteractionActions.deleteSuccess>

export function annotationInteractionReducer(
  state: AnnotationInteractionState,
  _action: AnnotationInteractionAction,
): AnnotationInteractionState {
  return state
}