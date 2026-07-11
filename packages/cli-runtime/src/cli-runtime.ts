import type { AgentEvent } from '@weft/core'
import {
  readClaudeAuth,
  readCodexAuth,
  createSanitizedClaudeEnvironment,
  type ProviderAuthDetection,
} from '@weft/adapter/auth'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { PushAgentEventStream } from './event-stream.ts'
import { mapClaudeStreamJsonLine, mapCodexExecJsonLine } from './parsers.ts'
import { initialRuntimeState, mapPermissionModeToCodexParams, reduceRuntimeState, type RuntimeAction } from '@weft/runtime-core'
import type {
  AgentRuntimeState,
  AgentSessionRuntime,
  CliAgentSessionOptions,
  SendMessageOptions,
} from './types.ts'

function createSessionId(provider: string): string {
  return `cli-${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanEnv(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function mapClaudePermissionMode(mode: CliAgentSessionOptions['permissionMode']): string | undefined {
  if (!mode) return undefined
  if (mode === 'auto') return 'bypassPermissions'
  if (mode === 'explore') return 'plan'
  return 'default'
}

export function buildCliArgs(options: CliAgentSessionOptions, message: string): string[] {
  if (options.provider === 'claude') {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
    ]
    if (options.model) args.push('--model', options.model)
    const effort = options.reasoningEffort ?? options.thinkingLevel
    if (effort) args.push('--effort', effort)
    const permissionMode = mapClaudePermissionMode(options.permissionMode)
    if (permissionMode) args.push('--permission-mode', permissionMode)
    args.push(message)
    return args
  }

  const args = ['exec', '--json', '--cd', options.cwd]
  if (options.model) args.push('--model', options.model)
  if (options.reasoningEffort) args.push('--config', `model_reasoning_effort="${options.reasoningEffort}"`)
  if (options.permissionMode) {
    const codexParams = mapPermissionModeToCodexParams(options.permissionMode)
    args.push('--config', `approval_policy="${codexParams.approvalPolicy}"`)
    args.push('--sandbox', codexParams.sandbox)
  }
  args.push(message)
  return args
}

function optionsForSend(
  options: CliAgentSessionOptions,
  sendOptions: SendMessageOptions | undefined,
): CliAgentSessionOptions {
  if (!sendOptions?.permissionMode) return options
  return {
    ...options,
    permissionMode: sendOptions.permissionMode,
  }
}

function mapProviderLine(provider: CliAgentSessionOptions['provider'], line: string): AgentEvent[] {
  return provider === 'claude'
    ? mapClaudeStreamJsonLine(line)
    : mapCodexExecJsonLine(line)
}

export function createCliAgentSession(options: CliAgentSessionOptions): AgentSessionRuntime {
  const events = new PushAgentEventStream()
  const sessionId = options.sessionId ?? createSessionId(options.provider)
  let state: AgentRuntimeState = initialRuntimeState
  let proc: ChildProcess | null = null
  const queuedSendOptions: Array<SendMessageOptions | undefined> = []

  function dispatch(action: RuntimeAction) {
    state = reduceRuntimeState(state, action)
  }

  async function preflight(): Promise<ProviderAuthDetection> {
    dispatch({ type: 'preflight_start' })
    const auth = options.provider === 'claude'
      ? await readClaudeAuth(options.executable, options.env ?? createSanitizedClaudeEnvironment())
      : await readCodexAuth(options.executable, options.env, options.requestTimeoutMs)

    if (auth.configured) {
      dispatch({ type: 'preflight_ok' })
    } else {
      dispatch({ type: 'preflight_error', error: auth.error ?? `${options.provider} auth is not configured` })
    }
    return auth
  }

  async function consumeStdout(stdout: NodeJS.ReadableStream): Promise<boolean> {
    const rl = createInterface({ input: stdout, crlfDelay: Infinity })
    let sawComplete = false
    for await (const line of rl) {
      for (const event of mapProviderLine(options.provider, line)) {
        if (event.type === 'permission_request') {
          dispatch({ type: 'permission_request', requestId: event.requestId })
        }
        if (event.type === 'complete') {
          // Dispatch at most once per process run: each `complete` promotes one
          // queued message, which must stay paired with queuedSendOptions.shift().
          if (!sawComplete) dispatch({ type: 'complete' })
          sawComplete = true
        }
        events.emit(event)
      }
    }
    return sawComplete
  }

  async function consumeStderr(stderr: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of stderr) {
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString()
  }

  async function runMessage(
    message: string,
    sendOptions?: SendMessageOptions,
    alreadyAccepted = false,
  ): Promise<void> {
    if (!alreadyAccepted) {
      dispatch({ type: 'send_message', message })
    }
    const acceptedCountAfterCurrentMessage = state.acceptedMessages.length
    events.emit({ type: 'status', message: `${options.provider} runtime running` })
    const executable = options.executable ?? options.provider
    const args = buildCliArgs(optionsForSend(options, sendOptions), message)
    const env = options.provider === 'claude'
      ? (options.env ?? createSanitizedClaudeEnvironment())
      : (options.env ?? cleanEnv(process.env))

    try {
      proc = spawn(executable, args, {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const messageText = `${options.provider} runtime failed to start: ${(err as Error).message}`
      dispatch({ type: 'error', error: messageText })
      events.emit({ type: 'error', message: messageText })
      throw new Error(messageText)
    }

    const stderrPromise = consumeStderr(proc.stderr!)
    const sawComplete = await consumeStdout(proc.stdout!)
    const exitCode = await new Promise<number>((resolve) => {
      proc!.on('close', (code) => resolve(code ?? 0))
    })
    const stderr = await stderrPromise

    if (exitCode !== 0) {
      const messageText = stderr.trim() || `${options.provider} exited with code ${exitCode}`
      dispatch({ type: 'error', error: messageText })
      events.emit({ type: 'error', message: messageText })
      throw new Error(messageText)
    }

    if (!sawComplete && state.status === 'running') {
      dispatch({ type: 'complete' })
      events.emit({ type: 'complete' })
    }

    const nextMessage = state.status === 'running'
      ? state.acceptedMessages[acceptedCountAfterCurrentMessage]
      : undefined
    if (nextMessage !== undefined) {
      await runMessage(nextMessage, queuedSendOptions.shift(), true)
    }
  }

  async function sendMessage(message: string, sendOptions?: SendMessageOptions) {
    if (state.status === 'failed' || state.status === 'disposed') {
      throw new Error(state.lastError ?? `Runtime is ${state.status}`)
    }

    if (state.status === 'running' || state.status === 'waiting_for_permission') {
      queuedSendOptions.push(sendOptions)
      dispatch({ type: 'send_message', message })
      events.emit({ type: 'status', message: `${options.provider} runtime queued message` })
      return
    }

    if (state.status === 'idle') {
      const auth = await preflight()
      if (!auth.configured) {
        throw new Error(auth.error ?? `${options.provider} auth is not configured`)
      }
    }

    await runMessage(message, sendOptions)
  }

  return {
    sessionId,
    provider: options.provider,
    events,
    preflight,
    getState() {
      return state
    },
    commands: {
      sendMessage,
      async abort(reason?: string) {
        proc?.kill()
        proc = null
        queuedSendOptions.splice(0, queuedSendOptions.length)
        dispatch({ type: 'abort', reason })
        events.emit({ type: 'error', message: reason ?? 'Aborted' })
        events.emit({ type: 'complete' })
      },
      async respondToPermission(_requestId: string, _allowed: boolean, _remember?: boolean) {
        dispatch({ type: 'permission_response' })
      },
      async dispose() {
        proc?.kill()
        proc = null
        queuedSendOptions.splice(0, queuedSendOptions.length)
        dispatch({ type: 'dispose' })
        events.close()
      },
    },
  }
}
