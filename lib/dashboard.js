const http = require('http');
const { URL } = require('url');
module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { VIEWER_PORT, STATE_PORT, AUTOSOLO } = ctx.C;
// ---- viewer (firstPerson, only when VIEWER_PORT set) ----
ctx.startViewer = function () {
  if (!VIEWER_PORT) return;
  if (process.env.SOLO_NOVIEWER === '1' && AUTOSOLO) { console.log('[viewer] skipped (SOLO_NOVIEWER=1 + AUTOSOLO: lighter solo run)'); return; }
  try {
    const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true, viewDistance: 4 });
    console.log(`[viewer] first-person viewer on http://localhost:${VIEWER_PORT}`);
  } catch (e) { console.log(`[viewer] FAILED (canvas/WebGL dependency?): ${e.message}`); }
}

// ---- state API + dashboard (only when STATE_PORT set) ----
ctx.itemJson = function (it) { return it ? { name: it.name, displayName: it.displayName, count: it.count } : null; }
ctx.botState = function () {
  const slots = (bot.inventory && bot.inventory.slots) || [];
  const at = (i) => ctx.itemJson(slots[i]);
  const pos = bot.entity ? bot.entity.position : { x: 0, y: 0, z: 0 };
  return {
    username: bot.username,
    health: bot.health, food: bot.food,
    xpLevel: bot.experience ? bot.experience.level : 0,
    xpProgress: bot.experience ? bot.experience.progress : 0,
    gameMode: bot.game ? bot.game.gameMode : '',
    dimension: bot.game ? bot.game.dimension : '',
    timeOfDay: bot.time ? bot.time.timeOfDay : 0,
    isDay: bot.time ? bot.time.isDay : true,
    position: { x: pos.x, y: pos.y, z: pos.z },
    yaw: bot.entity ? bot.entity.yaw : 0,
    pitch: bot.entity ? bot.entity.pitch : 0,
    heldSlot: bot.quickBarSlot,
    armor: { helmet: at(5), chestplate: at(6), leggings: at(7), boots: at(8) },
    offhand: at(45),
    crafting: { slots: [at(1), at(2), at(3), at(4)], result: at(0) },
    main: Array.from({ length: 27 }, (_, i) => at(9 + i)),
    hotbar: Array.from({ length: 9 }, (_, i) => at(36 + i)),
    players: Object.keys(bot.players || {}),
    online: !!bot.entity,
    activity: S.nightMode ? (S.homeWaitMode ? '🏠 拠点で待機中' : '🌙 夜間サバイバル中') : ctx.anyMissionActive() ? 'ミッション中' : (S.autoBusy && S.autoLabel ? S.autoLabel : '待機中'),
    home: settings.home || null,
    memory: { chest: memory.chest, chestContents: memory.chestContents, spots: memory.spots, bed: memory.bed, lastDeath: memory.deaths[memory.deaths.length - 1] || null },
    logs: ctx.logBuf.slice(-15)
  };
}
ctx.startStateServer = function () {
  if (!STATE_PORT || S.stateServerStarted) return;
  S.stateServerStarted = true;
  try {
    const fs = require('fs');
    const path = require('path');
    const dashPath = path.join(__dirname, '..', 'dashboard.html');
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/settings' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(settings));
      } else if (req.url === '/api/settings' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
        req.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (!(j.key in settings) || typeof j.value !== 'boolean') { res.writeHead(400); res.end('bad setting'); return; }
            settings[j.key] = j.value;
            if (j.key === 'nightSurvival' && j.value === false) S.nightMode = false;
            ctx.saveSettings();
            console.log(`[settings] ${j.key} = ${j.value}`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(settings));
          } catch (e) { res.writeHead(400); res.end('bad request'); }
        });
      } else if (req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(ctx.botState()));
      } else if (req.url === '/' || req.url === '/dashboard.html') {
        fs.readFile(dashPath, (err, buf) => {
          if (err) { res.writeHead(404); res.end('dashboard.html not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buf);
        });
      } else if (req.url === '/api/command' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
        req.on('end', () => {
          try {
            const cmd = (JSON.parse(body).message || '').toString().slice(0, 100);
            if (!cmd) { res.writeHead(400); res.end('empty'); return; }
            console.log(`[dashboard] command: ${cmd}`);
            if (cmd.startsWith('/')) { try { bot.chat(cmd); } catch {} res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true })); return; }
            bot.emit('chat', 'Dashboard', cmd);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) { res.writeHead(400); res.end('bad request'); }
        });
      } else { res.writeHead(404); res.end('not found'); }
    });
    srv.listen(STATE_PORT, () => console.log(`[state] dashboard on http://localhost:${STATE_PORT}`));
  } catch (e) { console.log(`[state] FAILED: ${e.message}`); }
}

};
