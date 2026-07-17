import http from "node:http";
import { WebSocketServer } from "ws";
import { spawnChrome, waitForChrome } from "./chrome.js";
import { cdpProxy, isProxiedPath } from "./proxy.js";
import { handleAppRoute } from "./routes.js";
import { handleAgentRoute } from "./agent/routes.js";
import { attachScreencast } from "./screencast.js";
import { ensureDefaultTab } from "./cdpClient.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const SCREENCAST_RE = /^\/api\/tabs\/([^/]+)\/screencast$/;

spawnChrome();
await waitForChrome();
console.log("Chrome CDP prêt.");
await ensureDefaultTab();

const screencastWss = new WebSocketServer({ noServer: true });

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (isProxiedPath(pathname)) {
    return cdpProxy.web(req, res);
  }
  const onError = (err) => {
    console.error(err);
    if (res.headersSent) return;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  };
  // La couche agent (/api/agent/*) est tentée d'abord ; si elle ne prend pas la
  // route, on retombe sur les routes app classiques (UI, /api/tabs).
  handleAgentRoute(req, res, pathname)
    .then((handled) => {
      if (!handled) return handleAppRoute(req, res, pathname);
    })
    .catch(onError);
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const screencastMatch = pathname.match(SCREENCAST_RE);
  if (screencastMatch) {
    screencastWss.handleUpgrade(req, socket, head, (clientWs) => {
      attachScreencast(clientWs, screencastMatch[1]);
    });
  } else if (isProxiedPath(pathname)) {
    cdpProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`browser-remote listening on http://${HOST}:${PORT}`);
});
