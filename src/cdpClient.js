import puppeteer from "puppeteer-core";
import { CDP_BASE_URL } from "./chrome.js";

let browserPromise = null;
let sessionPromise = null;

async function getSession() {
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.connected) return sessionPromise;
  }
  browserPromise = puppeteer.connect({ browserURL: CDP_BASE_URL });
  const browser = await browserPromise;
  sessionPromise = browser.target().createCDPSession();
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
