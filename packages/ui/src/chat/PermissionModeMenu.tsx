import type { PermissionMode } from '@weft/core'

const PERMISSION_CONFIG = [
  { mode: 'explore' as PermissionMode, label: 'Explore', description: 'Read-only planning and inspection.', icon: '◎' },
  { mode: 'ask' as PermissionMode, label: 'Ask', description: 'Review changes before execution.', icon: 'ⓘ' },
  { mode: 'auto' as PermissionMode, label: 'Auto', description: 'Allow edits and commands in this session.', icon: '⇄' },
]

export function PermissionModeMenu({
  value,
  onChange,
  onClose,
  isOpen,
  onToggle,
}: {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  onClose?: () => void
  isOpen: boolean
  onToggle: () => void
}) {
  const selected = PERMISSION_CONFIG.find(o => o.mode === value) ?? PERMISSION_CONFIG[1]

  return (
    <div className="relative">
      {isOpen && (
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-[204px] rounded-[9px] border border-border bg-background p-1.5 shadow-modal-small">
          <div className="space-y-0.5">
            {PERMISSION_CONFIG.map(option => (
              <button
                key={option.mode}
                type="button"
                onClick={() => {
                  onChange(option.mode)
                  onClose?.()
                }}
                className={`flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] transition ${
                  option.mode === value
                    ? 'bg-foreground/[0.08] text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground'
                }`}
              >
                <span className="w-4 text-center text-[12px]">{option.icon}</span>
                <span className="flex-1">{option.label}</span>
                {option.mode === value && (
                  <span aria-hidden="true" className="text-[12px] text-foreground">●</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
        className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-border bg-foreground/[0.035] px-2.5 text-[12px] text-foreground transition hover:bg-foreground/[0.06]"
      >
        <span className="text-muted-foreground">{selected.icon}</span>
        <span>{selected.label}</span>
        <span className="text-muted-foreground">⌄</span>
      </button>
    </div>
  )
}
