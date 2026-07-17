# browser-remote

Standalone Docker image providing remote interactive control of a headless
browser (Chromium + Chrome DevTools Protocol): a real tab bar, an embedded
screen (canvas + `Page.startScreencast`, clicks/keyboard forwarded live),
back/forward/reload/address bar, and a button to open full DevTools when
advanced inspection is needed.

Based on Chromium (BSD license, `apt install chromium`) — no dependency on
browserless. Full technical context and obstacles encountered during
prototyping: see `rfc/0001-remote-browser-control.md` in the
`coderhammer/work` repo.

## Usage

Image published automatically on `main` (see
`.github/workflows/docker-publish.yml`):

```bash
docker run -p 3000:3000 ghcr.io/spuntodotnet/browser-remote:latest
```

Or locally:

```bash
docker build -t browser-remote .
docker run -p 3000:3000 browser-remote
```

Then open `http://localhost:3000/`.

Environment variables:

| Variable | Default | Usage |
|---|---|---|
| `PORT` | `3000` | Server listening port |
| `CHROME_BIN` | `chromium` (`/usr/bin/chromium` in the image) | Chrome/Chromium binary |
| `CHROME_USER_DATA_DIR` | `/tmp/chrome-profile` | Chrome profile |
| `EXTRA_CA_CERT_PATH` | `/certs/extra-ca.pem` | See "Additional local CA" below |
| `ACTIVATE_STEALTH_PLUGIN` | disabled | `true`/`1` to enable `puppeteer-extra-plugin-stealth` (anti-fingerprinting, see below) |
| `AGENT_ENABLE_EVAL` | disabled | `true`/`1` to enable `POST /api/agent/eval` (arbitrary JS — see "Agent API") |
| `CDP_EXTERNAL_URL` | — | dev only: point the agent layer at a **remote** container's Chrome (e.g. `npm run agent-dev`) |

## Additional local CA (HTTPS with a non-public certificate)

To test an app over HTTPS with a certificate from a local CA (e.g. `mkcert`)
rather than a public certificate, mount the CA file (not the site's
certificate — the CA that signed it) into the container and Chromium will
trust it at startup:

```bash
docker run -p 3000:3000 \
  -v /path/to/rootCA.pem:/certs/extra-ca.pem:ro \
  ghcr.io/spuntodotnet/browser-remote:latest
```

No-op if the file isn't present — default behavior unchanged. Imported both
into the system store (`update-ca-certificates`) and into Chromium's NSS
database (`~/.pki/nssdb` via `certutil`): Chromium on Linux consults both, a
CA added only to the system store isn't always sufficient.

## Anti-fingerprinting (optional)

