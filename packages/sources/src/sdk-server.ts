/**
 * In-process MCP server creation and tool definition.
 *
 * Provides the `tool()` helper for defining MCP tools with Zod schemas,
 * and `createSdkMcpServer()` for wrapping them into an in-process server
 * instance that providers can pass to their native SDK's `type: 'sdk'`
 * MCP server config.
 */

import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function withDescription(schema: z.ZodTypeAny, jsonSchema: JsonSchema): JsonSchema {
  const description = schema.description;
  return description ? { ...jsonSchema, description } : jsonSchema;
}

function zodTypeToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) {
    return withDescription(schema, zodTypeToJsonSchema(schema.unwrap()));
  }

  if (schema instanceof z.ZodDefault) {
    return withDescription(schema, zodTypeToJsonSchema(schema.removeDefault()));
  }

  if (schema instanceof z.ZodString) {
    return withDescription(schema, { type: 'string' });
  }

  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, { type: 'string', enum: schema.options });
  }

  if (schema instanceof z.ZodRecord) {
    const valueType = schema.valueSchema;
    return withDescription(schema, {
      type: 'object',
      additionalProperties: zodTypeToJsonSchema(valueType),
    });
  }

  if (schema instanceof z.ZodObject) {
    return withDescription(schema, zodObjectToJsonSchema(schema.shape));
  }

  return withDescription(schema, {});
}

function zodObjectToJsonSchema(shape: z.ZodRawShape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodTypeToJsonSchema(value);
    if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

/**
 * MCP tool definition returned by the `tool()` helper.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
}

/**
 * Define an MCP tool with a schema and handler.
 *
 * @param name - Tool name
 * @param description - Tool description for the LLM
 * @param schema - Zod schema for input parameters
 * @param handler - Async function that processes tool calls
 */
export function tool<T extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: zodObjectToJsonSchema(schema),
    handler: handler as (args: any) => Promise<unknown>,
  };
}

/**
 * MCP Server configuration
 */
export interface McpServerConfig {
  name: string;
  version: string;
  tools: McpToolDefinition[];
}

/**
 * MCP Server instance returned by createSdkMcpServer.
 */
export interface McpServerInstance {
  name: string;
  version: string;
  tools: McpToolDefinition[];
}

/**
 * Create an in-process MCP server from a config.
 */
export function createSdkMcpServer(config: McpServerConfig): McpServerInstance {
  return {
    name: config.name,
    version: config.version,
    tools: config.tools,
  };
}
