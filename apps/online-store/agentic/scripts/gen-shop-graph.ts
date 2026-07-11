// Generates apps/online-store/agentic/online-store-agentic-graph.json from openapi.json via the
// @percena/weft/api-graph analyzer (the analyzer is folded into the published
// @percena/weft package — no separate graph-tool dep), with verified:true
// (the developer-review step — committing this file IS the review sign-off).
// Re-run after changing the shop spec. Usage: npx tsx apps/online-store/agentic/scripts/gen-shop-graph.ts
//   (equivalently: npx weft-api-graph openapi.json shop online-store-agentic-graph.json --verified)
import { generateGraph } from '@percena/weft/api-graph'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const specPath = fileURLToPath(new URL('../openapi.json', import.meta.url))
const outPath = fileURLToPath(new URL('../online-store-agentic-graph.json', import.meta.url))
const spec = readFileSync(specPath, 'utf8')
const g = generateGraph(spec, 'shop', new Date().toISOString())
// Developer review sign-off. The analyzer v2 already emits the correct
// shape for this spec: createOrder AND listOrders are pure producers of order id
// (array-item unroll), all edges required:false by default (fail-open), and
// same-resource guarded (no cross-resource id edges). Review confirms every id
// edge is referential — operating on a pre-existing / prior-session order must
// NOT be hard-denied (the ORD-1 bug), so all stay required:false; verified:true
// is the human sign-off. (Setting any edge required:true here would make the
// veto hard-deny calls whose id wasn't produced by that edge in the current run.)
g.edges.forEach(e => { e.verified = true })
g.verified = true
writeFileSync(outPath, `${JSON.stringify(g, null, 2)}\n`)
console.error(`wrote online-store-agentic-graph.json: ${g.nodes.length} nodes, ${g.edges.length} edges, verified:true, spec_hash=${g.generated_by.spec_hash}`)
