// Turso HTTP /v2/pipeline client — Workers-safe (no @libsql/client / WebSocket deps)

function argValue(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { type: "integer", value: String(v) };
    return { type: "float", value: String(v) };
  }
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  return { type: "text", value: String(v) };
}

function createHttpClient(url, token) {
  const httpUrl = `${url.replace(/^libsql:\/\//, "https://")}/v2/pipeline`;

  async function pipeline(requests) {
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Turso HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const j = await res.json();
    return j.results || [];
  }

  return {
    async execute(stmt) {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : (stmt.args || []);
      const results = await pipeline([
        { type: "execute", stmt: { sql, args: args.map(argValue) } },
        { type: "close" },
      ]);
      const r = results[0];
      if (!r || r.type !== "ok") throw new Error(`Turso error: ${JSON.stringify(r)}`);
      const result = r.response?.result;
      const cols = result?.cols?.map(c => c.name) || [];
      const rawRows = result?.rows || [];
      const rows = rawRows.map(row => {
        if (cols.length) {
          const obj = {};
          row.forEach((cell, i) => {
            let v = cell.value;
            if (cell.type === "integer") v = Number(cell.value);
            else if (cell.type === "float") v = Number(cell.value);
            obj[cols[i]] = v;
          });
          return obj;
        }
        return row.map(cell => {
          if (cell.type === "integer") return Number(cell.value);
          if (cell.type === "float") return Number(cell.value);
          return cell.value;
        });
      });
      return { rows, rowsAffected: result?.affected_row_count };
    },
    async batch(stmts) {
      const requests = [];
      for (const s of stmts) {
        requests.push({
          type: "execute",
          stmt: { sql: s.sql, args: (s.args || []).map(argValue) },
        });
      }
      requests.push({ type: "close" });
      const results = await pipeline(requests);
      for (const r of results) {
        if (r.type === "error") throw new Error(`Turso batch error: ${JSON.stringify(r)}`);
      }
    },
  };
}

module.exports = { createHttpClient };
