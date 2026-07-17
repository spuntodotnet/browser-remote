#!/usr/bin/env node
// Serveur MCP (stdio) pour browser-remote : expose le navigateur comme un jeu
// d'outils qu'un agent IA découvre automatiquement (Claude Code/Desktop, etc.).
// Pont léger : chaque outil appelle l'API REST haut-niveau /api/agent/* d'une
// instance browser-remote (celle-ci doit tourner et être joignable).
//
// Config côté agent (ex. Claude Code, ~/.claude/mcp ou --mcp-config) :
//   {
//     "mcpServers": {
//       "browser": {
//         "command": "node",
//         "args": ["mcp/server.js"],
//         "env": { "BROWSER_REMOTE_URL": "http://localhost:3000" }
//       }
//     }
//   }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.BROWSER_REMOTE_URL || "http://localhost:3000").replace(/\/$/, "");

// Appelle un verbe de la couche agent REST. GET pour les lectures sans corps.
async function call(verb, body, method = "POST") {
  const res = await fetch(`${BASE}/api/agent/${verb}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `réponse non-JSON (HTTP ${res.status})` }));
  if (json.ok === false) throw new Error(json.error || "échec de l'action");
  return json;
}

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "browser-remote", version: "0.1.0" });

server.tool(
  "browser_snapshot",
  "Lit l'état de la page : URL, titre, texte rendu, et la liste des éléments " +
    "interactifs (liens/boutons/champs) avec un `ref` stable chacun. TOUJOURS " +
    "appeler ceci avant de cliquer/saisir : les `ref` servent à cibler les " +
    "éléments sans ambiguïté. Traverse le shadow DOM.",
  {},
  async () => text(await call("snapshot", {}, "GET")),
);

server.tool(
  "browser_navigate",
  "Ouvre une URL dans l'onglet courant et attend le chargement.",
  { url: z.string().describe("URL absolue (https://…)") },
  async ({ url }) => text(await call("navigate", { url })),
);

server.tool(
  "browser_click",
  "Clique un élément. Cible de préférence par `ref` (issu de browser_snapshot). " +
    "À défaut par `text` (libellé/aria-label, sous-chaîne) ou par coordonnées `x`/`y` " +
    "(pixels CSS). Renvoie ce qui a été cliqué.",
  {
    ref: z.string().optional().describe("ref d'un élément d'un snapshot récent (recommandé)"),
    text: z.string().optional().describe("libellé de l'élément si pas de ref"),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async (args) => text(await call("click", args)),
);

server.tool(
  "browser_type",
  "Saisit une valeur dans un champ (par `ref`, `selector` CSS, ou `field` = " +
    "placeholder/label/name). Pose la valeur via le setter DOM natif (robuste aux " +
    "raccourcis clavier). `submit:true` presse Entrée après.",
  {
    value: z.string().describe("texte à saisir"),
    ref: z.string().optional(),
    selector: z.string().optional(),
    field: z.string().optional().describe("placeholder / label / name du champ"),
    submit: z.boolean().optional(),
  },
  async (args) => text(await call("type", args)),
);

server.tool(
  "browser_screenshot",
  "Capture la page visible en PNG. Utile quand la structure (snapshot) ne suffit " +
    "pas à comprendre l'écran.",
  {},
  async () => {
    const r = await call("screenshot", {}, "GET");
    return { content: [{ type: "image", data: r.base64, mimeType: r.mimeType }] };
  },
);

server.tool(
  "browser_read_ax",
  "Arbre d'accessibilité compact (rôles + noms + valeurs). Alternative légère au " +
    "snapshot quand on ne veut que « qu'y a-t-il à l'écran » sans coordonnées.",
  {},
  async () => text(await call("ax", {}, "GET")),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`browser-remote MCP prêt → ${BASE}`);
