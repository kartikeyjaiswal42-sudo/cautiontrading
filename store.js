// CautionTrading — Turso database persistence with in-memory write-through cache

// Load .env (local dev only — skipped on Workers where dotenv is absent)
if (typeof process !== "undefined" && process.env.TURSO_HTTP !== "1") {
  try { require("dotenv").config({ path: require("path").join(__dirname, ".env") }); } catch { /* no dotenv */ }
}

const DEFAULTS = {
  alerts: [],
  settings: {
    telegramToken: "",
    telegramChatId: "",
    soundEnabled: true,
  },
  fired: [], // newest first, capped to 300
};

let state = null;
let client = null;
let saveTimer = null;

async function init(opts = {}) {
  if (state) return state;

  const url = opts.url || process.env.TURSO_DB_URL;
  const token = opts.token || process.env.TURSO_DB_TOKEN;
  const useHttp = opts.useHttp || process.env.TURSO_HTTP === "1";

  if (!url) {
    throw new Error("TURSO_DB_URL is not set in environment variables / .env");
  }

  if (useHttp) {
    const { createHttpClient } = require("./turso-http");
    client = createHttpClient(url, token);
  } else {
    const { createClient } = require("@libsql/client");
    client = createClient({ url, authToken: token });
  }

  // Create settings table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Create alerts table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      createdAt INTEGER,
      symbol TEXT,
      resolution TEXT,
      left TEXT,
      op TEXT,
      right TEXT,
      "trigger" TEXT,
      message TEXT,
      expiresAt INTEGER,
      channels TEXT,
      enabled INTEGER,
      status TEXT
    )
  `);

  // Create fired table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS fired (
      id TEXT PRIMARY KEY,
      alertId TEXT,
      time INTEGER,
      symbol TEXT,
      resolution TEXT,
      message TEXT,
      condition TEXT,
      leftValue REAL,
      rightValue REAL,
      price REAL
    )
  `);

  // Migrate/Seed from local store.json if Turso alerts table is empty
  let needsMigration = false;
  try {
    const alertCountRes = await client.execute("SELECT COUNT(*) as count FROM alerts");
    const alertCount = alertCountRes.rows[0]?.count ?? 0;
    if (alertCount === 0) {
      needsMigration = true;
    }
  } catch (e) {
    needsMigration = true;
  }

  if (needsMigration && !useHttp) {
    try {
      const fs = require("fs");
      const path = require("path");
      const file = path.join(__dirname, "data", "store.json");
      if (fs.existsSync(file)) {
        console.log("Empty Turso DB detected. Migrating local store.json data...");
        const raw = fs.readFileSync(file, "utf8");
        const localData = JSON.parse(raw);

      // Save settings
      if (localData.settings) {
        await client.execute({
          sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('telegramToken', ?), ('telegramChatId', ?), ('soundEnabled', ?)",
          args: [
            localData.settings.telegramToken || "",
            localData.settings.telegramChatId || "",
            String(localData.settings.soundEnabled ?? true)
          ]
        });
      }

      // Save alerts
      if (localData.alerts && localData.alerts.length > 0) {
        const tx = localData.alerts.map(alert => ({
          sql: `INSERT OR REPLACE INTO alerts (id, createdAt, symbol, resolution, left, op, right, "trigger", message, expiresAt, channels, enabled, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            alert.id,
            alert.createdAt,
            alert.symbol,
            alert.resolution,
            JSON.stringify(alert.left),
            alert.op,
            JSON.stringify(alert.right),
            alert.trigger,
            alert.message || "",
            alert.expiresAt,
            JSON.stringify(alert.channels),
            alert.enabled ? 1 : 0,
            alert.status
          ]
        }));
        await client.batch(tx, "write");
      }

      // Save fired
      if (localData.fired && localData.fired.length > 0) {
        const tx = localData.fired.map(rec => ({
          sql: `INSERT OR REPLACE INTO fired (id, alertId, time, symbol, resolution, message, condition, leftValue, rightValue, price)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            rec.id,
            rec.alertId,
            rec.time,
            rec.symbol,
            rec.resolution,
            rec.message,
            rec.condition,
            rec.leftValue,
            rec.rightValue,
            rec.price
          ]
        }));
        await client.batch(tx, "write");
      }
      console.log("Migration from local store.json to Turso DB complete!");
      }
    } catch (err) {
      console.error("Failed to migrate local store.json:", err.message);
    }
  }

  // Load database content into memory state
  state = JSON.parse(JSON.stringify(DEFAULTS));

  // Load settings
  const settingsRows = await client.execute("SELECT key, value FROM settings");
  for (const row of settingsRows.rows) {
    if (row.key === "soundEnabled") {
      state.settings.soundEnabled = row.value === "true";
    } else {
      state.settings[row.key] = row.value;
    }
  }

  // Load alerts
  const alertsRows = await client.execute("SELECT * FROM alerts");
  for (const row of alertsRows.rows) {
    state.alerts.push({
      id: row.id,
      createdAt: Number(row.createdAt),
      symbol: row.symbol,
      resolution: row.resolution,
      left: JSON.parse(row.left),
      op: row.op,
      right: JSON.parse(row.right),
      trigger: row.trigger,
      message: row.message,
      expiresAt: row.expiresAt ? Number(row.expiresAt) : null,
      channels: JSON.parse(row.channels),
      enabled: row.enabled === 1,
      status: row.status,
    });
  }

  // Load fired (newest first, capped)
  const firedRows = await client.execute("SELECT * FROM fired ORDER BY time DESC LIMIT 300");
  for (const row of firedRows.rows) {
    state.fired.push({
      id: row.id,
      alertId: row.alertId,
      time: Number(row.time),
      symbol: row.symbol,
      resolution: row.resolution,
      message: row.message,
      condition: row.condition,
      leftValue: row.leftValue,
      rightValue: row.rightValue,
      price: row.price,
    });
  }

  return state;
}

