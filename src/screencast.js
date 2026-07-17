import WebSocket from "ws";
import { CDP_BASE_URL } from "./chrome.js";

const CDP_WS_HOST = new URL(CDP_BASE_URL).host;

// Onglets actuellement regardés par un humain (un screencast ouvert = un
// viewer). Sert au mode co-pilotage de la couche agent ({tab:"active"}) : agir
// sur l'onglet que l'humain a sous les yeux. Ordre d'insertion = le dernier
// ajouté est le plus récemment ouvert.
const viewedTabs = new Set();

// targetId de l'onglet le plus récemment mis en avant-plan par un humain, ou
// null si personne ne regarde. (Set préserve l'ordre d'insertion.)
export function getActiveViewedTab() {
  let last = null;
  for (const id of viewedTabs) last = id;
  return last;
}

// Pont entre le client (canvas + inputs + navigation) et le WebSocket CDP brut
// de Chrome pour un onglet précis (ws://.../devtools/page/<id>) — pas de
// Puppeteer ici : Page.startScreencast pousse des frames JPEG,
// Input.dispatch*Event reçoit les clics/clavier, Page.navigate* pilote
// précédent/suivant/reload/adresse. Chrome ne compose/rend réellement que
// l'onglet actif (Target.activateTarget, voir cdpClient.js), donc le client
// doit activer l'onglet avant/au moment d'ouvrir le screencast.
export function attachScreencast(clientWs, targetId) {
  const chromeWs = new WebSocket(`ws://${CDP_WS_HOST}/devtools/page/${targetId}`);
  // un viewer humain vient d'ouvrir cet onglet : le marquer comme regardé
  // (re-insertion => devient le plus récent, cf getActiveViewedTab).
  viewedTabs.delete(targetId);
  viewedTabs.add(targetId);
  let msgId = 0;
  const pending = new Map();

  const send = (method, params = {}) => {
    const id = ++msgId;
    if (chromeWs.readyState === WebSocket.OPEN) {
      chromeWs.send(JSON.stringify({ id, method, params }));
    }
    return new Promise((resolve) => pending.set(id, resolve));
  };

  chromeWs.on("open", () => {
    send("Page.enable");
    send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  });

  chromeWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }

    if (msg.method === "Page.screencastFrame") {
      const { sessionId, data } = msg.params;
      send("Page.screencastFrameAck", { sessionId });
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.send(JSON.stringify({ type: "frame", data }));
      }
      return;
    }

    if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) {
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.send(JSON.stringify({ type: "navigated", url: msg.params.frame.url }));
      }
    }
  });

  chromeWs.on("error", (err) => {
    console.error("screencast chrome ws error:", err.message);
    clientWs.close();
  });
  chromeWs.on("close", () => clientWs.close());

  clientWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "back" || msg.type === "forward") {
      navigateHistory(send, msg.type);
    } else if (msg.type === "reload") {
      send("Page.reload", { ignoreCache: false });
    } else if (msg.type === "navigate" && msg.url) {
      send("Page.navigate", { url: msg.url });
    } else if (msg.type === "resize" && msg.width > 0 && msg.height > 0) {
      // Emulation.setDeviceMetricsOverride plutôt que Browser.setWindowBounds :
      // ce dernier redimensionne la fenêtre OS-level, qui réserve en interne
      // ~87px de hauteur (chrome de fenêtre fantôme) même en headless — écart
      // vérifié empiriquement. setDeviceMetricsOverride pilote directement la
      // taille de rendu de la page, donc les frames du screencast matchent
      // exactement width/height demandés, sans ce décalage.
      send("Emulation.setDeviceMetricsOverride", {
        width: Math.round(msg.width),
        height: Math.round(msg.height),
        deviceScaleFactor: 0,
        mobile: false,
      });
    } else {
      dispatchInput(send, msg);
    }
  });

  clientWs.on("close", () => {
    viewedTabs.delete(targetId);
    send("Page.stopScreencast");
    chromeWs.close();
  });
}

async function navigateHistory(send, direction) {
  const history = await send("Page.getNavigationHistory");
  if (!history) return;
  const targetIndex = history.currentIndex + (direction === "back" ? -1 : 1);
  const entry = history.entries[targetIndex];
  if (entry) send("Page.navigateToHistoryEntry", { entryId: entry.id });
}

const MODIFIER_ALT = 1;
const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;

function modifiersFrom(m) {
  return (
    (m.alt ? MODIFIER_ALT : 0) |
    (m.ctrl ? MODIFIER_CTRL : 0) |
    (m.meta ? MODIFIER_META : 0) |
    (m.shift ? MODIFIER_SHIFT : 0)
  );
}

function dispatchInput(send, msg) {
  const modifiers = modifiersFrom(msg.modifiers || {});

  if (msg.type === "mouseMove" || msg.type === "mouseDown" || msg.type === "mouseUp" || msg.type === "wheel") {
    const cdpType = { mouseMove: "mouseMoved", mouseDown: "mousePressed", mouseUp: "mouseReleased", wheel: "mouseWheel" }[msg.type];
    send("Input.dispatchMouseEvent", {
      type: cdpType,
      x: msg.x,
      y: msg.y,
      button: msg.button || "none",
      buttons: msg.buttons || 0,
      clickCount: msg.type === "mouseDown" || msg.type === "mouseUp" ? 1 : undefined,
      deltaX: msg.deltaX,
      deltaY: msg.deltaY,
      modifiers,
    });
    return;
  }

  if (msg.type === "keyDown" || msg.type === "keyUp") {
    send("Input.dispatchKeyEvent", {
      type: msg.type === "keyDown" ? (msg.text ? "keyDown" : "rawKeyDown") : "keyUp",
      key: msg.key,
      code: msg.code,
      text: msg.text,
      unmodifiedText: msg.text,
      windowsVirtualKeyCode: msg.keyCode,
      nativeVirtualKeyCode: msg.keyCode,
      modifiers,
    });
  }
}
