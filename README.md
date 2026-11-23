# muse-mc-bot

Muze (Mineflayer bot) for the Paper 1.21.4 server on Proxmox CT105 (mc-paper).

- The bot lives in the same container as the server and joins `127.0.0.1:25565` (offline mode + whitelist, username `Muze`).
- First-person viewer (prismarine-viewer) is served on port 3007, so the owner can watch Muze's view live from a browser on the LAN: `http://192.168.0.12:3007`

## Run (inside CT105)

```bash
npm ci
./start-ct.sh          # manual run
# or install the systemd unit (muze-bot.service) for autostart
```

Env: `MC_HOST` `MC_PORT` `MC_USER` `MC_PROXY` `VIEWER_PORT` `AUTOSOLO=1`
