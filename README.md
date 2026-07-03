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

## API

- `GET /api/tabs` — liste les onglets ouverts (`{id, title, url}[]`)
- `POST /api/tabs` `{url}` — ouvre un nouvel onglet
- `POST /api/tabs/:id/activate` — rend un onglet actif (`Target.activateTarget`)
- `WS /api/tabs/:id/screencast` — flux de frames JPEG (`Page.startScreencast`)
  + réception d'inputs souris/clavier et de commandes de navigation
  (précédent/suivant/reload/adresse) pour cet onglet (`src/screencast.js`)
- `/devtools/*`, `/json/*` — proxy passthrough vers le CDP interne de Chrome
  (nécessaire pour le contrôle à distance ; réécrit le header `Host`, sinon
  Chrome refuse toute requête dont le Host n'est pas `localhost`/une IP)

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
