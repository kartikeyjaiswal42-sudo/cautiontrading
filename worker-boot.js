// Cloudflare Worker — Hono API + static assets + AlertEngine Durable Object
let api = null;
let engineTickFn = null;

async function boot(env) {
  if (api) return api;

  process.env.TURSO_DB_URL = env.TURSO_DB_URL;
  process.env.TURSO_DB_TOKEN = env.TURSO_DB_TOKEN;
  process.env.TURSO_HTTP = "1";
  process.env.DELTA_BASE = env.DELTA_BASE || "https://api.india.delta.exchange";

  const storeMod = await import("./store.js");
  const store = storeMod.default || storeMod;
  await store.init({ url: env.TURSO_DB_URL, token: env.TURSO_DB_TOKEN, useHttp: true });

  const honoMod = await import("./hono-api.js");
  const createHonoApi = honoMod.default || honoMod;
  const srv = typeof createHonoApi === "function" ? createHonoApi() : createHonoApi;
  api = srv.app;
  engineTickFn = srv.engineTick;
  return api;
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
      const storeMod = await import("./store.js");
      const store = storeMod.default || storeMod;
      if (!store.load().alerts) {
        await store.init({
          url: this.env.TURSO_DB_URL,
          token: this.env.TURSO_DB_TOKEN,
          useHttp: true,
        });
      }
      if (!engineTickFn) {
        const honoMod = await import("./hono-api.js");
        const createHonoApi = honoMod.default || honoMod;
        const srv = typeof createHonoApi === "function" ? createHonoApi() : createHonoApi;
        engineTickFn = srv.engineTick;
      }
      await engineTickFn();
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
    const app = await boot(env);
    return app.fetch(request, env, ctx);
  },
};
