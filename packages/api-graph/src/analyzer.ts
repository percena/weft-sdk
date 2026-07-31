// API dependency graph analyzer — generates a data-flow DAG from an OpenAPI
// spec. The output is a graph Envelope (verified:false) for developer PR
// review, then upload to weftd's `graphs` capability API. The graph data model
// is defined in the interfaces below.
//
// v1 edge inference is a heuristic name-match (produces.field -> consumes.field
// of the same name); LLM semantic inference is future. The developer reviews
// every edge + sets verified:true before publish.

import { createHash } from 'node:crypto'

// --- Graph types (match the server's graph-envelope wire schema exactly) ---

export interface Field {
  field: string
  json_path: string
  type?: string
}
export interface ConsumesField {
  field: string
  json_path: string
  required: boolean
}
export interface EdgeBinding {
  from_field: string
  to_field: string
}
export interface Edge {
  from: string
  to: string
  binding?: EdgeBinding
  kind: 'data' | 'precondition' | 'state'
  required: boolean
  confidence?: number
  verified?: boolean
  notes?: string
}
export interface Node {
  id: string
  tool_name: string
  method: string
  path_template: string
  produces: Field[]
  consumes: ConsumesField[]
  effect: 'read' | 'write' | 'destructive'
  tags?: string[]
}
export interface GeneratedBy {
  analyzer: string
  spec_hash: string
  generated_at: string
}
export interface Envelope {
  schema_version: number
  toolset: string
  nodes: Node[]
  edges: Edge[]
  entrypoints?: string[]
  verified: boolean
  generated_by: GeneratedBy
}

// --- OpenAPI parsing (minimal, no external deps) ---

interface OpenApiSpec {
  paths?: Record<string, Record<string, any>>
  components?: { schemas?: Record<string, any> }
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

function resolveRef(spec: OpenApiSpec, ref: string): any {
  if (!ref?.startsWith('#/')) return null
  let cur: any = spec
  for (const part of ref.slice(2).split('/')) {
    cur = cur?.[part]
    if (cur == null) return null
  }
  return cur
}

function resolveSchema(spec: OpenApiSpec, schema: any): any {
  if (!schema) return null
  if (schema.$ref) return resolveRef(spec, schema.$ref)
  return schema
}

function schemaProperties(
  spec: OpenApiSpec,
  schema: any,
  forResponse = false,
): { name: string; json_path: string; type?: string }[] {
  const s = resolveSchema(spec, schema)
  if (!s?.properties) return []
  const out: { name: string; json_path: string; type?: string }[] = []
  for (const [name, p] of Object.entries(s.properties)) {
    const propSchema = resolveSchema(spec, p)
    // Recurse one level into object-typed properties: surface inner fields with
    // dotted json_paths. Real specs nest (e.g. {order:{id,status}} -> id at
    // $.order.id), and consumers reference the inner field by name (e.g. path
    // param {id}); surfacing only the top-level "order" would break name-match.
    if (propSchema?.type === 'object' && propSchema.properties) {
      for (const [inner, ip] of Object.entries(propSchema.properties)) {
        out.push({ name: inner, json_path: `$.${name}.${inner}`, type: (ip as any)?.type })
      }
    } else if (forResponse && propSchema?.type === 'array') {
      // v2: unroll array-of-objects RESPONSE items into scalar produced fields
      // (e.g. {orders:[{id,status}]} -> id at $.orders[].id) so a list op becomes
      // a producer of the resource id. Scalars only (nested array/object item
      // fields are sub-resources — entity typing, future). Produces-only: a
      // request body consumes the array field itself, not unrolled scalars, so
      // forResponse=false falls through to surface the array field as-is.
      const itemSchema = resolveSchema(spec, propSchema.items)
      if (itemSchema?.type === 'object' && itemSchema.properties) {
        for (const [inner, ip] of Object.entries(itemSchema.properties)) {
          const ipSchema = resolveSchema(spec, ip)
          if (ipSchema?.type === 'object' || ipSchema?.type === 'array') continue
          out.push({ name: inner, json_path: `$.${name}[].${inner}`, type: ipSchema?.type })
        }
      } else {
        out.push({ name, json_path: `$.${name}`, type: (p as any)?.type })
      }
    } else {
      out.push({ name, json_path: `$.${name}`, type: (p as any)?.type })
    }
  }
  return out
}

function effectFor(method: string): 'read' | 'write' | 'destructive' {
  if (method === 'delete') return 'destructive'
  if (method === 'get' || method === 'head' || method === 'options') return 'read'
  return 'write'
}

function sanitizeId(operationId: string | undefined, method: string, path: string): string {
  if (operationId) return operationId
  return `${method}_${path.replace(/[{}/]/g, '_').replace(/^_+|_+$/g, '')}`
}

export interface Operation {
  id: string
  method: string
  path: string
  /** Analyzer-internal path-based resource tag (not emitted in the Envelope). */
  resource: string
  produces: Field[]
  consumes: ConsumesField[]
  effect: 'read' | 'write' | 'destructive'
}

// parseOperations extracts one Operation per OpenAPI operation: consumes from
// path/query/header parameters + requestBody fields (resolving $ref), produces
// from 200/201/202 response schema fields (resolving $ref).
export function parseOperations(spec: OpenApiSpec): Operation[] {
  const ops: Operation[] = []
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = methods?.[method]
      if (!op) continue
      const id = sanitizeId(op.operationId, method, path)
      // v2: path-based resource tag (analyzer-internal; not emitted in the
      // Envelope). Resource = the segment before the first {param}, else the
      // last segment — e.g. /api/orders/{id}/pay -> "orders". Used by
      // inferDataEdges' same-resource guard so Product.id != Order.id.
      const segs = path.split('/').filter(Boolean)
      const paramIdx = segs.findIndex(s => s.startsWith('{'))
      const resource = paramIdx >= 0 ? segs[paramIdx - 1] : (segs[segs.length - 1] ?? '')

      const consumes: ConsumesField[] = []
      for (const p of op.parameters ?? []) {
        if (p?.in === 'path' || p?.in === 'query' || p?.in === 'header') {
          consumes.push({ field: p.name, json_path: `$.${p.name}`, required: !!p.required })
        }
      }
      const bodySchema = op.requestBody?.content?.['application/json']?.schema
      for (const { name, json_path } of schemaProperties(spec, bodySchema, false)) {
        if (!consumes.find(c => c.field === name)) {
          consumes.push({ field: name, json_path, required: true })
        }
      }

      const produces: Field[] = []
      for (const code of ['200', '201', '202']) {
        const respSchema = op.responses?.[code]?.content?.['application/json']?.schema
        for (const { name, json_path, type } of schemaProperties(spec, respSchema, true)) {
          if (!produces.find(f => f.field === name)) {
            produces.push({ field: name, json_path, type })
          }
        }
      }

      ops.push({ id, method, path, resource, produces, consumes, effect: effectFor(method) })
    }
  }
  return ops
}

