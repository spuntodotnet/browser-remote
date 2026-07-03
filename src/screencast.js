import WebSocket from "ws";
import { CDP_BASE_URL } from "./chrome.js";

const CDP_WS_HOST = new URL(CDP_BASE_URL).host;

// Pont entre le client (canvas + inputs) et le WebSocket CDP brut de Chrome
// pour un onglet précis (ws://.../devtools/page/<id>) — pas de Puppeteer ici :
// Page.startScreencast pousse des frames JPEG, Input.dispatch*Event reçoit
// les clics/clavier. Chrome ne compose/rend réellement que l'onglet actif
// (Target.activateTarget, voir cdpClient.js), donc le client doit activer
// l'onglet avant/au moment d'ouvrir le screencast.
export function attachScreencast(clientWs, targetId) {
  const chromeWs = new WebSocket(`ws://${CDP_WS_HOST}/devtools/page/${targetId}`);
  let msgId = 0;
  const send = (method, params = {}) => {
    if (chromeWs.readyState === WebSocket.OPEN) {
      chromeWs.send(JSON.stringify({ id: ++msgId, method, params }));
    }
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
    if (msg.method === "Page.screencastFrame") {
      const { sessionId, data } = msg.params;
      send("Page.screencastFrameAck", { sessionId });
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.send(JSON.stringify({ type: "frame", data }));
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
    dispatchInput(send, msg);
  });

  clientWs.on("close", () => {
    send("Page.stopScreencast");
    chromeWs.close();
  });
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
