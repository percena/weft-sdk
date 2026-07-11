import { describe, it, expect } from 'vitest'
import { generateGraph, parseOperations, inferDataEdges, computeSpecHash } from './analyzer.js'

const SHOP_SPEC = JSON.stringify({
  openapi: '3.0.0',
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        responses: { 200: { content: { 'application/json': { schema: { type: 'array' } } } } },
      },
    },
    '/api/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderReq' } } },
        },
        responses: {
          201: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } },
        },
      },
    },
    '/api/orders/{id}/pay': {
      post: {
        operationId: 'payOrder',
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
  components: {
    schemas: {
      OrderReq: { type: 'object', properties: { items: { type: 'array' } } },
      Order: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
      OrderResponse: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } },
    },
  },
})

describe('api-graph analyzer', () => {
  it('parses operations with produces/consumes (resolving $ref)', () => {
    const spec = JSON.parse(SHOP_SPEC)
    const ops = parseOperations(spec)
    const create = ops.find(o => o.id === 'createOrder')!
    // produces from OrderResponse.order -> id, status (nested, dotted json_path)
    expect(create.produces.find(f => f.field === 'id' && f.json_path === '$.order.id')).toBeTruthy()
    expect(create.produces.find(f => f.field === 'status' && f.json_path === '$.order.status')).toBeTruthy()
    // consumes from OrderReq.$ref -> items
    expect(create.consumes.find(c => c.field === 'items')).toBeTruthy()
    const pay = ops.find(o => o.id === 'payOrder')!
    // path param -> consumes id (required)
    expect(pay.consumes.find(c => c.field === 'id' && c.required)).toBeTruthy()
    expect(pay.effect).toBe('write')
    expect(ops.find(o => o.id === 'listProducts')!.effect).toBe('read')
  })

  it('infers a data edge createOrder -> payOrder on id (verified:false)', () => {
    const spec = JSON.parse(SHOP_SPEC)
    const ops = parseOperations(spec)
    const edges = inferDataEdges(ops)
    const e = edges.find(x => x.from === 'createOrder' && x.to === 'payOrder')
    expect(e).toBeTruthy()
    expect(e!.kind).toBe('data')
    expect(e!.binding?.from_field).toBe('id')
    expect(e!.binding?.to_field).toBe('id')
    expect(e!.verified).toBe(false) // AI/heuristic-inferred -> needs developer review
    expect(e!.confidence).toBe(0.5)
  })

  it('generateGraph emits a valid envelope with spec_hash + verified:false + entrypoints', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    expect(g.schema_version).toBe(1)
    expect(g.toolset).toBe('shop')
    expect(g.nodes.find(n => n.id === 'createOrder')!.tool_name).toBe('shop_createorder') // lowercase — flitro's sanitizeName
    expect(g.verified).toBe(false)
    expect(g.generated_by.spec_hash).toMatch(/^sha256:[0-9a-f]+$/)
    expect(g.generated_by.analyzer).toBe('weft-api-graph-v1')
    expect(g.generated_by.generated_at).toBe('2026-06-28T00:00:00Z')
    // listProducts is a read op with no incoming edge -> entrypoint
    expect(g.entrypoints).toContain('listProducts')
  })

  it('spec_hash is deterministic + of the raw text (drift-check-compatible)', () => {
    const h1 = computeSpecHash(SHOP_SPEC)
    const h2 = computeSpecHash(SHOP_SPEC)
    expect(h1).toBe(h2)
    // A different spec -> different hash
    const modified = JSON.stringify({ ...JSON.parse(SHOP_SPEC), extra: 1 })
    expect(computeSpecHash(modified)).not.toBe(h1)
  })
})

