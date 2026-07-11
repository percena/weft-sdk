import { describe, expect, test } from 'vitest'
import { parseSseBuffer } from './timeline-stream.ts'

// session contract: the hand-rolled SSE parser previously split on `\n\n` only (CRLF
// servers never framed), kept only the last `data:` line (multi-`data:` frames
// were truncated), and silently dropped `id:`. These tests pin spec-compliant
// framing per the HTML "event stream" algorithm.

function timelineFrame(payload: unknown, overrides: Record<string, string> = {}): string {
  const data = JSON.stringify(payload)
  const fields = [`event: timeline`, `data: ${data}`, ...Object.entries(overrides).map(([k, v]) => `${k}: ${v}`)]
  return `${fields.join('\n')}\n\n`
}

const validEnvelope = (seq: number) => ({
  sessionId: 's1',
  provider: 'flitro',
  seq,
  epoch: 'flitro-s1-b1',
  timestamp: 1,
  v: 1,
  item: { type: 'session_status', status: 'running' },
})

describe('parseSseBuffer — session contract framing correctness', () => {
  test('parses a single LF-terminated frame', () => {
    const buf = timelineFrame(validEnvelope(1))
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(1)
    expect(result.remainder).toBe('')
  })

  test('parses multiple frames in one buffer', () => {
    const buf = timelineFrame(validEnvelope(1)) + timelineFrame(validEnvelope(2))
    const result = parseSseBuffer(buf)
    expect(result.items.map(e => e.seq)).toEqual([1, 2])
  })

  test('returns the trailing incomplete frame as remainder', () => {
    const complete = timelineFrame(validEnvelope(1))
    const partial = 'event: timeline\ndata: {"seq":2'  // no closing brace, no blank line
    const result = parseSseBuffer(complete + partial)
    expect(result.items).toHaveLength(1)
    expect(result.remainder).toBe(partial)
  })

  test('handles a partial frame that completes across chunks', () => {
    const first = parseSseBuffer('event: timeline\ndata: {"sessionId":"s1","provider":"flitro"')
    expect(first.items).toHaveLength(0)
    expect(first.remainder).toBe('event: timeline\ndata: {"sessionId":"s1","provider":"flitro"')
    const second = parseSseBuffer(`${first.remainder},"seq":5,"epoch":"e","timestamp":1,"item":{"type":"session_status","status":"running"}}\n\n`)
    expect(second.items).toHaveLength(1)
    expect(second.items[0].seq).toBe(5)
  })
})

describe('parseSseBuffer — session contract CRLF line endings', () => {
  test('frames a CRLF-terminated stream (\\r\\n\\r\\n blank line)', () => {
    // Previously: `buffer.split('\n\n')` never matched `\r\n\r\n`, so the whole
    // chunk sat in the unparsed remainder and no envelopes were dispatched.
    const data = JSON.stringify(validEnvelope(7))
    const buf = `event: timeline\r\ndata: ${data}\r\n\r\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(7)
    expect(result.remainder).toBe('')
  })

  test('frames a bare-CR stream (\\r\\r blank line)', () => {
    const data = JSON.stringify(validEnvelope(8))
    const buf = `event: timeline\rdata: ${data}\r\r`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(8)
  })

  test('mixed line endings still frame (CRLF then LF blank line)', () => {
    const data = JSON.stringify(validEnvelope(9))
    const buf = `event: timeline\r\ndata: ${data}\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(9)
  })

  test('CRLF does not leak into decoded payload (no trailing \\r on data)', () => {
    const data = JSON.stringify(validEnvelope(10))
    const buf = `event: timeline\r\ndata: ${data}\r\n\r\n`
    const result = parseSseBuffer(buf)
    // A stray \r on the data line would break JSON.parse → item dropped.
    expect(result.items).toHaveLength(1)
  })
})

