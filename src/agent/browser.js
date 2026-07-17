// Résolution de la « page courante » sur laquelle agit la couche agent.
//
// Choix de conception : l'agent agit sur un onglet RÉEL du même Chrome (pas une
// page cachée), pour co-piloter avec l'humain qui regarde le screencast — il
// voit ce que l'agent fait, et inversement. Par défaut = le premier onglet
// « page » non-devtools ; l'agent peut cibler un autre onglet par son id.

import { getBrowser } from "../cdpClient.js";

// deviceScaleFactor 1 : on veut que les coordonnées CSS renvoyées par les
// snapshots correspondent 1:1 aux pixels du screenshot (le driver externe
// historique était en ×2, source de conversions pénibles côté agent).
const VIEWPORT = {
  width: Number(process.env.AGENT_VIEWPORT_WIDTH) || 1512,
  height: Number(process.env.AGENT_VIEWPORT_HEIGHT) || 982,
  deviceScaleFactor: 1,
};

let current = null; // dernière page servie, réutilisée tant qu'elle vit

function isControllablePage(page) {
  const url = page.url();
  return !url.startsWith("devtools://") && !url.startsWith("chrome-untrusted://");
}

async function applyViewport(page) {
  try {
    const vp = page.viewport();
    if (!vp || vp.width !== VIEWPORT.width || vp.height !== VIEWPORT.height) {
      await page.setViewport(VIEWPORT);
    }
  } catch {
    // page fermée entre-temps : l'appelant re-résoudra
  }
}

// browser.pages() attache une session CDP à chaque onglet existant. En direct
// (Chrome local dans le conteneur, cas prod) c'est immédiat ; à travers le
// proxy ws d'un conteneur distant (dev harness), l'attache aux onglets déjà
// ouverts peut bloquer. On borne donc l'appel : s'il n'aboutit pas, on tombe
// sur newPage() (créer un onglet marche dans les deux cas — cf driver
// historique). Résultat : co-pilotage de l'onglet existant quand c'est
// possible, onglet dédié à l'agent sinon.
async function listPages(browser, timeoutMs = 4000) {
  try {
    return await Promise.race([
      browser.pages(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("pages() timeout")), timeoutMs)),
    ]);
  } catch {
    return null; // signal : passer par newPage()
  }
}

// Renvoie la page courante. `tabId` optionnel = cible un onglet précis (le
// `targetId` CDP, tel qu'exposé par GET /api/tabs). Sans ça : réutilise la
// dernière page servie si elle vit encore, sinon le premier onglet contrôlable
// (ou un nouvel onglet en dernier recours).
export async function getPage(tabId) {
  const browser = await getBrowser();

  if (current && !current.isClosed() && isControllablePage(current) && !tabId) {
    await applyViewport(current);
    return current;
  }

  const pages = await listPages(browser);

  if (tabId && pages) {
    for (const p of pages) {
      if (p.target()?._targetId === tabId || p.url() === tabId) {
        current = p;
        await applyViewport(p);
        return p;
      }
    }
  }

  const usable = (pages || []).filter((p) => !p.isClosed() && isControllablePage(p));
  current = usable[0] || (await browser.newPage());
  await applyViewport(current);
  return current;
}

export { VIEWPORT };
