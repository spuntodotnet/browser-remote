import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CDP_BASE_URL } from "./chrome.js";
import { activateTab, openTab } from "./cdpClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = await readFile(join(__dirname, "public", "index.html"), "utf8");

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

async function listTabs() {
  const res = await fetch(`${CDP_BASE_URL}/json/list`);
  const targets = await res.json();
  return targets
    .filter((t) => t.type === "page")
    .filter((t) => !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-untrusted://"))
    .map((t) => ({ id: t.id, title: t.title || t.url, url: t.url }));
}

export async function handleAppRoute(req, res, pathname) {
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(INDEX_HTML);
  }

  if (req.method === "GET" && pathname === "/api/tabs") {
    const tabs = await listTabs();
    return sendJson(res, 200, { tabs });
  }

  if (req.method === "POST" && pathname === "/api/tabs") {
    const { url } = await readBody(req);
    if (!url) return sendJson(res, 400, { error: "body must be { url: string }" });
    const id = await openTab(url);
    return sendJson(res, 200, { id });
  }

  const activateMatch = pathname.match(/^\/api\/tabs\/([^/]+)\/activate$/);
  if (req.method === "POST" && activateMatch) {
    await activateTab(activateMatch[1]);
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: "not found" });
}
