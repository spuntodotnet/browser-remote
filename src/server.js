import http from "node:http";
import { spawnChrome, waitForChrome } from "./chrome.js";
import { cdpProxy, isProxiedPath } from "./proxy.js";
import { handleAppRoute } from "./routes.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

spawnChrome();
await waitForChrome();
console.log("Chrome CDP prêt.");

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (isProxiedPath(pathname)) {
    return cdpProxy.web(req, res);
  }
  handleAppRoute(req, res, pathname).catch((err) => {
    console.error(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (isProxiedPath(pathname)) {
    cdpProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`browser-remote listening on http://${HOST}:${PORT}`);
});
