// Cloudflare Worker API — Hono (no Express / body-parser on Workers)
const { Hono } = require("hono");
const createApiCore = require("./core-api");
const mountHonoRoutes = require("./hono-routes");

function createHonoApi() {
  const c = createApiCore();
  const app = new Hono();
  mountHonoRoutes(app, c);
  return { app, ...c };
}

module.exports = createHonoApi;
module.exports.default = createHonoApi;
