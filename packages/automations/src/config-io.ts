import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveAutomationsConfigPath } from './resolve-config-path.ts';
import { validateAutomationsConfig } from './validation.ts';

export interface LoadAutomationsConfigResult {
  config: Record<string, unknown> | null
  configPath: string
}

export interface SaveAutomationsConfigResult {
  ok: boolean
  automationCount: number
  errors: string[]
}

export function loadAutomationsConfig(workspaceRootPath: string): LoadAutomationsConfigResult {
  const configPath = resolveAutomationsConfigPath(workspaceRootPath);
  if (!existsSync(configPath)) {
    return { config: null, configPath };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return { config: raw as Record<string, unknown>, configPath };
  } catch {
    return { config: null, configPath };
  }
}

export function saveAutomationsConfig(
  workspaceRootPath: string,
  config: unknown,
): SaveAutomationsConfigResult {
  const validation = validateAutomationsConfig(config);
  if (!validation.valid) {
    return { ok: false, automationCount: 0, errors: validation.errors };
  }
  const configPath = resolveAutomationsConfigPath(workspaceRootPath);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

  const automationCount = validation.config
    ? Object.values(validation.config.automations)
        .reduce((sum, matchers) => sum + (matchers?.length ?? 0), 0)
    : 0;

  return { ok: true, automationCount, errors: [] };
}
