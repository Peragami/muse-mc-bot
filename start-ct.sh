#!/bin/bash
# Run the Muze bot inside CT105, next to the Paper server (same container).
# The bot joins 127.0.0.1:25565 and serves its first-person viewer on :3007 (LAN reachable).
cd "$(dirname "$0")"
export MC_HOST=127.0.0.1 MC_PORT=25565 MC_USER="${MC_USER:-Muze}" VIEWER_PORT="${VIEWER_PORT:-3007}"
exec node bot.js
