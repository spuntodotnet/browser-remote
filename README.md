# browser-remote

Image Docker autonome donnant un contrôle interactif à distance d'un
navigateur headless (Chromium + Chrome DevTools Protocol) : une vraie barre
d'onglets, un écran embarqué (canvas + `Page.startScreencast`, clics/clavier
forwardés en direct), précédent/suivant/reload/adresse, et un bouton pour
ouvrir les DevTools complètes si besoin d'inspection avancée.

Basée sur Chromium (licence BSD, `apt install chromium`) — pas de dépendance
à browserless. Contexte technique complet et obstacles rencontrés pendant le
prototypage : voir `rfc/0001-remote-browser-control.md` dans le repo
`coderhammer/work`.

## Usage

Image publiée automatiquement sur `main` (voir
`.github/workflows/docker-publish.yml`) :

```bash
docker run -p 3000:3000 ghcr.io/coderhammer/browser-remote:latest
```

Ou en local :

```bash
docker build -t browser-remote .
docker run -p 3000:3000 browser-remote
```

Puis ouvrir `http://localhost:3000/`.

Variables d'environnement :

| Variable | Défaut | Usage |
|---|---|---|
| `PORT` | `3000` | Port d'écoute du serveur |
| `CHROME_BIN` | `chromium` (`/usr/bin/chromium` dans l'image) | Binaire Chrome/Chromium |
| `CHROME_USER_DATA_DIR` | `/tmp/chrome-profile` | Profil Chrome |
| `EXTRA_CA_CERT_PATH` | `/certs/extra-ca.pem` | Voir "CA locale additionnelle" ci-dessous |
| `ACTIVATE_STEALTH_PLUGIN` | désactivé | `true`/`1` pour activer `puppeteer-extra-plugin-stealth` (anti-fingerprinting, voir ci-dessous) |

## CA locale additionnelle (HTTPS avec un certificat non public)

Pour tester une app en HTTPS avec un certificat de CA locale (ex: `mkcert`)
plutôt qu'un certificat public, monter le fichier de la CA (pas le
certificat du site — la CA qui l'a signé) dans le conteneur et Chromium lui
fera confiance au démarrage :

```bash
docker run -p 3000:3000 \
  -v /path/to/rootCA.pem:/certs/extra-ca.pem:ro \
  ghcr.io/coderhammer/browser-remote:latest
```

No-op si le fichier n'est pas présent — comportement par défaut inchangé.
Importée à la fois dans le store système (`update-ca-certificates`) et dans
la base NSS de Chromium (`~/.pki/nssdb` via `certutil`) : Chromium sur Linux
consulte les deux, une CA ajoutée seulement au store système n'est pas
toujours suffisante.

## Anti-fingerprinting (optionnel)

`ACTIVATE_STEALTH_PLUGIN=true` active
[`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) :
il patche divers signaux qui trahissent un Chrome headless (renderer WebGL
`SwiftShader`, `navigator.webdriver`, `navigator.plugins` vide, `window.chrome`
incomplet, User-Agent contenant `HeadlessChrome`, etc.) pour se rapprocher
d'un Chrome desktop normal. Désactivé par défaut — comportement inchangé.

## API

- `GET /api/tabs` — liste les onglets ouverts (`{id, title, url}[]`)
- `POST /api/tabs` `{url}` — ouvre un nouvel onglet
- `POST /api/tabs/:id/activate` — rend un onglet actif (`Target.activateTarget`)
- `DELETE /api/tabs/:id` — ferme un onglet (`Target.closeTarget`)
- `WS /api/tabs/:id/screencast` — flux de frames JPEG (`Page.startScreencast`)
  + réception d'inputs souris/clavier et de commandes de navigation
  (précédent/suivant/reload/adresse) pour cet onglet (`src/screencast.js`)
- `/devtools/*`, `/json/*` — proxy passthrough vers le CDP interne de Chrome
  (nécessaire pour le contrôle à distance ; réécrit le header `Host`, sinon
  Chrome refuse toute requête dont le Host n'est pas `localhost`/une IP)

## Pilotage par script (Puppeteer)

Le proxy `/json/*`/`/devtools/*` ci-dessus permet aussi de piloter la même
instance Chrome depuis un script Puppeteer, en plus de (ou à la place de)
l'interface web — les deux voient et peuvent créer les mêmes onglets, en
temps réel, puisque c'est littéralement le même navigateur.

**Piège** : ne pas utiliser `puppeteer.connect({ browserURL })` tel quel.
Chrome annonce dans `/json/version` son propre WebSocket **interne**
(`ws://127.0.0.1:9222/...`), pas joignable depuis l'extérieur du conteneur.
Il faut récupérer ce endpoint via une requête HTTP normale (donc proxiée,
avec le bon `Host`), puis reconstruire l'URL du WebSocket avec le host
externe :

```js
import puppeteer from "puppeteer-core";

const CHROME_URL = "http://localhost:3000"; // ou l'URL publique du conteneur

const { webSocketDebuggerUrl } = await (await fetch(`${CHROME_URL}/json/version`)).json();
const browserWSEndpoint = `${CHROME_URL.replace(/^http/, "ws")}${new URL(webSocketDebuggerUrl).pathname}`;

const browser = await puppeteer.connect({ browserWSEndpoint });
const page = await browser.newPage();
await page.goto("https://example.com");
await page.screenshot({ path: "out.png" });

await browser.disconnect(); // laisse Chrome (et le conteneur) tourner
```

`page.click()`/`page.type()`/etc. suffisent pour interagir directement avec
la page ainsi ouverte — le screencast de l'UI web n'est utile que pour un
pilotage *humain*, pas pour un script.

**Piège `close()` vs `disconnect()`** : `browser.close()` envoie `Browser.close`
et **tue le process Chrome du conteneur** (donc tous les onglets, y compris
ceux ouverts depuis l'UI web) — c'est le comportement normal de Puppeteer
pour un navigateur qu'il a lui-même lancé, mais surprenant ici puisqu'on se
connecte à un navigateur qu'on ne possède pas. Toujours utiliser
`browser.disconnect()` pour se détacher sans arrêter Chrome.

## Sécurité — important

**Aucune authentification en v1.** Quiconque atteint le port exposé a un
contrôle total du navigateur (lecture/écriture de n'importe quelle page qui y
est ouverte). Ne pas exposer ce service sur un réseau non fiable sans une
protection additionnelle (reverse proxy avec auth, VPN, firewall...).

Une session pilotée est un **vrai navigateur** : le rendu et les
inputs (clic/clavier) sont deux pipelines CDP indépendants. Un clic mal placé
(rendu pas encore chargé, mauvaise coordonnée) peut atterrir sur un vrai
formulaire (identifiants, paiement...) sans retour visuel immédiat — observé
en pratique pendant le prototypage (navigation involontaire vers un flow de
connexion Google). Ne jamais saisir de vrais identifiants sans un retour
visuel fiable de ce qui est affiché.

Chromium tourne avec `--no-sandbox` (nécessaire en conteneur sans privilèges
étendus) — ne pas naviguer vers du contenu non fiable avec cette instance en
dehors d'un usage de test/dev.
