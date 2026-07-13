/**
 * Preload bridge — the only channel the renderer has to the Node main process.
 *
 * Exposes a minimal, explicitly-typed `window.weftDesktop` API via contextBridge.
 * The renderer never touches Node directly (contextIsolation: true). Everything
 * that crosses this boundary is plain-JSON serializable.
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type WeftDesktopApi,
  type StartSessionOptions,
  type StartSessionResult,
  type SendMessageOptions,
  type RespondPermissionOptions,
  type AbortOptions,
  type DisconnectOptions,
  type FsBrowseResult,
  type ListModelsResult,
  type LocalProvider,
  type EnvelopeEvent,
  type StreamEndEvent,
  type CapabilityEvent,
} from '../shared/ipc-contract'

const weftDesktop: WeftDesktopApi = {
  startSession: (options: StartSessionOptions) =>
    ipcRenderer.invoke(IPC.START_SESSION, options) as Promise<StartSessionResult>,
  sendMessage: (options: SendMessageOptions) =>
    ipcRenderer.invoke(IPC.SEND_MESSAGE, options) as Promise<void>,
  abort: (options: AbortOptions) =>
    ipcRenderer.invoke(IPC.ABORT, options) as Promise<void>,
  respondToPermission: (options: RespondPermissionOptions) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, options) as Promise<void>,
  disconnect: (options: DisconnectOptions) =>
    ipcRenderer.invoke(IPC.DISCONNECT, options) as Promise<void>,
  fsBrowse: (path?: string) =>
    ipcRenderer.invoke(IPC.FS_BROWSE, path) as Promise<FsBrowseResult>,
  listModels: (provider: LocalProvider) =>
    ipcRenderer.invoke(IPC.LIST_MODELS, provider) as Promise<ListModelsResult>,

  onEnvelope: (handler: (event: EnvelopeEvent) => void) =>
    subscribe(IPC.ENVELOPE, handler),
  onCapability: (handler: (event: CapabilityEvent) => void) =>
    subscribe(IPC.CAPABILITY, handler),
  onStreamError: (handler: (event: StreamEndEvent) => void) =>
    subscribe(IPC.STREAM_ERROR, handler),
  onStreamClosed: (handler: (event: StreamEndEvent) => void) =>
    subscribe(IPC.STREAM_CLOSED, handler),
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('weftDesktop', weftDesktop)