describe('parseSseBuffer — session contract multiple data: lines', () => {
  test('joins multiple data: lines with \\n (SSE spec)', () => {
    // A producer splitting a JSON payload across two `data:` lines must
    // reconstruct into the original string. The previous parser kept only the
    // last `data:` line, corrupting the payload.
    const part1 = '{"sessionId":"s1","provider":"flitro","seq":11,"epoch":"e","timestamp":1,'
    const part2 = '"item":{"type":"session_status","status":"running"},"v":1}'
    const buf = `event: timeline\ndata: ${part1}\ndata: ${part2}\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(11)
  })

  test('a trailing empty data: line does not corrupt the joined payload', () => {
    // Spec: appending U+000A then stripping one trailing newline means a
    // trailing empty `data:` line is a no-op for the final string.
    const data = JSON.stringify(validEnvelope(12))
    const buf = `event: timeline\ndata: ${data}\ndata:\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(12)
  })

  test('data: with no space after the colon is accepted', () => {
    const data = JSON.stringify(validEnvelope(13))
    const buf = `event:timeline\ndata:${data}\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(13)
  })
})

describe('parseSseBuffer — session contract id: field', () => {
  test('captures the id: field (no longer dropped)', () => {
    const data = JSON.stringify(validEnvelope(14))
    const buf = `event: timeline\ndata: ${data}\nid: 142\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.lastEventId).toBe('142')
  })

  test('the last id: wins across multiple frames (spec: last event id)', () => {
    const d1 = JSON.stringify(validEnvelope(15))
    const d2 = JSON.stringify(validEnvelope(16))
    const buf = `event: timeline\ndata: ${d1}\nid: 150\n\nevent: timeline\ndata: ${d2}\nid: 160\n\n`
    const result = parseSseBuffer(buf)
    expect(result.lastEventId).toBe('160')
  })

  test('id: with no space after the colon is accepted', () => {
    const data = JSON.stringify(validEnvelope(17))
    const buf = `event: timeline\ndata: ${data}\nid:17\n\n`
    const result = parseSseBuffer(buf)
    expect(result.lastEventId).toBe('17')
  })

  test('an id: without a subsequent data dispatch is still captured (spec)', () => {
    // The HTML spec updates the last event id buffer when the field is parsed,
    // before the dispatch decision. A frame with an id but no matching event
    // type still advances lastEventId.
    const buf = `event: heartbeat\nid: 999\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(0)
    expect(result.lastEventId).toBe('999')
  })
})

describe('parseSseBuffer — session contract comments + robustness', () => {
  test('comment lines (starting with :) are skipped', () => {
    const data = JSON.stringify(validEnvelope(18))
    const buf = `: keepalive ${Date.now()}\nevent: timeline\ndata: ${data}\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(18)
  })

  test('a non-timeline event type is not decoded', () => {
    const buf = `event: run.started\ndata: {"foo":"bar"}\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(0)
  })

  test('a malformed timeline data payload is skipped, not thrown', () => {
    const buf = `event: timeline\ndata: {not-json\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(0)
  })

  test('a frame with no data: line dispatches nothing', () => {
    const buf = `event: timeline\nid: 1\n\n`
    const result = parseSseBuffer(buf)
    expect(result.items).toHaveLength(0)
    expect(result.lastEventId).toBe('1')
  })
})

describe('parseSseBuffer — SDK-R-1 CRLF split across chunk boundaries', () => {
  test('a \\r\\n line ending split across chunks does NOT create a spurious frame boundary', () => {
    // Regression: previously a chunk ending in \r (first half of a CRLF pair)
    // had its trailing \r normalized to \n and returned in `remainder`; when the
    // next chunk started with the pair's \n, concatenation yielded \n\n — a
    // spurious blank line — so the `event:` line framed as data-less (skipped)
    // and the `data:` line framed with no event type (dropped). The envelope was
    // silently lost. The 19 existing tests never split inside a line ending.
    const data = JSON.stringify(validEnvelope(20))
    // Chunk 1 ends mid-CRLF (after the \r of the `event:` line's \r\n).
    const first = parseSseBuffer(`event: timeline\r`)
    expect(first.items).toHaveLength(0)
    // The trailing \r is held back in the remainder (NOT normalized to \n).
    expect(first.remainder).toBe('event: timeline\r')

    // Chunk 2 starts with the \n that completes the CRLF, then the data line.
    const second = parseSseBuffer(`${first.remainder}\ndata: ${data}\r\n\r\n`)
    expect(second.items).toHaveLength(1)
    expect(second.items[0].seq).toBe(20)
    expect(second.remainder).toBe('')
  })

  test('a held trailing \\r is re-joined to a \\n-leading next chunk as a single CRLF', () => {
    // Verifies the held \r + next chunk's \n form ONE line ending (\r\n → \n),
    // not a blank line. The data payload decodes intact.
    const data = JSON.stringify(validEnvelope(21))
    const first = parseSseBuffer(`event: timeline\r`)
    const second = parseSseBuffer(`${first.remainder}\ndata: ${data}\n\n`)
    expect(second.items).toHaveLength(1)
    expect(second.items[0].seq).toBe(21)
  })

  test('a complete bare-CR frame (\\r\\r blank line) still dispatches in one call', () => {
    // The hold rule must NOT suppress a real \r\r bare-CR blank line. The
    // trailing \r is preceded by another \r, so it is NOT held — the blank line
    // is detected and the frame dispatches (no regression vs the existing test).
    const data = JSON.stringify(validEnvelope(22))
    const result = parseSseBuffer(`event: timeline\rdata: ${data}\r\r`)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].seq).toBe(22)
  })
})
