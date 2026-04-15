#!/usr/bin/with-contenv bashio
set -euo pipefail

bashio::log.info "Starting IPTV Premium add-on backend..."
cd /app
node /app/backend/server.js