`ACTIVATE_STEALTH_PLUGIN=true` enables
[`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth):
it patches various signals that give away a headless Chrome (`SwiftShader`
WebGL renderer, `navigator.webdriver`, empty `navigator.plugins`, incomplete
`window.chrome`, User-Agent containing `HeadlessChrome`, etc.) to look closer
to a regular desktop Chrome. Disabled by default — behavior unchanged.

## API

- `GET /api/tabs` — lists open tabs (`{id, title, url}[]`)
- `POST /api/tabs` `{url}` — opens a new tab
- `POST /api/tabs/:id/activate` — makes a tab active (`Target.activateTarget`)
- `DELETE /api/tabs/:id` — closes a tab (`Target.closeTarget`)
- `WS /api/tabs/:id/screencast` — JPEG frame stream (`Page.startScreencast`)
  + receives mouse/keyboard input and navigation commands
  (back/forward/reload/address) for that tab (`src/screencast.js`)
- `/devtools/*`, `/json/*` — passthrough proxy to Chrome's internal CDP
  (needed for remote control; rewrites the `Host` header, since Chrome
  refuses any request whose Host isn't `localhost`/an IP)

## Agent API — high-level verbs for AI agents

Raw CDP is awkward for an AI agent to drive: it has to reason about selectors,
shadow DOM, pixel scaling, and keyboard interception itself. The **agent API**
(`/api/agent/*`) wraps all that into a handful of high-level verbs, and encodes
the recurring gotchas once (shadow-DOM traversal, CSS pixels == screenshot
pixels, values set via the native DOM setter so global keyboard shortcuts can't
intercept them).

The centerpiece is the **snapshot-with-refs** model: one call returns the page's
interactive elements, each with a stable `ref` id, so the agent acts by `ref`
(unambiguous) instead of guessing a selector or text.

| Endpoint | Body | Does |
|---|---|---|
| `GET /api/agent/status` | — | current url/title, whether eval is enabled |
| `POST /api/agent/navigate` | `{url}` | go to a URL, wait for load |
| `GET/POST /api/agent/snapshot` | `{withText?}` | `{url, title, elements:[{ref,tag,role,name,value,x,y,w,h,onscreen}], text}` — **call before clicking/typing** |
| `POST /api/agent/click` | `{ref}` \| `{text,exact?,nth?}` \| `{x,y}` | click (prefer `ref` from a snapshot) |
| `POST /api/agent/type` | `{value, ref\|selector\|field, submit?}` | fill a field (native setter), optionally press Enter |
| `GET /api/agent/ax` | — | compact accessibility tree (roles + names + values) |
| `GET/POST /api/agent/screenshot` | `{fullPage?}` | PNG as base64 (`{mimeType, base64}`) |
| `POST /api/agent/eval` | `{code}` | run arbitrary JS on the page — **disabled unless `AGENT_ENABLE_EVAL=1`** |
| `POST /api/agent/tabs` | `{url?}` | open a **dedicated** tab, returns its `tab` id |
| `GET /api/agent/tabs` | — | list open tabs (`[{tab, url, title}]`) |
| `DELETE /api/agent/tabs/:tab` | — | close a tab |

### Tabs — autonomy and parallelism

Every action verb takes an optional **`tab`** (in the body, or `?tab=` for GET
requests). This is what makes independent, parallel work possible on a single
shared browser:

- **Dedicated tab (autonomy)** — `POST /api/agent/tabs` gives the agent its own
  tab id; it passes `{tab}` on every call. Fully decoupled from what the human is
  looking at: the human can switch tabs in the nested-browser UI without
  disturbing the agent, and the agent reads/clicks/screenshots its **background**
  tab without stealing focus. Several agents → several tabs → real parallelism
  (Chrome drives each tab independently).
- **Co-drive** — `{tab: "active"}` acts on the tab the human is currently watching
  (the one with an open screencast). Omitting `tab` uses a default tab.

```bash
BASE=http://localhost:3000
TAB=$(curl -s -X POST $BASE/api/agent/tabs -d '{"url":"https://example.com"}' | jq -r .tab)
curl -s "$BASE/api/agent/snapshot?tab=$TAB"          # -> elements[].ref
curl -s -X POST $BASE/api/agent/click -d "{\"ref\":\"e0\",\"tab\":\"$TAB\"}"
curl -s -X POST $BASE/api/agent/type  -d "{\"field\":\"q\",\"value\":\"hi\",\"submit\":true,\"tab\":\"$TAB\"}"
```

The verbs live in `src/agent/` and can be exercised standalone against a remote
container (dev, no image rebuild): `CDP_EXTERNAL_URL=http://the-container:3000
npm run agent-dev`.

## MCP server — plug the browser into an AI agent in one line

`mcp/server.js` is a Model Context Protocol server (stdio) that exposes the agent
API as auto-discoverable tools (`browser_snapshot`, `browser_navigate`,
`browser_click`, `browser_type`, `browser_screenshot`, `browser_read_ax`,
`browser_list_tabs`). Any MCP-capable agent (Claude Code/Desktop, etc.) picks
them up with no glue code. It bridges to a running browser-remote via
`BROWSER_REMOTE_URL`.

**Each MCP session opens and pins its own dedicated tab** on first use, so
multiple agents (or multiple Claude Code windows) work in parallel without
stepping on each other, independently of what the human is viewing. The tab is
closed automatically when the session ends. Set `BROWSER_REMOTE_TAB=active` to
co-drive the human's current tab instead, or `BROWSER_REMOTE_TAB=<id>` for a
specific one.

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "browser-remote-mcp"],
      "env": { "BROWSER_REMOTE_URL": "http://localhost:3000" }
    }
  }
}
```

(or `"command": "node", "args": ["mcp/server.js"]` from a checkout).

## Scripting (Puppeteer)

The `/json/*`/`/devtools/*` proxy above also lets you drive the same Chrome
instance from a Puppeteer script, in addition to (or instead of) the web
UI — both see and can create the same tabs, in real time, since it's
literally the same browser.

**Gotcha**: don't use `puppeteer.connect({ browserURL })` as-is. Chrome
advertises its own **internal** WebSocket in `/json/version`
(`ws://127.0.0.1:9222/...`), not reachable from outside the container. You
need to fetch that endpoint via a normal HTTP request (so, proxied, with the
right `Host`), then rebuild the WebSocket URL with the external host:

```js
import puppeteer from "puppeteer-core";

const CHROME_URL = "http://localhost:3000"; // or the container's public URL

const { webSocketDebuggerUrl } = await (await fetch(`${CHROME_URL}/json/version`)).json();
const browserWSEndpoint = `${CHROME_URL.replace(/^http/, "ws")}${new URL(webSocketDebuggerUrl).pathname}`;

const browser = await puppeteer.connect({ browserWSEndpoint });
const page = await browser.newPage();
await page.goto("https://example.com");
await page.screenshot({ path: "out.png" });

await browser.disconnect(); // leaves Chrome (and the container) running
```

`page.click()`/`page.type()`/etc. are enough to interact directly with the
page opened this way — the web UI's screencast is only useful for *human*
piloting, not for a script.

**Gotcha, `close()` vs `disconnect()`**: `browser.close()` sends
`Browser.close` and **kills the container's Chrome process** (so all tabs,
including those opened from the web UI) — this is normal Puppeteer behavior
for a browser it launched itself, but surprising here since we're connecting
to a browser we don't own. Always use `browser.disconnect()` to detach
without stopping Chrome.

## Security — important

**No authentication in v1.** Anyone reaching the exposed port has full
control of the browser (read/write access to whatever page is open there).
Do not expose this service on an untrusted network without additional
protection (reverse proxy with auth, VPN, firewall...).

A driven session is a **real browser**: rendering and inputs (click/keyboard)
are two independent CDP pipelines. A misplaced click (rendering not yet
loaded, wrong coordinates) can land on a real form (credentials, payment...)
without immediate visual feedback — observed in practice during prototyping
(unintended navigation into a Google login flow). Never enter real
credentials without reliable visual feedback of what's displayed.

Chromium runs with `--no-sandbox` (needed in a container without extended
privileges) — do not navigate to untrusted content with this instance
outside of a test/dev use case.
