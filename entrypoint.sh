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
  mkdir -p "$HOME/.pki/nssdb"
  certutil -N --empty-password -d "sql:$HOME/.pki/nssdb" 2>/dev/null || true
  certutil -D -n "extra-ca" -d "sql:$HOME/.pki/nssdb" 2>/dev/null || true
  certutil -A -n "extra-ca" -t "C,," -i "$CA_FILE" -d "sql:$HOME/.pki/nssdb"
fi

exec "$@"
