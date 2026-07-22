import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9222;
const CHROME_BIN = process.env.CHROME_BIN || "chromium";
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || "/tmp/chrome-profile";

export const STEALTH_ENABLED = /^(1|true)$/i.test(process.env.ACTIVATE_STEALTH_PLUGIN || "");

// --remote-allow-origins=* : sinon Chrome rejette toute connexion DevTools
// ("Rejected an incoming WebSocket connection..."). Voir le RFC dans le repo
// work (coderhammer/work, rfc/0001-remote-browser-control.md).
//
// Rendu logiciel : on garde UNIQUEMENT --enable-unsafe-swiftshader, PAS
// --use-gl=angle --use-angle=swiftshader (incident 2026-07-21 : gpu-process en
// busy-loop, 606% CPU sur le nœud, conteneur pourtant sans session active).
//
// Ce que faisaient les deux flags retirés : forcer TOUT le compositing (pas
// seulement le WebGL) sur le backend SwiftShader/Vulkan d'ANGLE — rendu 100%
// software y compris pour composer les frames du screencast. Coûteux et sans
// contrepartie : mesuré en conteneur, --use-angle=swiftshader ~double le CPU
// du gpu-process (warmup + coût par frame composée) sans rien rendre de plus.
//
// Ce que --enable-unsafe-swiftshader (conservé) apporte : il autorise le
// fallback SwiftShader d'ANGLE UNIQUEMENT là où il faut (contextes WebGL/3D,
// sinon "gris"/getContext('webgl') null sur les Chrome récents où le fallback
// auto est verrouillé), sans imposer SwiftShader au compositing 2D.
//
// Vérifié empiriquement (probe rouge vs bleu comparé par SHA-256, cf. PR) :
// avec ce seul flag, le DOM screencast (y compris de bout en bout via l'app)
// ET le WebGL rendent correctement. NB : le busy-loop permanent observé en
// prod n'a pas été reproduit tel quel dans le sandbox de dev (screencast
// headless throttlé sans vraie surface) — retirer le compositing software
// forcé est le remède documenté et ne peut, au pire, qu'être neutre côté CPU.
const CHROME_ARGS = [
  "--headless=new",
  "--no-sandbox",
  `--remote-debugging-port=${CDP_PORT}`,
  `--remote-debugging-address=${CDP_HOST}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${USER_DATA_DIR}`,
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
