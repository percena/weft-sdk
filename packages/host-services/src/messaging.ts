export type MessagingChannel = 'telegram' | 'whatsapp' | 'lark' | 'http'
export type MessagingAccessAction = 'send_command' | 'bind_topic' | 'unbind_topic' | 'button_action'

export interface MessagingAccessPolicyOptions {
  owners?: string[]
  allowedSenders?: string[]
  pendingSenders?: string[]
}

export interface MessagingAccessRequest {
  actorId: string
  channel: MessagingChannel
  action: MessagingAccessAction
}

export type MessagingAccessDecision =
  | {
    decision: 'allow'
    reason: 'owner' | 'sender_allowed'
    commandOrigin: RemoteCommandOrigin
  }
  | {
    decision: 'ask'
    reason: 'sender_pending_approval'
    commandOrigin: RemoteCommandOrigin
  }
  | {
    decision: 'deny'
    reason: 'sender_not_allowed'
    commandOrigin: RemoteCommandOrigin
  }

export interface RemoteCommandOrigin {
  type: 'remote'
  channel: MessagingChannel
  actorId: string
}

export interface MessagingAccessPolicy {
  authorize(request: MessagingAccessRequest): MessagingAccessDecision
}

export function createMessagingAccessPolicy(
  options: MessagingAccessPolicyOptions = {},
): MessagingAccessPolicy {
  const owners = new Set(options.owners ?? [])
  const allowedSenders = new Set(options.allowedSenders ?? [])
  const pendingSenders = new Set(options.pendingSenders ?? [])

  return {
    authorize(request) {
      const commandOrigin: RemoteCommandOrigin = {
        type: 'remote',
        channel: request.channel,
        actorId: request.actorId,
      }

      if (owners.has(request.actorId)) {
        return { decision: 'allow', reason: 'owner', commandOrigin }
      }
      if (allowedSenders.has(request.actorId)) {
        return { decision: 'allow', reason: 'sender_allowed', commandOrigin }
      }
      if (pendingSenders.has(request.actorId)) {
        return { decision: 'ask', reason: 'sender_pending_approval', commandOrigin }
      }
      return { decision: 'deny', reason: 'sender_not_allowed', commandOrigin }
    },
  }
}
