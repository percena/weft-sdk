import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir, userInfo, platform } from 'node:os'

export function getMachineId(): string {
  const os = platform()

  try {
    if (os === 'darwin') {
      const out = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', timeout: 3000 },
      )
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (match?.[1]) return match[1]
    }

    if (os === 'linux') {
      for (const path of ['/var/lib/dbus/machine-id', '/etc/machine-id']) {
        if (existsSync(path)) {
          const id = readFileSync(path, 'utf-8').trim()
          if (id.length > 0) return id
        }
      }
    }

    if (os === 'win32') {
      const out = execSync(
        'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', timeout: 3000 },
      )
      const match = out.match(/MachineGuid\s+REG_SZ\s+(.+)/)
      if (match?.[1]) return match[1].trim()
    }
  } catch {
    // fall through to fallback
  }

  const info = userInfo()
  return `${info.username}:${homedir()}`
}
