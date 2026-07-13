import { processEvent, type ChatEvent, type SessionState } from '@percena/weft-node/chat'
import { mapTimelineEnvelopeToProcessorEvent } from '@percena/weft-node/chat'
import type { TimelineEnvelope } from '@percena/weft-node'
import { groupMessagesByTurn, type Turn } from '@percena/weft-node/chat'

export const DEMO_SESSION_ID = 'demo'
export const DEMO_WORKSPACE_ID = 'demo-workspace'
export const DEMO_WORKSPACE_NAME = 'Demo Workspace'
export const DEMO_USER_PROMPT = 'Update the config timeout to 10000 and enable retry backoff'

const baseTimestamp = Date.now()

export const DEMO_TIMELINE: TimelineEnvelope[] = [
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 1,
    timestamp: baseTimestamp,
    item: {
      type: 'runtime_capability_report',
      report: {
        provider: 'claude',
        selected: 'native-sdk',
        fallback: false,
        auth: { configured: true, mode: 'provider-owned', source: 'provider-sdk' },
      },
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 2,
    timestamp: baseTimestamp,
    item: {
      type: 'user_message',
      text: DEMO_USER_PROMPT,
      messageId: 'demo-user-message',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 3,
    timestamp: baseTimestamp + 20,
    item: { type: 'turn_started', turnId: 'demo-turn-1' },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 4,
    timestamp: baseTimestamp + 40,
    item: {
      type: 'source_state_changed',
      source: {
        sourceSlug: 'workspace-files',
        status: 'active',
      },
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 5,
    timestamp: baseTimestamp + 60,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'I will inspect ',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 6,
    timestamp: baseTimestamp + 80,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'the configuration file ',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 7,
    timestamp: baseTimestamp + 100,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'and apply a focused update.\n\n',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 8,
    timestamp: baseTimestamp + 120,
    item: {
      type: 'tool_call',
      callId: 'tool-read-config',
      name: 'Read',
      status: 'running',
      detail: {
        input: { file_path: '/src/config.ts' },
        intent: 'Inspect the current runtime configuration.',
      },
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 9,
    timestamp: baseTimestamp + 140,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'Reading the current values before editing.\n\n',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 10,
    timestamp: baseTimestamp + 160,
    item: {
      type: 'tool_result',
      callId: 'tool-read-config',
      result: 'export const config = {\n  timeout: 5000,\n  retryBackoff: false,\n  maxRetries: 3\n}',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 11,
    timestamp: baseTimestamp + 180,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'The timeout is currently 5000ms. ',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 12,
    timestamp: baseTimestamp + 200,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'I will update it to 10000ms and enable retry backoff.\n\n',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 13,
    timestamp: baseTimestamp + 220,
    item: {
      type: 'permission_requested',
      request: {
        requestId: 'permission-write-config',
        toolName: 'Write',
        input: {
          command: 'write /src/config.ts',
          file_path: '/src/config.ts',
        },
        reason: 'File write requires explicit approval in ask mode.',
        scope: { type: 'session', sessionId: DEMO_SESSION_ID },
      },
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 14,
    timestamp: baseTimestamp + 240,
    item: {
      type: 'permission_resolved',
      requestId: 'permission-write-config',
      resolution: {
        allowed: true,
        remember: false,
        reason: 'Approved for this turn only.',
      },
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 15,
    timestamp: baseTimestamp + 260,
    item: {
      type: 'tool_call',
      callId: 'tool-write-config',
      name: 'Write',
      status: 'running',
      detail: {
        input: {
          file_path: '/src/config.ts',
          content: 'export const config = {\n  timeout: 10000,\n  retryBackoff: true,\n  maxRetries: 3\n}',
        },
        intent: 'Apply the config change.',
      },
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 16,
    timestamp: baseTimestamp + 300,
    item: {
      type: 'tool_result',
      callId: 'tool-write-config',
      result: 'File written successfully.',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 17,
    timestamp: baseTimestamp + 320,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'Done. The config now uses:\n',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 18,
    timestamp: baseTimestamp + 340,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: '- **timeout**: 10000\n',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 19,
    timestamp: baseTimestamp + 360,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: '- **retry backoff**: enabled\n\n',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 20,
    timestamp: baseTimestamp + 380,
    item: {
      type: 'assistant_message_delta',
      messageId: 'assistant-stream',
      text: 'Run the test suite to verify the updated behavior.',
      turnId: 'demo-turn-1',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 21,
    timestamp: baseTimestamp + 400,
    item: {
      type: 'assistant_message',
      text: '',
      turnId: 'demo-turn-1',
      messageId: 'demo-final-response',
    },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 22,
    timestamp: baseTimestamp + 420,
    item: { type: 'turn_completed', turnId: 'demo-turn-1' },
  },
  {
    sessionId: DEMO_SESSION_ID,
    provider: 'claude',
    epoch: 'demo-epoch',
    seq: 23,
    timestamp: baseTimestamp + 440,
    item: { type: 'session_status', status: 'ready' },
  },
]

export const DEMO_EVENTS: ChatEvent[] = DEMO_TIMELINE.map(mapTimelineEnvelopeToProcessorEvent)

export function createDemoSessionState(): SessionState {
  return {
    session: {
      id: DEMO_SESSION_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      workspaceName: DEMO_WORKSPACE_NAME,
      lastMessageAt: baseTimestamp,
      lastUsedAt: baseTimestamp,
      messages: [],
      isProcessing: false,
    },
    streaming: null,
  }
}

export function reduceDemoEvents(
  initialState: SessionState,
  events: readonly ChatEvent[]
): SessionState {
  return events.reduce((state, event) => processEvent(state, event).state, initialState)
}

export function getDemoTurns(state: SessionState): Turn[] {
  const turns = groupMessagesByTurn(state.session.messages)
  const lastTurn = turns.at(-1)
  if (!state.session.isProcessing || lastTurn?.type !== 'user') return turns

  return [
    ...turns,
    {
      type: 'assistant',
      turnId: `${lastTurn.message.turnId ?? lastTurn.message.id}:pending`,
      activities: [],
      response: undefined,
      intent: undefined,
      isStreaming: true,
      isComplete: false,
      timestamp: lastTurn.timestamp + 1,
    },
  ]
}
