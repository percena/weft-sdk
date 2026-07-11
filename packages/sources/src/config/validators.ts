import type { ApiAuthType, FolderSourceConfig, McpTransport, SourceType } from '../types.ts';
import { isValidSlug } from '../utils/slug.ts';

export interface ValidationIssue {
  file: string;
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const SOURCE_TYPES = new Set<SourceType>(['api', 'mcp', 'local']);
const API_AUTH_TYPES = new Set<ApiAuthType>(['bearer', 'header', 'query', 'basic', 'oauth', 'none']);
const MCP_TRANSPORTS = new Set<McpTransport>(['http', 'sse', 'stdio']);
const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'x-auth-token']);

export function validateSourceConfig(config: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const record = asRecord(config);
  const file = sourceConfigFile(record);

  if (!record) {
    errors.push(issue(file, '', 'Source config must be an object', 'error'));
    return result(errors, warnings);
  }

  validateRequiredString(record, 'id', file, errors);
  validateRequiredString(record, 'name', file, errors);
  validateRequiredString(record, 'slug', file, errors);
  validateRequiredString(record, 'provider', file, errors);

  // Slugs become directory names — reject anything that could traverse paths
  if (isNonEmptyString(record.slug) && !isValidSlug(record.slug)) {
    errors.push(issue(
      file,
      'slug',
      `Invalid source slug: ${record.slug}`,
      'error',
      'Slugs must contain only lowercase letters, digits, hyphens, and underscores, and start with a letter or digit.',
    ));
  }

  if (typeof record.enabled !== 'boolean') {
    errors.push(issue(file, 'enabled', 'Source config requires boolean enabled', 'error'));
  }

  if (!SOURCE_TYPES.has(record.type as SourceType)) {
    errors.push(issue(file, 'type', `Invalid source type: ${String(record.type)}`, 'error', 'Use one of: api, mcp, local.'));
    return result(errors, warnings);
  }

  if (record.type === 'api') validateApiSource(record as unknown as FolderSourceConfig, file, errors, warnings);
  if (record.type === 'mcp') validateMcpSource(record as unknown as FolderSourceConfig, file, errors);
  if (record.type === 'local') validateLocalSource(record as unknown as FolderSourceConfig, file, errors);

  return result(errors, warnings);
}

function validateApiSource(
  config: FolderSourceConfig,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  if (!config.api || typeof config.api !== 'object') {
    errors.push(issue(file, 'api', 'API sources require an api config block', 'error'));
    return;
  }

  if (!isNonEmptyString(config.api.baseUrl) || !isValidUrl(config.api.baseUrl)) {
    errors.push(issue(file, 'api.baseUrl', 'API sources require a valid baseUrl', 'error'));
  }

  if (!API_AUTH_TYPES.has(config.api.authType)) {
    errors.push(issue(file, 'api.authType', `Invalid API authType: ${String(config.api.authType)}`, 'error'));
  }

  for (const key of Object.keys(config.api.defaultHeaders ?? {})) {
    if (CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())) {
      warnings.push(issue(
        file,
        `api.defaultHeaders.${key}`,
        'Source config should not store credential-bearing headers',
        'warning',
        'Store secret values in the source credential gateway and keep only credentialRef metadata in runtime descriptors.',
      ));
    }
  }
}

function validateMcpSource(
  config: FolderSourceConfig,
  file: string,
  errors: ValidationIssue[],
): void {
  if (!config.mcp || typeof config.mcp !== 'object') {
    errors.push(issue(file, 'mcp', 'MCP sources require an mcp config block', 'error'));
    return;
  }

  const transport = config.mcp.transport ?? 'http';
  if (!MCP_TRANSPORTS.has(transport)) {
    errors.push(issue(file, 'mcp.transport', `Invalid MCP transport: ${String(transport)}`, 'error'));
    return;
  }

  if (transport === 'stdio') {
    if (!isNonEmptyString(config.mcp.command)) {
      errors.push(issue(
        file,
        'mcp.command',
        'Stdio MCP sources require a command',
        'error',
        'Set mcp.command to the executable used to start the MCP server.',
      ));
    }
    return;
  }

  if (!isNonEmptyString(config.mcp.url) || !isValidUrl(config.mcp.url)) {
    errors.push(issue(file, 'mcp.url', 'HTTP/SSE MCP sources require a valid url', 'error'));
  }
}

function validateLocalSource(
  config: FolderSourceConfig,
  file: string,
  errors: ValidationIssue[],
): void {
  if (!config.local || typeof config.local !== 'object') {
    errors.push(issue(file, 'local', 'Local sources require a local config block', 'error'));
    return;
  }

  if (!isNonEmptyString(config.local.path)) {
    errors.push(issue(file, 'local.path', 'Local sources require a path', 'error'));
  }
}

function validateRequiredString(
  record: Record<string, unknown>,
  key: string,
  file: string,
  errors: ValidationIssue[],
): void {
  if (!isNonEmptyString(record[key])) {
    errors.push(issue(file, key, `Source config requires ${key}`, 'error'));
  }
}

function sourceConfigFile(record: Record<string, unknown> | undefined): string {
  const slug = typeof record?.slug === 'string' && record.slug.length > 0 ? record.slug : '<unknown>';
  return `sources/${slug}/config.json`;
}

function issue(
  file: string,
  path: string,
  message: string,
  severity: ValidationIssue['severity'],
  suggestion?: string,
): ValidationIssue {
  return {
    file,
    path,
    message,
    severity,
    ...(suggestion ? { suggestion } : {}),
  };
}

function result(errors: ValidationIssue[], warnings: ValidationIssue[]): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
