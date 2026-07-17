// Couche HTTP « agent » : verbes haut-niveau sous /api/agent/*, pensés pour
// être appelés par une IA (ou le serveur MCP, src/agent/mcp.js, qui tape ces
// mêmes fonctions). Voir src/agent/pageActions.js pour la logique.

import { getPage, createTab, listTabs, closeTab } from "./browser.js";
import * as actions from "./pageActions.js";

// /eval exécute du JS arbitraire avec accès complet à la page Puppeteer —
// puissant mais dangereux sur un service exposé. Désactivé par défaut ;
// activer explicitement via AGENT_ENABLE_EVAL=1 pour du debug.
const EVAL_ENABLED = /^(1|true)$/i.test(process.env.AGENT_ENABLE_EVAL || "");

// Renvoie true : sert de valeur de retour « route gérée » à handleAgentRoute
// (tous les cas font `return sendJson(...)`).
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("corps JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

// Renvoie true si la route a été prise en charge (gérée ici), false sinon.
export async function handleAgentRoute(req, res, pathname) {
  if (!pathname.startsWith("/api/agent")) return false;

  const route = pathname.slice("/api/agent".length) || "/";
  const body = req.method === "POST" ? await readBody(req) : {};

  // --- Gestion d'onglets (ne nécessite pas de page pré-résolue) -------------
  // POST /tabs {url?}       -> crée un onglet dédié à l'agent, renvoie son id
  // GET  /tabs              -> liste les onglets
  // DELETE /tabs/:id        -> ferme un onglet
  if (route === "/tabs" || route.startsWith("/tabs/")) {
    try {
      if (req.method === "POST" && route === "/tabs") {
        return sendJson(res, 200, { ok: true, ...(await createTab(body.url)) });
      }
      if (req.method === "GET" && route === "/tabs") {
        return sendJson(res, 200, { ok: true, tabs: await listTabs() });
      }
      if (req.method === "DELETE" && route.startsWith("/tabs/")) {
        const id = decodeURIComponent(route.slice("/tabs/".length));
        const closed = await closeTab(id);
        return sendJson(res, closed ? 200 : 404, { ok: closed, error: closed ? undefined : `onglet introuvable: ${id}` });
      }
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || String(err) });
    }
    return sendJson(res, 404, { ok: false, error: `route onglet inconnue: ${req.method} ${route}` });
  }

  // `tab` (optionnel) : "<id>" cible cet onglet, "active" l'onglet regardé par
  // l'humain, absent = onglet par défaut. Accepté dans le corps (POST) OU en
  // query `?tab=` (indispensable pour les verbes GET, sans corps).
  const qTab = new URL(req.url, "http://localhost").searchParams.get("tab");
  const page = await getPage(body.tab ?? qTab ?? undefined);

  try {
    switch (`${req.method} ${route}`) {
      case "GET /":
      case "GET /status":
        return sendJson(res, 200, {
          ok: true,
          connected: true,
          url: page.url(),
          title: await page.title().catch(() => ""),
          evalEnabled: EVAL_ENABLED,
        });

      case "POST /navigate":
        return sendJson(res, 200, { ok: true, ...(await actions.navigate(page, body)) });

      case "GET /snapshot":
      case "POST /snapshot":
        return sendJson(res, 200, { ok: true, ...(await actions.snapshot(page, body)) });

      case "POST /click":
        return sendJson(res, 200, { ok: true, ...(await actions.click(page, body)) });

      case "POST /type":
        return sendJson(res, 200, { ok: true, ...(await actions.type(page, body)) });

      case "GET /screenshot":
      case "POST /screenshot":
        return sendJson(res, 200, { ok: true, ...(await actions.screenshot(page, body)) });

      case "GET /ax":
        return sendJson(res, 200, { ok: true, ...(await actions.ax(page)) });

      case "POST /eval": {
        if (!EVAL_ENABLED) {
          return sendJson(res, 403, { ok: false, error: "eval désactivé (AGENT_ENABLE_EVAL=1 pour activer)" });
        }
        const { code } = body;
        if (typeof code !== "string") return sendJson(res, 400, { ok: false, error: "{ code: string } requis" });
        const fn = new Function("page", "browser", `return (async () => {\n${code}\n})()`);
        const result = await fn(page, page.browser());
        return sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
      }

      default:
        return sendJson(res, 404, { ok: false, error: `route agent inconnue: ${req.method} ${route}` });
    }
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: err.message || String(err) });
  }
}
