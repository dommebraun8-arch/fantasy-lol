/**
 * Startet eine frische lokale Umgebung und laesst alle Testsuiten darin laufen.
 *
 *   npm test
 *
 * Reihenfolge ist nicht beliebig: api.test.mjs legt die Statistikdaten an, mit
 * denen ui.test.mjs arbeitet. collector_test.py ersetzt sie danach durch seine
 * eigenen - deshalb laeuft er zuletzt.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.TEST_PORT || "8787";
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "testtoken123";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", TEST_BASE: BASE, TEST_INGEST_TOKEN: TOKEN };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", ...opts });
  return r.status === 0;
}

console.log("→ Datenbank zuruecksetzen");
const stateDir = join(root, ".wrangler", "state");
if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
if (!run("npx", ["wrangler", "d1", "execute", "fantasy-lol", "--local",
  "--file=migrations/0001_init.sql"], { stdio: "ignore" })) {
  console.error("Migration fehlgeschlagen");
  process.exit(1);
}

console.log("→ Worker starten");
// Eigene Prozessgruppe (detached): wrangler startet workerd als Enkelkind.
// Ohne die Gruppe zu beenden bleibt workerd zurueck, haelt den Port besetzt
// und laesst den naechsten Testlauf ins Leere laufen.
const dev = spawn("npx", ["wrangler", "dev", "--port", PORT, "--local", "--var", `INGEST_TOKEN:${TOKEN}`],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let devLog = "";
dev.stdout.on("data", d => { devLog += d; });
dev.stderr.on("data", d => { devLog += d; });

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  if (process.platform === "win32") {
    // Windows kennt keine Prozessgruppen mit negativer PID - dort raeumt
    // taskkill /T den ganzen Baum ab.
    try { spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) {}
    return;
  }
  try { process.kill(-dev.pid, "SIGTERM"); } catch (e) { /* schon weg */ }
  setTimeout(() => { try { process.kill(-dev.pid, "SIGKILL"); } catch (e) {} }, 2000).unref();
};
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

// Grosszuegig: nach einem geleerten .wrangler-Verzeichnis muss workerd erst
// wieder ausgepackt werden, das dauert auf langsamen Rechnern gut eine halbe
// Minute. Zu knapp bemessen macht die Tests nur scheinbar flaky.
async function waitForServer(seconds = 120) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const res = await fetch(BASE + "/api/me");
      if (res.ok) return true;
    } catch (e) { /* noch nicht da */ }
    if (i > 0 && i % 20 === 0) process.stdout.write(`   … ${i / 2}s\n`);
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error("Worker ist nicht hochgekommen:\n" + devLog.slice(-2000));
  process.exit(1);
}

const suites = [
  ["API", "node", ["test/api.test.mjs"]],
  ["Oberflaeche", "node", ["test/ui.test.mjs"]],
  ["Sammler", "python3", ["test/collector_test.py"]],
];

let failed = [];
for (const [name, cmd, args] of suites) {
  console.log(`\n──────────── ${name} ────────────`);
  if (!run(cmd, args)) failed.push(name);
}

// Fehler aus dem Worker selbst wuerden sonst untergehen.
const workerErrors = (devLog.match(/API-Fehler[^\n]*/g) || []);
if (workerErrors.length) {
  console.log("\nFehler im Worker-Log:");
  workerErrors.slice(0, 5).forEach(l => console.log("  " + l));
  failed.push("Worker-Log");
}

stop();
console.log(failed.length ? `\nFEHLGESCHLAGEN: ${failed.join(", ")}` : "\nALLES GRUEN");
process.exit(failed.length ? 1 : 0);
