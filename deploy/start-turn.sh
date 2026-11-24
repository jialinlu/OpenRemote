#!/bin/sh
# This file is original project deployment glue, not an upstream coturn script.
set -eu
fail() { printf '%s\n' "$1" >&2; exit 1; }
case "${TURN_DOMAIN:-}" in ''|*[!A-Za-z0-9.-]*) fail 'TURN_DOMAIN must be a DNS hostname.' ;; esac
case "${TURN_EXTERNAL_IP:-}" in ''|*[!0-9./]*) fail 'TURN_EXTERNAL_IP must be IPv4 or public/private IPv4.' ;; esac
case "${TURN_RELAY_IP:-}" in ''|*[!0-9.]*) fail 'TURN_RELAY_IP must be the local IPv4 interface address.' ;; esac
case "${TURN_USERNAME:-}" in ''|*[!A-Za-z0-9_-]*) fail 'TURN_USERNAME may contain only letters, digits, underscore and dash.' ;; esac
case "${TURN_PASSWORD:-}" in ''|*[!A-Fa-f0-9]*) fail 'TURN_PASSWORD must be randomly generated hexadecimal.' ;; esac
[ "${#TURN_PASSWORD}" -ge 64 ] || fail 'TURN_PASSWORD must contain at least 64 hex characters.'
case "${TURN_TLS:-0}" in 0|1) ;; *) fail 'TURN_TLS must be 0 or 1.' ;; esac
umask 077
cat > /tmp/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
relay-ip=${TURN_RELAY_IP}
external-ip=${TURN_EXTERNAL_IP}
realm=${TURN_DOMAIN}
server-name=${TURN_DOMAIN}
fingerprint
lt-cred-mech
user=${TURN_USERNAME}:${TURN_PASSWORD}
min-port=49160
max-port=49200
user-quota=8
total-quota=8
max-bps=5000000
bps-capacity=10000000
stale-nonce=600
no-multicast-peers
no-tcp-relay
no-cli
no-dtls
unauthorized-ratelimit
unauthorized-ratelimit-rps=5
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
log-file=stdout
log-min-level=warning
pidfile=/tmp/turnserver.pid
EOF
if [ "${TURN_TLS:-0}" = 1 ]; then
  [ -r /certs/fullchain.pem ] && [ -r /certs/privkey.pem ] || fail 'TURN TLS requires readable /certs/fullchain.pem and /certs/privkey.pem.'
  cat >> /tmp/turnserver.conf <<EOF
tls-listening-port=5349
cert=/certs/fullchain.pem
pkey=/certs/privkey.pem
EOF
else
  printf '%s\n' 'no-tls' >> /tmp/turnserver.conf
fi
exec turnserver -c /tmp/turnserver.conf
