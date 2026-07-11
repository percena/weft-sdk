#!/usr/bin/env node
// weft-api-graph CLI: read an OpenAPI spec file, emit a graph Envelope
// (verified:false by default, or verified:true with --verified) for developer
// review + upload to weftd's `graphs` API.
// Usage: weft-api-graph <spec.json> <toolset> [out.json] [--verified|-v]
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { generateGraph } from './analyzer.js'

/**
 * Run the weft-api-graph CLI against `argv` (the args after the bin name).
 * Returns an exit code (0 ok, 1 usage error) so it's unit-testable without
 * process.exit side effects; the bin entrypoint below calls process.exit.
 *
 * Exported (not just top-level) so cli.test.ts can exercise --verified directly.
 */
export function runCli(argv: string[]): number {
  // Flags (--verified / -v) may appear anywhere after the bin name; positional
  // order is spec, toolset, [out].
  const verified = argv.some(a => a === '--verified' || a === '-v')
  const positional = argv.filter(a => !a.startsWith('-'))
  const [specPath, toolset, outPath] = positional

  if (!specPath || !toolset) {
    console.error('Usage: weft-api-graph <spec.json> <toolset> [out.json] [--verified|-v]')
    console.error('  Generates a data-flow DAG from an OpenAPI spec.')
    console.error('  --verified/-v: auto-sign the fail-open analyzer draft (sets graph.verified')
    console.error('    + every edge .verified = true). Use only after confirming all id-edges are')
    console.error('    referential (referenced pre-existing resources, required:false). The default')
    console.error('    (verified:false) is for PR review — then set verified:true + upload to')
    console.error('    weftd /v1/tenants/{tid}/apps/{aid}/graphs.')
    return 1
  }
  const specText = readFileSync(specPath, 'utf8')
  const graph = generateGraph(specText, toolset, new Date().toISOString())
  if (verified) {
    // Fail-open auto-sign-off: the analyzer v2 draft is already all edges
    // required:false (referential — operating a pre-existing resource must NOT
    // be hard-denied). Review confirms this; --verified records the sign-off.
    graph.verified = true
    for (const e of graph.edges) e.verified = true
  }
  const json = JSON.stringify(graph, null, 2)
  if (outPath) {
    writeFileSync(outPath, json)
    console.error(`wrote ${outPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges, verified:${graph.verified} — ${graph.verified ? 'review-signed' : 'review then set verified:true'})`)
  } else {
    console.log(json)
  }
  return 0
}

// Auto-run only when invoked as the bin (node dist/cli.js, or the copy at
// @percena/weft/dist/api-graph-cli.js). When imported (e.g. by cli.test.ts),
// import.meta.url differs from process.argv[1] → runCli is not auto-called.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runCli(process.argv.slice(2)))
}
