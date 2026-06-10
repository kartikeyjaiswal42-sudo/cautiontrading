// CautionTrading — simple JSON file persistence (alerts, settings, fired log)
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "store.json");

const DEFAULTS = {
  alerts: [],
  settings: {
    telegramToken: "",
    telegramChatId: "",
    soundEnabled: true,
  },
  fired: [], // newest first, capped
};

let state = null;
let saveTimer = null;

function load() {
  if (state) return state;
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    state = { ...DEFAULTS, ...JSON.parse(raw) };
    state.settings = { ...DEFAULTS.settings, ...state.settings };
  } catch {
    state = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return state;
}

function save() {
  // debounce writes to disk
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error("store save failed:", e.message);
    }
  }, 300);
}

function addFired(rec) {
  const s = load();
  s.fired.unshift(rec);
  if (s.fired.length > 300) s.fired.length = 300;
  save();
}

module.exports = { load, save, addFired };
