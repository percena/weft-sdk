import { describe, it, expect, vi } from 'vitest'
import { PushTimelineStream } from '../push-timeline-stream.ts'
import type { TimelineEnvelope } from '@weft/timeline'

function makeEnvelope(seq: number): TimelineEnvelope {
  return {
    sessionId: 'test',
    provider: 'test',
    seq,
    epoch: 'test-epoch',
    timestamp: Date.now(),
    item: { type: 'user_message', messageId: `msg-${seq}`, message: 'hello' },
  }
}

describe('PushTimelineStream', () => {
  it('emits events to connected listeners', () => {
    const stream = new PushTimelineStream()
    const onEvent = vi.fn()
    stream.connect(onEvent)

    const envelope = makeEnvelope(1)
    stream.emit(envelope)

    expect(onEvent).toHaveBeenCalledWith(envelope)
  })

  it('supports multiple concurrent listeners', () => {
    const stream = new PushTimelineStream()
    const onEvent1 = vi.fn()
    const onEvent2 = vi.fn()
    stream.connect(onEvent1)
    stream.connect(onEvent2)

    const envelope = makeEnvelope(1)
    stream.emit(envelope)

    expect(onEvent1).toHaveBeenCalledWith(envelope)
    expect(onEvent2).toHaveBeenCalledWith(envelope)
  })

  it('isConnected defaults to true — in-process providers have no transport to die', () => {
    const stream = new PushTimelineStream()
    expect(stream.isConnected()).toBe(true)
  })

  it('setConnected reflects transport state', () => {
    const stream = new PushTimelineStream()
    expect(stream.isConnected()).toBe(true)
    stream.setConnected(false)
    expect(stream.isConnected()).toBe(false)
    stream.setConnected(true)
    expect(stream.isConnected()).toBe(true)
  })

  it('isConnected is transport-backed, not subscription-backed', () => {
    // A remote transport can be dead even while a listener is subscribed; and
    // alive with no listeners. connect/disconnect must NOT flip isConnected.
    const stream = new PushTimelineStream()
    stream.setConnected(false)
    stream.connect(() => {})
    expect(stream.isConnected()).toBe(false) // subscribed but transport dead
    stream.disconnect()
    expect(stream.isConnected()).toBe(false) // unsubscribed, still dead
    stream.setConnected(true)
    expect(stream.isConnected()).toBe(true) // transport alive, no listeners
  })

  it('calls onClose for each listener on disconnect', () => {
    const stream = new PushTimelineStream()
    const onClose1 = vi.fn()
    const onClose2 = vi.fn()
    stream.connect(() => {}, undefined, onClose1)
    stream.connect(() => {}, undefined, onClose2)

    stream.disconnect()

    expect(onClose1).toHaveBeenCalledOnce()
    expect(onClose2).toHaveBeenCalledOnce()
  })

  it('emitError forwards to onError callbacks', () => {
    const stream = new PushTimelineStream()
    const onError = vi.fn()
    stream.connect(() => {}, onError)

    const error = new Error('test error')
    stream.emitError(error)

    expect(onError).toHaveBeenCalledWith(error)
  })

  it('does not emit after disconnect', () => {
    const stream = new PushTimelineStream()
    const onEvent = vi.fn()
    stream.connect(onEvent)
    stream.disconnect()

    stream.emit(makeEnvelope(1))
    expect(onEvent).not.toHaveBeenCalled()
  })

  describe('per-listener unsubscribe (session contract)', () => {
    it('connect() returns an unsubscribe function', () => {
      const stream = new PushTimelineStream()
      const off = stream.connect(() => {})
      expect(typeof off).toBe('function')
    })

    it('unsubscribe removes only the calling listener; others keep receiving', () => {
      const stream = new PushTimelineStream()
      const onEvent1 = vi.fn()
      const onEvent2 = vi.fn()
      const off1 = stream.connect(onEvent1)
      stream.connect(onEvent2)

      off1()
      const envelope = makeEnvelope(1)
      stream.emit(envelope)

      expect(onEvent1).not.toHaveBeenCalled()
      expect(onEvent2).toHaveBeenCalledWith(envelope)
    })

    it('unsubscribe does NOT fire onClose (onClose is the teardown signal)', () => {
      const stream = new PushTimelineStream()
      const onClose = vi.fn()
      const off = stream.connect(() => {}, undefined, onClose)

      off()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('a second listener can unsubscribe without affecting the first', () => {
      const stream = new PushTimelineStream()
      const onEvent1 = vi.fn()
      const onEvent2 = vi.fn()
      stream.connect(onEvent1)
      const off2 = stream.connect(onEvent2)

      off2()
      const envelope = makeEnvelope(2)
      stream.emit(envelope)

      expect(onEvent1).toHaveBeenCalledWith(envelope)
      expect(onEvent2).not.toHaveBeenCalled()
    })

    it('unsubscribe is idempotent (calling twice is a no-op)', () => {
      const stream = new PushTimelineStream()
      const onEvent = vi.fn()
      const off = stream.connect(onEvent)

      off()
      off()
      stream.emit(makeEnvelope(3))
      expect(onEvent).not.toHaveBeenCalled()
    })

    it('unsubscribe does not trigger disconnect (other listeners still get onClose on disconnect)', () => {
      const stream = new PushTimelineStream()
      const onClose1 = vi.fn()
      const onClose2 = vi.fn()
      const off1 = stream.connect(() => {}, undefined, onClose1)
      stream.connect(() => {}, undefined, onClose2)

      off1()
      // disconnect still fires onClose for the remaining listener.
      stream.disconnect()
      expect(onClose1).not.toHaveBeenCalled()
      expect(onClose2).toHaveBeenCalledOnce()
    })

    it('emitError still reaches remaining listeners after one unsubscribes', () => {
      const stream = new PushTimelineStream()
      const onError1 = vi.fn()
      const onError2 = vi.fn()
      const off1 = stream.connect(() => {}, onError1)
      stream.connect(() => {}, onError2)

      off1()
      const error = new Error('boom')
      stream.emitError(error)

      expect(onError1).not.toHaveBeenCalled()
      expect(onError2).toHaveBeenCalledWith(error)
    })
  })
})
