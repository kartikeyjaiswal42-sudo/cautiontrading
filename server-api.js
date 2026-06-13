// CautionTrading — shared Express app factory (local dev)
const express = require("express");
const path = require("path");
const createApiCore = require("./core-api");
const mountExpressRoutes = require("./express-routes");

function createServer() {
  const c = createApiCore();
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));
  mountExpressRoutes(app, c);
  return { app, ...c };
}

module.exports = createServer;