// v2: fail-open default (required:false) + array-item unrolling (produces-only)
// + path-based resource tag (same-resource matching) + entrypoint corollary.
// CRUD_SPEC has two resources (products, orders) so the same-resource guard is
// observable: listOrders(orders)→payOrder(orders) is kept; listProducts(products)
// →payOrder(orders) is excluded.
const CRUD_SPEC = JSON.stringify({
  openapi: '3.0.0',
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {
          products: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
        } } } } } },
      },
    },
    '/api/orders': {
      get: {
        operationId: 'listOrders',
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {
          orders: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
        } } } } } },
      },
      post: {
        operationId: 'createOrder',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderReq' } } } },
        responses: { 201: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } } },
      },
    },
    '/api/orders/{id}': {
      get: {
        operationId: 'getOrder',
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/api/orders/{id}/pay': {
      post: {
        operationId: 'payOrder',
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
  components: { schemas: {
    Product: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' } } },
    Order: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
    LineItem: { type: 'object', properties: { product_id: { type: 'string' }, qty: { type: 'number' } } },
    OrderReq: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/LineItem' } } } },
    OrderResponse: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } },
  } },
})

describe('api-graph analyzer v2 (fail-open + array unroll + resource tag)', () => {
  it('infers data edges with required:false by default (fail-open)', () => {
    const g = generateGraph(CRUD_SPEC, 'shop', '2026-06-29T00:00:00Z')
    const e = g.edges.find(x => x.from === 'createOrder' && x.to === 'payOrder')
    expect(e).toBeTruthy()
    expect(e!.required).toBe(false) // was true in v1 — reviewer must opt INTO required:true with evidence
    expect(e!.verified).toBe(false)
  })

  it('unrolls array-of-objects RESPONSE item scalars ($.x[].y); container not surfaced', () => {
    const g = generateGraph(CRUD_SPEC, 'shop', '2026-06-29T00:00:00Z')
    const listOrders = g.nodes.find(n => n.id === 'listOrders')!
    expect(listOrders.produces.find(f => f.field === 'id' && f.json_path === '$.orders[].id')).toBeTruthy()
    expect(listOrders.produces.find(f => f.field === 'status' && f.json_path === '$.orders[].status')).toBeTruthy()
    expect(listOrders.produces.find(f => f.field === 'orders')).toBeFalsy() // container not surfaced
    const listProducts = g.nodes.find(n => n.id === 'listProducts')!
    expect(listProducts.produces.find(f => f.field === 'id' && f.json_path === '$.products[].id')).toBeTruthy()
    expect(listProducts.produces.find(f => f.field === 'name' && f.json_path === '$.products[].name')).toBeTruthy()
  })

  it('does NOT unroll array-of-objects REQUEST BODY — consumes keeps the array field', () => {
    const g = generateGraph(CRUD_SPEC, 'shop', '2026-06-29T00:00:00Z')
    const createOrder = g.nodes.find(n => n.id === 'createOrder')!
    expect(createOrder.consumes.find(c => c.field === 'items')).toBeTruthy()     // the array field
    expect(createOrder.consumes.find(c => c.field === 'product_id')).toBeFalsy() // NOT unrolled
    expect(createOrder.consumes.find(c => c.field === 'qty')).toBeFalsy()
  })

  it('same-resource guard keeps listOrders→payOrder, excludes listProducts→payOrder (cross-resource id)', () => {
    const g = generateGraph(CRUD_SPEC, 'shop', '2026-06-29T00:00:00Z')
    expect(g.edges.find(e => e.from === 'createOrder' && e.to === 'payOrder' && e.binding?.from_field === 'id')).toBeTruthy()
    expect(g.edges.find(e => e.from === 'listOrders' && e.to === 'payOrder' && e.binding?.from_field === 'id')).toBeTruthy()
    expect(g.edges.find(e => e.from === 'listProducts' && e.to === 'payOrder')).toBeFalsy() // products.id ≠ orders.id
  })

  it('entrypoints exclude read ops with a required consume field (getOrder needs id)', () => {
    const g = generateGraph(CRUD_SPEC, 'shop', '2026-06-29T00:00:00Z')
    expect(g.entrypoints).toContain('listProducts')
    expect(g.entrypoints).toContain('listOrders')
    expect(g.entrypoints).not.toContain('getOrder') // read but consumes id (required)
    expect(g.entrypoints).not.toContain('payOrder') // write
  })
})
