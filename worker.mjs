// Cloudflare Worker — Express app + Durable Object alert engine (Amity account)
import { httpServerHandler } from "cloudflare:node";
import { createRequire } from "node:module";

/* global __WORKER_ENTRY__ */
const require = createRequire(typeof __WORKER_ENTRY__ === "string" ? __WORKER_ENTRY__ : "file:///worker.mjs");
const WORKER_PORT = 8899;

let httpHandler = null;
let booted = false;

async function boot(env) {
  if (booted) return httpHandler;
  process.env.TURSO_DB_URL = env.TURSO_DB_URL;
  process.env.TURSO_DB_TOKEN = env.TURSO_DB_TOKEN;
  process.env.TURSO_HTTP = "1";
  process.env.DELTA_BASE = env.DELTA_BASE || "https://api.india.delta.exchange";

  const store = require("./store");
  await store.init({ url: env.TURSO_DB_URL, token: env.TURSO_DB_TOKEN, useHttp: true });

  const { app } = require("./server");
  app.listen(WORKER_PORT);
  httpHandler = httpServerHandler({ port: WORKER_PORT });
  booted = true;
  return httpHandler;
}

function wakeEngine(env) {
  const id = env.ALERT_ENGINE.idFromName("main");
  return env.ALERT_ENGINE.get(id).fetch("https://engine/ping");
}

export class AlertEngine {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ping" || url.pathname === "/start") {
      await this.state.storage.setAlarm(Date.now() + 1000);
      return new Response("ok");
    }
    return new Response("AlertEngine", { status: 404 });
  }

  async alarm() {
    try {
      process.env.TURSO_DB_URL = this.env.TURSO_DB_URL;
      process.env.TURSO_DB_TOKEN = this.env.TURSO_DB_TOKEN;
      process.env.TURSO_HTTP = "1";
      const store = require("./store");
      if (!store.load().alerts) {
        await store.init({ url: this.env.TURSO_DB_URL, token: this.env.TURSO_DB_TOKEN, useHttp: true });
      }
      const { engineTick } = require("./server");
      await engineTick();
    } catch (e) {
      console.error("AlertEngine alarm error:", e.message);
    }
    await this.state.storage.setAlarm(Date.now() + 1000);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api")) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
    }
    ctx.waitUntil(wakeEngine(env));
    const handler = await boot(env);
    return handler.fetch(request, env, ctx);
  },
};
