import { redactSecrets, cloneCommandOrigin } from './shared-utils.ts'
import type { InMemoryCommandOrigin } from './session-tool-bridge.ts'
import type { RemoteCommandOrigin } from './messaging.ts'

export type NotificationChannel = 'desktop' | 'telegram' | 'email' | 'webhook' | 'lark'
export type NotificationSeverity = 'info' | 'warning' | 'error'

export interface NotificationRequest {
  sessionId?: string
  topicId?: string
  channels: NotificationChannel[]
  title: string
  body?: string
  severity?: NotificationSeverity
  origin?: InMemoryCommandOrigin | RemoteCommandOrigin
}

export interface NotificationReceipt {
  notificationId: string
  sessionId?: string
  topicId?: string
  deliveredChannels: NotificationChannel[]
  title: string
  bodyPreview?: string
  severity: NotificationSeverity
  redacted: boolean
  timestamp: number
  origin?: InMemoryCommandOrigin | RemoteCommandOrigin
}

export interface InMemoryNotificationHost {
  notify(request: NotificationRequest): Promise<NotificationReceipt>
  getSnapshot(): { notifications: NotificationReceipt[] }
}

export interface InMemoryNotificationHostOptions {
  now?: () => number
}

export function createInMemoryNotificationHost(
  options: InMemoryNotificationHostOptions = {},
): InMemoryNotificationHost {
  const now = options.now ?? Date.now
  const notifications: NotificationReceipt[] = []
  let counter = 0

  return {
    async notify(request) {
      const redaction = redactSecrets(request.body ?? '')
      const receipt: NotificationReceipt = {
        notificationId: `notification:${++counter}`,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.topicId ? { topicId: request.topicId } : {}),
        deliveredChannels: [...new Set(request.channels)],
        title: request.title,
        ...(request.body !== undefined ? { bodyPreview: redaction.text } : {}),
        severity: request.severity ?? 'info',
        redacted: redaction.redacted,
        timestamp: now(),
        ...(request.origin ? { origin: cloneCommandOrigin(request.origin) } : {}),
      }
      notifications.push(receipt)
      return cloneNotificationReceipt(receipt)
    },

    getSnapshot() {
      return { notifications: notifications.map(cloneNotificationReceipt) }
    },
  }
}

function cloneNotificationReceipt(receipt: NotificationReceipt): NotificationReceipt {
  return {
    ...receipt,
    deliveredChannels: [...receipt.deliveredChannels],
    ...(receipt.origin ? { origin: cloneCommandOrigin(receipt.origin) } : {}),
  }
}