function load() {
  if (!state) {
    // Return empty defaults in case init hasn't completed yet
    return DEFAULTS;
  }
  return state;
}

async function flushSave() {
  if (!client || !state) return;
  const tx = [];

  tx.push({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('telegramToken', ?), ('telegramChatId', ?), ('soundEnabled', ?)",
    args: [
      state.settings.telegramToken || "",
      state.settings.telegramChatId || "",
      String(state.settings.soundEnabled ?? true),
    ],
  });

  const ids = state.alerts.map(a => a.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    tx.push({
      sql: `DELETE FROM alerts WHERE id NOT IN (${placeholders})`,
      args: ids,
    });
  } else {
    tx.push({ sql: "DELETE FROM alerts", args: [] });
  }

  for (const alert of state.alerts) {
    tx.push({
      sql: `INSERT OR REPLACE INTO alerts (id, createdAt, symbol, resolution, left, op, right, "trigger", message, expiresAt, channels, enabled, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        alert.id,
        alert.createdAt,
        alert.symbol,
        alert.resolution,
        JSON.stringify(alert.left),
        alert.op,
        JSON.stringify(alert.right),
        alert.trigger,
        alert.message || "",
        alert.expiresAt,
        JSON.stringify(alert.channels),
        alert.enabled ? 1 : 0,
        alert.status,
      ],
    });
  }

  await client.batch(tx, "write");
}

function save() {
  if (!client || !state) return Promise.resolve();
  // Workers: debounced setTimeout often never runs after the response is sent
  if (process.env.TURSO_HTTP === "1") {
    return flushSave().catch(e => console.error("store save to Turso failed:", e.message));
  }
  if (saveTimer) return Promise.resolve();
  return new Promise(resolve => {
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await flushSave();
      } catch (e) {
        console.error("store save to Turso failed:", e.message);
      }
      resolve();
    }, 300);
  });
}

async function addFired(rec) {
  if (!state) return;
  
  state.fired.unshift(rec);
  if (state.fired.length > 300) state.fired.length = 300;

  if (!client) return;

  try {
    await client.execute({
      sql: `INSERT INTO fired (id, alertId, time, symbol, resolution, message, condition, leftValue, rightValue, price)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        rec.id,
        rec.alertId,
        rec.time,
        rec.symbol,
        rec.resolution,
        rec.message,
        rec.condition,
        rec.leftValue,
        rec.rightValue,
        rec.price
      ]
    });

    // Capping logic: delete old records that are not in the top 300
    await client.execute(`
      DELETE FROM fired WHERE id NOT IN (
        SELECT id FROM fired ORDER BY time DESC LIMIT 300
      )
    `);
  } catch (e) {
    console.error("store addFired DB insert failed:", e.message);
  }
}

module.exports = { init, load, save, addFired };
module.exports.default = module.exports;
