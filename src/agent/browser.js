// Résolution des onglets sur lesquels agit la couche agent.
//
// Deux modes, pour couvrir autonomie ET co-pilotage :
//   - onglet DÉDIÉ à l'agent : il ouvre son propre onglet (createTab → un `tab`
//     id) et cible ses actions dessus via {tab}. Découplé de ce que l'humain
//     regarde (il peut changer d'onglet dans l'UI sans rien casser). Plusieurs
//     onglets = travail parallèle (Chrome pilote chaque onglet indépendamment ;
//     lecture/clic/screenshot marchent sur un onglet en arrière-plan, vérifié).
//   - co-pilotage : {tab:"active"} agit sur l'onglet que l'humain voit (celui
//     dont le screencast est ouvert, cf screencast.js), ou aucun tab = premier
//     onglet contrôlable.
//
// Robustesse : pour un onglet que l'agent a créé lui-même (newPage), on garde
// le handle Page directement → pas besoin de browser.pages() (qui peut bloquer
// à travers le proxy ws d'un conteneur distant). browser.pages() n'est sollicité
// (et borné dans le temps) que pour retrouver un onglet qu'on ne détient pas
// (onglet ouvert par l'humain, ou "active").

import { getBrowser } from "../cdpClient.js";
import { getActiveViewedTab } from "../screencast.js";

const VIEWPORT = {
  width: Number(process.env.AGENT_VIEWPORT_WIDTH) || 1512,
  height: Number(process.env.AGENT_VIEWPORT_HEIGHT) || 982,
  deviceScaleFactor: 1,
};

// targetId -> Page, pour les onglets dont on tient un handle (créés par l'agent,
// ou déjà résolus). Purgé quand l'onglet se ferme.
const byId = new Map();
let defaultPage = null; // onglet servi quand aucun tab n'est précisé

function tabId(page) {
  try {
    return page.target()?._targetId || null;
  } catch {
    return null;
  }
}

function isControllable(page) {
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
    /* onglet fermé entre-temps */
  }
}

// Enregistre un handle Page (cache + viewport + purge à la fermeture).
async function register(page) {
  const id = tabId(page);
  if (id) {
    byId.set(id, page);
    page.once("close", () => byId.delete(id));
  }
  await applyViewport(page);
  return id;
}

// browser.pages() attache une session CDP à CHAQUE onglet : direct en prod
// (Chrome local), potentiellement bloquant à travers le proxy ws distant. On le
// borne donc dans le temps ; null = ne pas s'y fier (retomber sur les handles).
async function listPages(browser, timeoutMs = 4000) {
  try {
    return await Promise.race([
      browser.pages(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("pages() timeout")), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

// Ouvre un nouvel onglet dédié à l'agent. `url` optionnel = y navigue direct.
export async function createTab(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const tab = await register(page);
  if (url) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  }
  return { tab, url: page.url(), title: await page.title().catch(() => "") };
}

// Liste les onglets (id + url + titre). Best-effort : privilégie browser.pages(),
// retombe sur les handles connus si pages() n'aboutit pas (proxy).
export async function listTabs() {
  const browser = await getBrowser();
  const pages = await listPages(browser);
  const src = pages || [...byId.values()];
  const out = [];
  for (const p of src) {
    if (p.isClosed?.()) continue;
    out.push({ tab: tabId(p), url: p.url(), title: await p.title().catch(() => "") });
  }
  return out;
}

export async function closeTab(tab) {
  const held = byId.get(tab);
  if (held && !held.isClosed()) {
    await held.close();
    byId.delete(tab);
    return true;
  }
  const browser = await getBrowser();
  const pages = await listPages(browser);
  const found = (pages || []).find((p) => tabId(p) === tab && !p.isClosed());
  if (found) {
    await found.close();
    return true;
  }
  return false;
}

// Renvoie la page cible d'une action.
//   tab = "<targetId>"  → cet onglet précis
//   tab = "active"      → l'onglet que l'humain regarde (screencast)
//   tab absent          → onglet par défaut (réutilisé) : premier contrôlable,
//                         ou un nouvel onglet en dernier recours
export async function getPage(tab) {
  const browser = await getBrowser();

  // 1) onglet précis dont on tient déjà le handle (chemin rapide, sans pages())
  if (tab && tab !== "active" && byId.has(tab)) {
    const p = byId.get(tab);
    if (!p.isClosed()) {
      await applyViewport(p);
      return p;
    }
    byId.delete(tab);
  }

  // 2) résoudre l'id cible (dont "active" → onglet regardé par l'humain)
  const targetId = tab === "active" ? getActiveViewedTab() : tab;

  // 3) onglet précis non détenu (ouvert par l'humain / "active") : via pages()
  if (targetId) {
    const pages = await listPages(browser);
    const p = (pages || []).find((x) => tabId(x) === targetId && !x.isClosed());
    if (p) {
      await register(p);
      return p;
    }
    // ciblé mais introuvable : signaler plutôt que d'agir sur le mauvais onglet
    throw new Error(`onglet introuvable: ${targetId}`);
  }

  // 4) défaut : onglet mémorisé, sinon premier contrôlable, sinon nouvel onglet
  if (defaultPage && !defaultPage.isClosed() && isControllable(defaultPage)) {
    await applyViewport(defaultPage);
    return defaultPage;
  }
  const pages = await listPages(browser);
  const usable = (pages || []).filter((p) => !p.isClosed() && isControllable(p));
  defaultPage = usable[0] || (await browser.newPage());
  await register(defaultPage);
  return defaultPage;
}

export { VIEWPORT };
