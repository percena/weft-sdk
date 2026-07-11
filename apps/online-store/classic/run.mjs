// Entrypoint: build the web bundle, then serve. No weftd warmup (traditional store).
import { build } from 'vite'
import { createShopServer } from './server/shop-server.mjs'

await build({ root: process.cwd(), build: { outDir: 'dist' }, logLevel: 'info' })
const port = Number(process.env.SHOP_PORT || 19743)
const server = createShopServer()
server.listen(port, '127.0.0.1', () => console.log(`online-store-classic on http://127.0.0.1:${port}`))
