import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9222;
const CHROME_BIN = process.env.CHROME_BIN || "chromium";
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || "/tmp/chrome-profile";

export const STEALTH_ENABLED = /^(1|true)$/i.test(process.env.ACTIVATE_STEALTH_PLUGIN || "");

// Rendu logiciel forcé (sinon Page.startScreencast reste gris) et
// --remote-allow-origins=* (sinon Chrome rejette toute connexion DevTools,
// erreur "Rejected an incoming WebSocket connection..."). Voir le RFC dans le
// repo work (coderhammer/work, rfc/0001-remote-browser-control.md) pour le
// détail de ces deux pièges.
const CHROME_ARGS = [
  "--headless=new",
  "--no-sandbox",
  `--remote-debugging-port=${CDP_PORT}`,
  `--remote-debugging-address=${CDP_HOST}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${USER_DATA_DIR}`,
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--window-size=1512,982",
  // puppeteer-extra-plugin-stealth pose ce flag lui-même via son hook
  // `beforeLaunch`, qui ne se déclenche jamais ici puisque Chrome est démarré
  // par `spawnChrome()` et non par puppeteer (on se contente de `.connect()`
  // dans cdpClient.js) — on le reproduit donc à la main.
  ...(STEALTH_ENABLED ? ["--disable-blink-features=AutomationControlled"] : []),
];

export const CDP_BASE_URL = `http://${CDP_HOST}:${CDP_PORT}`;

export function spawnChrome() {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const proc = spawn(CHROME_BIN, CHROME_ARGS, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => process.stdout.write(`[chrome] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[chrome] ${d}`));
  proc.on("exit", (code) => {
    console.error(`chrome exited with code ${code}`);
    process.exit(1);
  });
  return proc;
}

export async function waitForChrome(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP_BASE_URL}/json/version`);
      if (res.ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP pas prêt après ${timeoutMs}ms`);
}
