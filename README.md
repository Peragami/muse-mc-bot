# muse-mc-bot

Muze (Mineflayer bot) for the Paper 1.21.4 server on Proxmox CT105 (mc-paper).

- The bot lives in the same container as the server and joins `127.0.0.1:25565` (offline mode + whitelist, username `Muze`).
- First-person viewer (prismarine-viewer) is served on port 3007, so the owner can watch Muze's view live from a browser on the LAN: `http://192.168.0.12:3007`
- Dashboard (inventory + view + hotbar + status on one page) is served by the bot itself on port 3008: `http://192.168.0.12:3008` (state JSON at `/api/state`)

## Run (inside CT105)

```bash
npm ci
./start-ct.sh          # manual run
# or install the systemd unit (muze-bot.service) for autostart
```

Env: `MC_HOST` `MC_PORT` `MC_USER` `MC_PROXY` `VIEWER_PORT` `AUTOSOLO=1`

## Code layout (modularized 2026-11-23)

`bot.js` is a slim entry point. Everything lives in `lib/` around a shared
context object (`ctx`): `context.js` creates the bot and the shared state
(`ctx.S`), settings and memory; each feature module is a factory
`(ctx) => { ... }` that attaches its functions to `ctx`, so cross-module
calls look like `ctx.craftItem(...)` and shared flags like `S.desiredState`.

- `lib/consts.js` — constants (hostiles, food order, JP name maps) + env config
- `lib/context.js` — bot creation, plugin loading, state machine, helpers, settings.json / memory.json
- `lib/world.js` — movement (gotoWatched), gathering, mining, block placement
- `lib/craft.js` — craftItem, charcoal smelting, wooden sword after mob deaths
- `lib/home.js` — base building, go-home, chest storage (deposit/withdraw), memory report
- `lib/missions.js` — guard, fishing, sleep, solo / pickaxe / sword / armor missions
- `lib/life.js` — auto behaviors (eat/fight/pickup/hunt/equip), night survival, death & respawn
- `lib/dashboard.js` — prismarine viewer + state API / dashboard server (dashboard.html stays at repo root)
- `lib/chat.js` — chat command router

Note: `settings.json`, `memory.json` and `dashboard.html` live at the repo
root; modules resolve them with `path.join(__dirname, '..', ...)`.
