import puppeteerCore from "puppeteer-core";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { CDP_BASE_URL, STEALTH_ENABLED } from "./chrome.js";

// La plupart des évasions du plugin stealth s'accrochent à `onPageCreated`
// (injection de script sur chaque nouveau document), ce qui fonctionne aussi
// bien en `.connect()` qu'en `.launch()`. Seules celles basées sur
// `beforeLaunch` (ex: navigator.webdriver) ne se déclenchent pas ici — voir
// le flag ajouté à la main dans chrome.js.
const puppeteer = STEALTH_ENABLED ? addExtra(puppeteerCore).use(StealthPlugin()) : puppeteerCore;

let browserPromise = null;
let sessionPromise = null;

// Dev uniquement : cibler le Chrome d'un conteneur browser-remote DISTANT
// (ex: le service déployé, http://browser-remote:3000) pour tester la couche
// agent sans rebuild d'image. Chrome annonce son ws interne (127.0.0.1:9222)
// dans /json/version — non joignable de l'extérieur — donc on reconstruit
// l'URL ws avec le host externe (qui, lui, est proxié avec le Host rewriting
// nécessaire). Absent en prod → on se connecte au Chrome local via browserURL.
const EXTERNAL_CDP_URL = process.env.CDP_EXTERNAL_URL || "";

async function connectArgs() {
  if (!EXTERNAL_CDP_URL) return { browserURL: CDP_BASE_URL };
  const res = await fetch(`${EXTERNAL_CDP_URL}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  const path = new URL(webSocketDebuggerUrl).pathname;
  return { browserWSEndpoint: `${EXTERNAL_CDP_URL.replace(/^http/, "ws")}${path}` };
}

// Connexion Puppeteer partagée vers le Chrome du conteneur. Réutilisée par la
// gestion des onglets (getSession, plus bas) ET par la couche agent
// (src/agent/*) — une seule connexion `.connect()` pour tout le process.
export async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.connected) return browser;
    // reconnexion : la session CDP en cache est morte avec l'ancien browser.
    sessionPromise = null;
  }
  browserPromise = puppeteer.connect(await connectArgs());
  return browserPromise;
}

async function getSession() {
  const browser = await getBrowser();
  if (!sessionPromise) sessionPromise = browser.target().createCDPSession();
  return sessionPromise;
}

// Chrome headless n'expose pas de notion de "page active/focus" via
// /json/list — Target.activateTarget est la seule façon fiable de désigner
// un onglet comme actif. On passe par une session CDP sur la cible
// navigateur elle-même : les commandes du domaine Target y sont valides pour
// n'importe quel targetId, pas seulement la cible de la session.
export async function activateTab(id) {
  const session = await getSession();
  await session.send("Target.activateTarget", { targetId: id });
}

export async function openTab(url) {
  const session = await getSession();
  const { targetId } = await session.send("Target.createTarget", { url });
  return targetId;
}

export async function closeTab(id) {
  const session = await getSession();
  await session.send("Target.closeTarget", { targetId: id });
}

// Garantit qu'au démarrage du serveur, un onglet about:blank est déjà ouvert
// (l'utilisateur n'a qu'à taper une adresse, pas besoin de cliquer sur +).
export async function ensureDefaultTab() {
  const res = await fetch(`${CDP_BASE_URL}/json/list`);
  const targets = await res.json();
  const pages = targets.filter(
    (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-untrusted://")
  );
  if (pages.length === 0) await openTab("about:blank");
}
