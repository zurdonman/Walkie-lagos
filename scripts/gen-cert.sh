#!/usr/bin/env bash
# Genera un certificado autofirmado para probar el micrófono por HTTPS en la LAN.
# Los móviles avisarán de certificado no confiable la primera vez; para producción
# de verdad usa un dominio con Let's Encrypt o pon la app detrás de un proxy HTTPS.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
IP="${1:-}"
SUBJ="/C=ES/ST=Valencia/L=Castello/O=Walkie Lagos/CN=walkie-lagos.local"

if [ -n "$IP" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "$SUBJ" -addext "subjectAltName=DNS:walkie-lagos.local,IP:${IP}"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "$SUBJ" -addext "subjectAltName=DNS:walkie-lagos.local,IP:127.0.0.1"
fi

echo "Listo: certs/key.pem y certs/cert.pem"
echo "Arranca con: npm run https"
