// Generates apps/itsm/agentic/itsm-agentic-graph.json from openapi.json via the
// @percena/weft/api-graph analyzer (the analyzer is folded into the published
// @percena/weft package — no separate graph-tool dep), with verified:true
// (the developer-review step — committing this file IS the review sign-off).
// Re-run after changing the itsm spec. Usage: npx tsx apps/itsm/agentic/scripts/gen-itsm-graph.ts
//   (equivalently: npx weft-api-graph openapi.json itsm itsm-agentic-graph.json --verified)
import { generateGraph } from '@percena/weft/api-graph'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const specPath = fileURLToPath(new URL('../openapi.json', import.meta.url))
const outPath = fileURLToPath(new URL('../itsm-agentic-graph.json', import.meta.url))
const spec = readFileSync(specPath, 'utf8')
const g = generateGraph(spec, 'itsm', new Date().toISOString())
// Developer review sign-off. The ITSM graph edges are all referential:
// CI↔CI (depends_on/runs_on), incident→CI / incident→change (link), change→CI /
// change→incident (rollback auto-INC), SLA→incident. Operating on a pre-existing
// or prior-session INC/CHG/CI by id (e.g. "resolve INC-1") must NOT be
// hard-denied, so all edges stay required:false (fail-open); verified:true
// is the human sign-off. (Setting any edge required:true here would make the
// veto hard-deny calls whose id wasn't produced by that edge in the current run.)
g.edges.forEach((e) => { e.verified = true })
g.verified = true
writeFileSync(outPath, `${JSON.stringify(g, null, 2)}\n`)
console.error(
  `wrote itsm-agentic-graph.json: ${g.nodes.length} nodes, ${g.edges.length} edges, ` +
  `verified:true, spec_hash=${g.generated_by.spec_hash}`,
)
