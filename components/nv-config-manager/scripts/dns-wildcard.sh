#!/usr/bin/env bash
#
# dns-wildcard.sh — point *.host.example.com at the host cluster's gateway LB.
#
# Per-tenant hostnames are <slug>.host.example.com and
# svc-*.<slug>.host.example.com, so a single wildcard A record
# (*.host.example.com) covers them all. Idempotent: updates the record in
# place if it already exists.
#
# If your zone is Cloudflare-hosted, create a scoped API token
# (Zone:DNS:Edit on your zone) and pass it in, along with the zone id.
#
#   Usage:
#     CF_API_TOKEN=... GATEWAY_IP=203.0.113.10 ./dns-wildcard.sh
#
# Find GATEWAY_IP with:
#     kubectl get svc -n envoy-gateway-system \
#       -l gateway.envoyproxy.io/owning-gateway-name \
#       -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}'
#
set -euo pipefail

CF_API_TOKEN="${CF_API_TOKEN:?set CF_API_TOKEN (Zone:DNS:Edit on your zone)}"
GATEWAY_IP="${GATEWAY_IP:?set GATEWAY_IP (the gateway LoadBalancer IP)}"
ZONE_ID="${ZONE_ID:?set ZONE_ID to your Cloudflare zone id}"
NAME="${NAME:-*.host.example.com}"
PROXIED="${PROXIED:-false}"   # wildcard + cert-manager DNS-01 → keep DNS-only
API="https://api.cloudflare.com/client/v4"

auth=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")
body="$(printf '{"type":"A","name":"%s","content":"%s","ttl":120,"proxied":%s}' \
  "$NAME" "$GATEWAY_IP" "$PROXIED")"

existing="$(curl -s "${auth[@]}" \
  "$API/zones/$ZONE_ID/dns_records?type=A&name=$NAME" \
  | grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4 || true)"

if [[ -n "$existing" ]]; then
  echo "updating A $NAME -> $GATEWAY_IP ($existing)"
  curl -s -X PUT "${auth[@]}" "$API/zones/$ZONE_ID/dns_records/$existing" \
    --data "$body" | grep -q '"success":true' \
    && echo "  ok" || { echo "  FAILED" >&2; exit 1; }
else
  echo "creating A $NAME -> $GATEWAY_IP"
  curl -s -X POST "${auth[@]}" "$API/zones/$ZONE_ID/dns_records" \
    --data "$body" | grep -q '"success":true' \
    && echo "  ok" || { echo "  FAILED" >&2; exit 1; }
fi
