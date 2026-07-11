// Entrypoint: build the web bundle, then serve. Agentic upgrade target (the
// weftd provisioning + chat panel + session routes are wired onto the app's
// shop-server.mjs by the integrate-weft-kit scaffold).
//
// online-store-agentic runs createShopServer in-process (no child spawn), so .env is
// loaded straight into process.env before the build; creds are validated up
// front (fail fast) so a misconfigured .env doesn't waste a web build.
import { build } from 'vite'
import { loadEnv } from './lib/proc.mjs'
import { createShopServer } from './server/shop-server.mjs'

// Populate process.env from .env BEFORE the build so provisioning reads live
// creds (WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID / OPENAI_MODEL).
Object.assign(process.env, loadEnv())

/**
 * Fail fast on missing weftd creds — mirrors apps/online-store/run.mjs:16-30.
 * Exported so the scaffolded shop-server.mjs's isMain block can reuse it
 * (closes the v1 deferred Minor where direct-run `node server/shop-server.mjs`
 * skipped the credential check). Exits(1) if WEFTD_BASE / WEFT_API_KEY /
 * WEFT_TENANT_ID are missing.
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
const port = Number(process.env.SHOP_PORT || 19745)
const { server, ensureApp } = createShopServer({ port })
server.listen(port, '127.0.0.1', () => {
  console.log(`online-store-agentic on http://127.0.0.1:${port}`)
  // Warm up weftd provisioning in the background so the first chat request
  // isn't blocked by the provisioning chain.
  ensureApp()
    .then(() => console.log('[online-store-agentic] background provisioning complete'))
    .catch(err => console.error('[online-store-agentic] background provisioning failed: ' + err.message))
})
