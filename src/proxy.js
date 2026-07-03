import httpProxy from "http-proxy";
import { CDP_BASE_URL } from "./chrome.js";

// Chrome refuse (500 "Host header is specified and is not an IP address or
// localhost") toute requête dont le header Host n'est pas localhost/une IP
// littérale — protection anti-DNS-rebinding, aucun flag pour la désactiver.
// On réécrit donc le Host avant de forwarder en interne. Voir le RFC dans le
// repo work (coderhammer/work, rfc/0001-remote-browser-control.md).
const CDP_HOST_HEADER = new URL(CDP_BASE_URL).host;

export const cdpProxy = httpProxy.createProxyServer({ target: CDP_BASE_URL, ws: true });

cdpProxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("Host", CDP_HOST_HEADER));
cdpProxy.on("proxyReqWs", (proxyReq) => proxyReq.setHeader("Host", CDP_HOST_HEADER));
cdpProxy.on("error", (err, req, res) => {
  console.error("cdp proxy error:", err.message);
  if (res && res.writeHead) {
    res.writeHead(502);
    res.end("cdp proxy error: " + err.message);
  }
});

export function isProxiedPath(pathname) {
  return pathname.startsWith("/devtools/") || pathname.startsWith("/json/");
}