// inferDataEdges: for each op B's consume field, find an op A that produces a
// field of the same name (A != B) -> data edge A->B. v1 heuristic; every edge is
// verified:false + confidence 0.5 (the developer must confirm the data truly
// flows before setting verified:true).
//
// Pure-producer filter: A must produce f WITHOUT also consuming f. This prunes
// "echo" edges — e.g. an order action takes {id} and returns the same {id}; it
// isn't a real producer of a new id (createOrder is). Without this filter every
// action->action pair on a shared id would spawn a spurious edge.
export function inferDataEdges(ops: Operation[]): Edge[] {
  const edges: Edge[] = []
  const seen = new Set<string>()
  for (const b of ops) {
    for (const cf of b.consumes) {
      for (const a of ops) {
        if (a.id === b.id) continue
        // v2: same-resource guard — only match fields within the same path-derived
        // resource, so e.g. listProducts (products.id) doesn't flow to order
        // mutations (orders.id).
        if (a.resource !== b.resource) continue
        const pf = a.produces.find(p => p.field === cf.field)
        if (!pf) continue
        // A must be a pure producer of f (not also a consumer) — else A echoes f.
        if (a.consumes.find(c => c.field === cf.field)) continue
        const key = `${a.id}->${b.id}:${cf.field}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          from: a.id,
          to: b.id,
          binding: { from_field: pf.field, to_field: cf.field },
          kind: 'data',
          required: false,
          confidence: 0.5,
          verified: false,
          notes: 'heuristic name-match (pure-producer, same-resource) — required:false by default (fail-open); set required:true+verified:true only with evidence for a true generative prerequisite',
        })
      }
    }
  }
  return edges
}

// inferEntrypoints: read ops with no incoming required data edge — the natural
// planning seeds.
export function inferEntrypoints(ops: Operation[], edges: Edge[]): string[] {
  const incoming = new Set(edges.filter(e => e.required).map(e => e.to))
  // v2 corollary of the fail-open default: with no required edges, "no incoming
  // required edge" alone would make every read op an entrypoint — incl. ones
  // that need a required input (e.g. getOrder/{id}). Also require no required
  // consume fields, so entrypoints stay "read ops callable with no inputs".
  return ops
    .filter(o => o.effect === 'read' && !incoming.has(o.id) && !o.consumes.some(c => c.required))
    .map(o => o.id)
}

// computeSpecHash returns sha256 of the raw spec text — the SAME bytes weftd
// stores + flitro's toolset holds, so the drift check matches.
export function computeSpecHash(specText: string): string {
  return `sha256:${createHash('sha256').update(specText).digest('hex')}`
}

// generateGraph produces a complete Envelope (verified:false) from raw spec
// text. toolset prefixes tool_name (matching flitro's openapi loader NamePrefix).
export function generateGraph(specText: string, toolset: string, generatedAt: string): Envelope {
  const spec: OpenApiSpec = JSON.parse(specText)
  const ops = parseOperations(spec)
  const nodes: Node[] = ops.map(o => ({
    id: o.id,
    // flitro's openapi loader sanitizes tool names to lowercase (sanitizeName:
    // strings.ToLower), so the graph's tool_name MUST be lowercase to match the
    // compiled tool name the LLM calls + the veto/Route resolve. Node.id stays
    // camelCase (operationId) — it's the graph's internal id, not the tool name.
    tool_name: `${toolset}_${o.id}`.toLowerCase(),
    method: o.method,
    path_template: o.path,
    produces: o.produces,
    consumes: o.consumes,
    effect: o.effect,
  }))
  const edges = inferDataEdges(ops)
  const entrypoints = inferEntrypoints(ops, edges)
  return {
    schema_version: 1,
    toolset,
    nodes,
    edges,
    entrypoints,
    verified: false,
    generated_by: {
      analyzer: 'weft-api-graph-v1',
      spec_hash: computeSpecHash(specText),
      generated_at: generatedAt,
    },
  }
}
