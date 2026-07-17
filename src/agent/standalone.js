// Harnais de DEV : démarre uniquement les routes /api/agent/* (sans spawn de
// Chrome), branché sur le Chrome d'un conteneur browser-remote distant via
// CDP_EXTERNAL_URL. Permet de tester la couche agent en live sans rebuild de
// l'image Docker.
//
//   CDP_EXTERNAL_URL=http://browser-remote:3000 node src/agent/standalone.js
//
// N'écoute que sur 127.0.0.1 par défaut (l'agent peut exposer /eval).

import http from "node:http";
import { handleAgentRoute } from "./routes.js";

const PORT = Number(process.env.AGENT_PORT) || 3003;
const HOST = process.env.AGENT_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  handleAgentRoute(req, res, pathname)
    .then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "route hors /api/agent" }));
      }
    })
    .catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
});

server.listen(PORT, HOST, () => {
  console.log(`agent standalone (dev) → ${process.env.CDP_EXTERNAL_URL || "local CDP"} sur http://${HOST}:${PORT}`);
});
