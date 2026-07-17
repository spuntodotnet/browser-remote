#!/bin/bash
# Trust une CA locale supplémentaire (ex: mkcert) si montée, pour tester du
# HTTPS avec un certificat non public (voir README.md). No-op si absente —
# ne change rien au comportement par défaut.
set -e

CA_FILE="${EXTRA_CA_CERT_PATH:-/certs/extra-ca.pem}"

if [ -f "$CA_FILE" ]; then
  cp "$CA_FILE" /usr/local/share/ca-certificates/extra-ca.crt
  update-ca-certificates >/dev/null

  # Chromium sur Linux consulte aussi son propre store NSS, pas seulement le
  # store système — il faut l'importer aux deux endroits.
  export HOME="${HOME:-/root}"
  NSSDB="$HOME/.pki/nssdb"
  mkdir -p "$NSSDB"
  # `certutil -N` (création du store) n'est PAS idempotent : relancé sur un store DÉJÀ créé
  # (conteneur redémarré, couche writable conservée), il réclame le mot de passe du store
  # existant sur un terminal absent et BOUCLE à l'infini ("Invalid password. Try again.",
  # 100% CPU) — ce qui bloque `exec "$@"`, donc le serveur ne démarre jamais et rien n'écoute
  # sur :3000. Le `|| true` n'aide pas (ça n'attrape qu'un exit non-zéro, pas un hang).
  # → on ne (re)crée le store que s'il n'existe pas, et on ferme stdin (< /dev/null) sur TOUS
  # les certutil pour qu'aucun ne puisse se bloquer sur un prompt de mot de passe.
  if [ ! -f "$NSSDB/cert9.db" ]; then
    certutil -N --empty-password -d "sql:$NSSDB" < /dev/null
  fi
  certutil -D -n "extra-ca" -d "sql:$NSSDB" < /dev/null 2>/dev/null || true
  certutil -A -n "extra-ca" -t "C,," -i "$CA_FILE" -d "sql:$NSSDB" < /dev/null
fi

# Chromium écrit un SingletonLock dans le profil (symlink `<hostname>-<pid>`).
# Sur un profil PERSISTANT (volume), un conteneur recréé a un nouveau hostname
# → le nouveau Chromium voit un lock « appartenant à un autre ordinateur » et
# REFUSE de démarrer ("profile appears to be in use by another Chromium process
# on another computer", exit 21) — le serveur ne démarre alors jamais. Après un
# arrêt propre Chromium retire ce lock, mais pas après un kill/recreate (cas du
# redeploy). Un conteneur qui vient de démarrer n'a aucun Chromium en cours, donc
# tout Singleton* présent est forcément résiduel : on le purge avant de lancer.
PROFILE_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-profile}"
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket "$PROFILE_DIR"/SingletonCookie 2>/dev/null || true

exec "$@"
