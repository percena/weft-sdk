// Entrypoint template: build the web bundle, then serve.
// Wire your HTTP server factory in place of createAppServer below
// (provisioning + chat session routes attach to that server).
//
// .env is loaded into process.env before the build; creds are validated up
// front (fail fast) so a misconfigured .env doesn't waste a web build.
import { build } from 'vite'
import { loadEnv } from './lib/proc.mjs'
import { createAppServer } from './server/app-server.mjs'
import { Agent, setGlobalDispatcher } from 'undici'

// Populate process.env from .env BEFORE the build so provisioning reads live
// creds (WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID / OPENAI_MODEL).
Object.assign(process.env, loadEnv())

// Stale keep-alive avoidance: the reverse proxy in front of weftd silently
// closes idle keep-alive connections, and undici's default pool (4s idle
// timeout) sometimes reuses a half-closed socket → the fetch stalls until its
// own TTFB timeout. A long-running server process is hit hardest (it pools
// connections across requests; a short-lived script is unaffected). Drop idle
// connections aggressively so reuse always hits a fresh socket. Combined with
// the per-fetch TTFB timeout + retry in provision.mjs / session-routes.mjs,
// this makes provisioning + the run/timeline proxy resilient to the stall.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 500, keepAliveMaxTimeout: 500, headersTimeout: 20000 }))

/**
 * Fail fast on missing weftd creds. Exported so a direct-run server entrypoint
 * can reuse it. Exits(1) if WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID are missing.
 */
export function assertWeftdCreds() {
  if (!process.env.WEFTD_BASE) {
    console.error('[run] WEFTD_BASE is required in .env')
    console.error('  e.g. WEFTD_BASE=https://your-weftd-endpoint.example.com')
    process.exit(1)
  }
  if (!process.env.WEFT_API_KEY) {
    console.error('[run] WEFT_API_KEY is required in .env')
    console.error('  (a tenant API key created from the Weft console (https://weft-kit.dev))')
    process.exit(1)
  }
  if (!process.env.WEFT_TENANT_ID) {
    console.error('[run] WEFT_TENANT_ID is required in .env')
    console.error('  (the tenant ID that owns the API key, from the console)')
    process.exit(1)
  }
}

// Fail fast BEFORE the vite build so a missing .env doesn't waste a web build.
assertWeftdCreds()

await build({ root: process.cwd(), build: { outDir: 'dist' }, logLevel: 'info' })
const port = Number(process.env.APP_PORT || {{port}})
const { server, ensureApp } = createAppServer({ port })
server.listen(port, '127.0.0.1', () => {
  console.log(`{{appSlug}} on http://127.0.0.1:${port}`)
  // Warm up weftd provisioning in the background so the first chat request
  // isn't blocked by the provisioning chain.
  ensureApp()
    .then(() => console.log('[{{appSlug}}] background provisioning complete'))
    .catch(err => console.error('[{{appSlug}}] background provisioning failed: ' + err.message))
})
