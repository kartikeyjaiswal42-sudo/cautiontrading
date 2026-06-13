// CautionTrading — local dev entry (Express + static + Turso/libSQL or file store)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const createServer = require("./server-api");
const store = require("./store");

const { app, engineTick, CHECK_INTERVAL_MS, ssePush, runtimeState, rtState } = createServer();
const PORT = process.env.PORT || 8899;

if (require.main === module) {
  store.init().then(() => {
    app.listen(PORT, () => {
      console.log(`CautionTrading running → http://localhost:${PORT}`);
      engineTick();
      setInterval(engineTick, CHECK_INTERVAL_MS);
    });
  }).catch(err => {
    console.error("Failed to initialize database store:", err);
    process.exit(1);
  });
}

module.exports = { app, engineTick, CHECK_INTERVAL_MS, ssePush, runtimeState, rtState };
module.exports.default = module.exports;
