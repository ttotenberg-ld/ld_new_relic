#!/usr/bin/env bash
# Generate a self-signed certificate for the local TLS terminator (Caddy),
# which sits in front of PCG so the NR Node agent (v12, TLS-only) can reach
# PCG's plain-HTTP nrproprietaryreceiver.
#
# Output: cert.pem + key.pem in this directory. Both are PoC-only, never use
# in production. They're gitignored.

set -euo pipefail
cd "$(dirname "$0")"

if [ -f cert.pem ] && [ -f key.pem ]; then
  echo "cert.pem + key.pem already exist; skipping. Delete them to regenerate."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=pcg-tls" \
  -addext "subjectAltName=DNS:pcg-tls,DNS:host.docker.internal,DNS:localhost"

chmod 600 key.pem
echo "Generated cert.pem + key.pem (valid 365 days, CN=pcg-tls)"
