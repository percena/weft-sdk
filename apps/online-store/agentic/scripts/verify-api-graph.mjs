// Verifies the @percena/weft/api-graph analyzer: regenerating the graph from
// the committed spec MUST yield the same spec_hash + node/edge counts as the
// committed online-store-agentic-graph.json (analyzer logic is unchanged; only
// build shape is). Run: node apps/online-store/agentic/scripts/verify-api-graph.mjs
import { generateGraph } from '@percena/weft/api-graph'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const spec = readFileSync(`${here}../openapi.json`, 'utf8')
const committed = JSON.parse(readFileSync(`${here}../online-store-agentic-graph.json`, 'utf8'))
const regen = generateGraph(spec, 'shop', 'verify')
const ok =
  regen.generated_by.spec_hash === committed.generated_by.spec_hash &&
  regen.nodes.length === committed.nodes.length &&
  regen.edges.length === committed.edges.length
if (!ok) {
  console.error('FAIL', { regen_hash: regen.generated_by.spec_hash, committed_hash: committed.generated_by.spec_hash, regen_nodes: regen.nodes.length, committed_nodes: committed.nodes.length, regen_edges: regen.edges.length, committed_edges: committed.edges.length })
  process.exit(1)
}
console.log(`OK spec_hash=${regen.generated_by.spec_hash} nodes=${regen.nodes.length} edges=${regen.edges.length}`)
