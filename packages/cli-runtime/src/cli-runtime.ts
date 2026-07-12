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
import { extractCliProviderSessionId, mapClaudeStreamJsonLine, mapCodexExecJsonLine } from './parsers.ts'
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

/**
 * Build the CLI argv for one turn.
 *
 * A7: the prompt is NOT part of the argv — it is piped via stdin (claude `-p`
 * reads stdin when no positional prompt is given; codex reads stdin for the
 * `-` positional). This avoids OS argv-length limits on long prompts and stops
 * the full prompt from leaking into `ps` output.
 *
 * When `resumeSessionId` is set, the turn resumes the provider conversation:
 * `claude -p --resume <id>` / `codex exec resume <id>`. Note `codex exec
 * resume` accepts `--json`/`--model`/`-c` but NOT `--cd`/`--sandbox` (the
 * resumed session keeps its original cwd and sandbox), so those are omitted
 * on resume.
 */
export function buildCliArgs(
  options: CliAgentSessionOptions,
  resumeSessionId?: string,
): string[] {
  if (options.provider === 'claude') {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
    ]
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    if (options.model) args.push('--model', options.model)
    const effort = options.reasoningEffort ?? options.thinkingLevel
    if (effort) args.push('--effort', effort)
    const permissionMode = mapClaudePermissionMode(options.permissionMode)
    if (permissionMode) args.push('--permission-mode', permissionMode)
    return args
  }

  if (resumeSessionId) {
    const args = ['exec', 'resume', resumeSessionId, '--json']
    if (options.model) args.push('--model', options.model)
    if (options.reasoningEffort) args.push('--config', `model_reasoning_effort="${options.reasoningEffort}"`)
    if (options.permissionMode) {
      // `--sandbox` is not accepted by `exec resume` (sandbox is fixed at
      // session creation); the approval policy is still overridable via `-c`.
      const codexParams = mapPermissionModeToCodexParams(options.permissionMode)
      args.push('--config', `approval_policy="${codexParams.approvalPolicy}"`)
    }
    args.push('-')
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
  args.push('-')
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
  // A7: the provider conversation id captured from the first turn's JSON
  // stream (claude `session_id`, codex thread id). Subsequent turns resume it
  // so multi-turn context survives the one-process-per-turn model. Seedable
  // via options.resumeSessionId for cross-process resume.
  let providerSessionId: string | undefined = options.resumeSessionId

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
      // A7: capture the provider conversation id for next-turn resume, and
      // surface it so hosts can persist it for cross-process resume.
      const capturedId = extractCliProviderSessionId(options.provider, line)
      if (capturedId && capturedId !== providerSessionId) {
        providerSessionId = capturedId
        events.emit({ type: 'status', message: `provider_session:${capturedId}` })
      }
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
    const args = buildCliArgs(optionsForSend(options, sendOptions), providerSessionId)
    const env = options.provider === 'claude'
      ? (options.env ?? createSanitizedClaudeEnvironment())
      : (options.env ?? cleanEnv(process.env))

    try {
      // A7: the prompt is piped via stdin (see buildCliArgs) — long prompts no
      // longer hit argv limits or leak into `ps` output.
      proc = spawn(executable, args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stdin?.on('error', () => {
        // The child may exit before consuming stdin (EPIPE); the exit-code
        // path below owns error reporting.
      })
      proc.stdin?.end(message)
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
