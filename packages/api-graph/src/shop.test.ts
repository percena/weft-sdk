import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateGraph } from './analyzer.js'

// The real shop OpenAPI spec (packages/api-graph/fixtures/shop-openapi.json) — the
// dogfood's "spec'd private API" the analyzer generates a graph from.
const specPath = fileURLToPath(new URL('../fixtures/shop-openapi.json', import.meta.url))
const SHOP_SPEC = readFileSync(specPath, 'utf8')

// The REVIEWED graph artifact the demo uploads to weftd
// (packages/api-graph/fixtures/shop-graph.json, verified:true) — what flitro's
// veto/plan_route actually reads at runtime. Distinct from the analyzer's
// verified:false draft above.
const graphPath = fileURLToPath(new URL('../fixtures/shop-graph.json', import.meta.url))
const SHOP_GRAPH = JSON.parse(readFileSync(graphPath, 'utf8'))

// Every order mutation that consumes {id}. createOrder is ONE producer of id,
// but not the only valid source — listOrders / a user reference ("ship ORD-1")
// can supply it too. So the createOrder→{mutation} edges must be optional
// (required:false), else the veto hard-blocks operating on any order whose id
// wasn't produced by createOrder in THIS run — i.e. every pre-existing or
// prior-session order (a v1 limitation; contradicts the system-prompt
// rule "operate on ORD-N directly"). See commit that relaxed these edges.
const ORDER_MUTATIONS = [
  'getOrder', 'payOrder', 'cancelOrder', 'shipOrder', 'deliverOrder',
  'confirmOrder', 'requestRefund', 'approveRefund', 'denyRefund',
]

describe('api-graph on the shop spec (dogfood)', () => {
  it('produces order.id from the nested createOrder response ($.order.id)', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    const create = g.nodes.find(n => n.id === 'createOrder')!
    expect(create.produces.find(f => f.field === 'id' && f.json_path === '$.order.id')).toBeTruthy()
    expect(create.tool_name).toBe('shop_createorder') // lowercase — flitro sanitizeName
  })

  it('order actions consume the id path param (required)', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    const pay = g.nodes.find(n => n.id === 'payOrder')!
    expect(pay.consumes.find(c => c.field === 'id' && c.required)).toBeTruthy()
    expect(pay.tool_name).toBe('shop_payorder') // lowercase — flitro sanitizeName
  })

  it('infers createOrder -> {pay,ship,deliver,requestRefund,getOrder} data edges on id', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    for (const target of ['getOrder', 'payOrder', 'shipOrder', 'deliverOrder', 'requestRefund']) {
      const e = g.edges.find(x => x.from === 'createOrder' && x.to === target)
      expect(e).toBeTruthy()
      expect(e!.kind).toBe('data')
      expect(e!.binding?.from_field).toBe('id')
      expect(e!.binding?.to_field).toBe('id')
      expect(e!.verified).toBe(false) // heuristic -> developer must verify
    }
  })

  it('emits spec_hash + verified:false for developer review', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    expect(g.verified).toBe(false)
    expect(g.generated_by.spec_hash).toMatch(/^sha256:[0-9a-f]+$/)
    expect(g.nodes.length).toBeGreaterThan(8)
  })

  it('prunes spurious action->action echo edges (pure-producer filter)', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    // payOrder returns the same {id} it takes (echo), so it is NOT a pure
    // producer of id -> no payOrder -> shipOrder edge (createOrder is the real
    // producer). Without the filter every action pair on id would spawn an edge.
    expect(g.edges.find(e => e.from === 'payOrder' && e.to === 'shipOrder')).toBeFalsy()
    expect(g.edges.find(e => e.from === 'shipOrder' && e.to === 'deliverOrder')).toBeFalsy()
    // Pure producers of order id: createOrder (generates a fresh id) AND
    // listOrders (v2 array-item unroll surfaces orders[].id). Both are eligible
    // id sources; order mutations (echo id) are filtered out.
    const idSources = new Set(g.edges.filter(e => e.binding?.from_field === 'id').map(e => e.from))
    expect([...idSources].sort()).toEqual(['createOrder', 'listOrders'])
  })

  it('listProducts is an entrypoint; getOrder (read but needs id) is not', () => {
    const g = generateGraph(SHOP_SPEC, 'shop', '2026-06-28T00:00:00Z')
    expect(g.entrypoints).toContain('listProducts')
    expect(g.entrypoints).not.toContain('getOrder') // read op with a required consume field
  })

  // Guards the reviewed artifact (what the runtime veto reads), NOT the analyzer
  // draft above. If this regresses (e.g. someone re-verifies with required:true),
  // the demo silently goes back to refusing to operate on pre-existing orders.
  describe('reviewed shop-graph.json (runtime artifact)', () => {
    for (const target of ORDER_MUTATIONS) {
      it(`createOrder -> ${target} is optional (required:false, verified:true) so prior-session/pre-existing orders are operable`, () => {
        const e = SHOP_GRAPH.edges.find(x => x.from === 'createOrder' && x.to === target)
        expect(e).toBeTruthy()
        expect(e!.kind).toBe('data')
        // required:false => the deterministic veto SKIPS this edge (ALLOW).
        // Note: plan_route traverses only required edges, so a
        // required:false edge is NOT used by plan_route either — the new-order
        // sequence is carried by the system prompt + the reactive 409 backstop,
        // not the graph. verified:true just marks human review sign-off.
        expect(e!.verified).toBe(true)
        expect(e!.required).toBe(false)
      })
    }
    for (const target of ORDER_MUTATIONS) {
      it(`listOrders -> ${target} exists (listOrders is an id source via array unroll) and is optional`, () => {
        const e = SHOP_GRAPH.edges.find(x => x.from === 'listOrders' && x.to === target)
        expect(e).toBeTruthy()
        expect(e!.kind).toBe('data')
        expect(e!.binding?.from_field).toBe('id')
        expect(e!.binding?.to_field).toBe('id')
        expect(e!.verified).toBe(true)
        expect(e!.required).toBe(false)
      })
    }
  })
})
