import { type FormEvent, useState } from 'react'
import { SessionViewer, type PlatformActions } from '@weft/ui'
import { useAgentChatSession, type ChatSessionRuntime } from './use-agent-chat-session.ts'
import { toStoredSession, createEmptyStoredSession } from './session-utils.ts'

export interface AgentChatPanelProps {
  runtime: ChatSessionRuntime
  workspaceId?: string
  workspaceName?: string
  platformActions?: PlatformActions
  placeholder?: string
  className?: string
}

export function AgentChatPanel({
  runtime,
  workspaceId,
  workspaceName,
  platformActions,
  placeholder = 'Message agent',
  className,
}: AgentChatPanelProps) {
  const chat = useAgentChatSession({ runtime, workspaceId, workspaceName })
  const [draft, setDraft] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (!message) return
    setDraft('')
    try {
      await chat.sendMessage(message)
    } catch {
      // useAgentChatSession owns the visible error state.
    }
  }

  const storedSession = chat.session
    ? toStoredSession(chat.session, workspaceId)
    : createEmptyStoredSession(runtime.sessionId, workspaceId, workspaceName)

  const footer = (
    <form onSubmit={handleSubmit} className="flex gap-2 p-3">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder={placeholder}
        rows={2}
        className="min-h-10 flex-1 resize-none rounded-md border px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={!draft.trim()}
        className="h-10 rounded-md border px-3 text-sm disabled:opacity-50"
      >
        Send
      </button>
      {chat.isRunning && (
        <button
          type="button"
          onClick={() => void chat.abort()}
          className="h-10 rounded-md border px-3 text-sm"
        >
          Stop
        </button>
      )}
    </form>
  )

  return (
    <div className={className}>
      {chat.error && (
        <div className="border-b px-3 py-2 text-sm text-red-600">
          {chat.error.message}
        </div>
      )}
      <SessionViewer
        session={storedSession}
        mode="interactive"
        platformActions={platformActions}
        footer={footer}
      />
    </div>
  )
}
