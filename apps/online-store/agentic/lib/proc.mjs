// Shared process orchestration for the online store demo: spawning the shop backend
// and HTTP health-check waiting. Used by run.mjs so the boot logic only
// lives in one place.
//
// This demo connects to a remote weftd — no local agent runtime or weftd
// binaries are needed. Credentials come from the demo's own .env file.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const shopDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Parses the demo-local `.env` file into a plain key-value map.
 * Returns {} when the file does not exist.
 */
export function loadEnv() {
  const envPath = join(shopDir, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const raw of readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function startProcess(name, command, args, { env = {}, stdio = "drain", onExit } = {}) {
  const child = spawn(command, args, {
    cwd: shopDir,
    stdio: stdio === "inherit" ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  if (stdio !== "inherit") {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  if (onExit) child.on("exit", (code) => onExit(name, code));
  return child;
}

export async function waitForHttp(url, { name = url, timeoutMs = 20000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`service not ready: ${name} (${url})`);
}

/**
 * Starts the demo service stack: shop backend only. The shop server connects
 * to a remote weftd (WEFTD_BASE from .env or process env). Returns
 * { children, waitReady, kill, waitExit }.
 */
export function startShopStack({ shopPort, stdio = "drain", onExit } = {}) {
  const env = loadEnv();
  const rawWeftdBase = env.WEFTD_BASE || process.env.WEFTD_BASE;
  if (!rawWeftdBase) {
    throw new Error("WEFTD_BASE is not set — point it at your weftd endpoint (see .env.example)");
  }
  const weftdBase = rawWeftdBase.replace(/\/$/, "");
  const apiKey = env.WEFT_API_KEY || process.env.WEFT_API_KEY || "online-store-key";
  const tenantId = env.WEFT_TENANT_ID || process.env.WEFT_TENANT_ID || "";

  const shopEnv = {
    SHOP_PORT: String(shopPort),
    WEFTD_BASE: weftdBase,
    WEFT_API_KEY: apiKey,
    WEFT_TENANT_ID: tenantId,
    OPENAI_MODEL: env.OPENAI_MODEL ?? "openai/shop-agent-v1",
  };

  const children = [];
  const shopChild = startProcess(
    "shop",
    process.execPath,
    [join(shopDir, "server", "shop-server.mjs")],
    { env: shopEnv, stdio, onExit },
  );
  children.push({ name: "shop", child: shopChild });

  return {
    children,
    async waitReady({ timeoutMs = 20000 } = {}) {
      await waitForHttp(`http://127.0.0.1:${shopPort}/api/products`, { name: "shop", timeoutMs });
      // Verify the remote weftd is reachable before declaring ready.
      await waitForHttp(`${weftdBase}/health`, { name: "remote weftd", timeoutMs });
    },
    kill() {
      for (const { child } of children) {
        if (!child.killed) child.kill("SIGTERM");
      }
    },
    waitExit(timeoutMs = 5000) {
      const exits = children.map(({ child }) =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise((r) => child.on("exit", r)),
      );
      return Promise.race([
        Promise.all(exits),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    },
  };
}
