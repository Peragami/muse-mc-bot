const http = require('http');
const { URL } = require('url');
const shared = require('./shared');
module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { VIEWER_PORT, STATE_PORT, AUTOSOLO } = ctx.C;
  shared.bodies[ctx.C.USERNAME] = { ctx, cfg: ctx.cfg };
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
    const pairPath = path.join(__dirname, '..', 'dashboard-pair.html');
    // Official Java-edition item textures, bundled with prismarine-viewer
    // (user request 2026-11-23: use the real textures on the dashboard).
    const TEX_ROOT = (() => { try { const base = path.join(__dirname, '..', 'node_modules', 'prismarine-viewer', 'public', 'textures'); const vers = fs.readdirSync(base).filter(v => /^1\.\d+\.\d+$/.test(v)).sort(); return path.join(base, vers.includes('1.21.4') ? '1.21.4' : vers[vers.length - 1]); } catch { return null; } })();
    const TEX_ALIAS = { grass_block: 'grass_block_side', crafting_table: 'crafting_table_front', furnace: 'furnace_front', smoker: 'smoker_front', blast_furnace: 'blast_furnace_front' };
    const texFileFor = (name) => {
      if (!TEX_ROOT) return null;
      const cands = [`items/${name}.png`, `blocks/${name}.png`];
      if (TEX_ALIAS[name]) cands.push(`blocks/${TEX_ALIAS[name]}.png`);
      if (name.endsWith('_bed')) cands.push(`entity/bed/${name.replace('_bed', '')}.png`);
      if (name === 'chest') cands.push('entity/chest/normal.png');
      if (name === 'ender_chest') cands.push('entity/chest/ender.png');
      for (const c of cands) { const f = path.join(TEX_ROOT, c); if (fs.existsSync(f)) return f; }
      return null;
    };
    const srv = http.createServer((req, res) => {
      const texMatch = req.url.match(/^\/textures\/([a-z0-9_]+)\.png$/);
      if (texMatch) {
        const f = texFileFor(texMatch[1]);
        if (!f) { res.writeHead(404); res.end('no texture'); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(f).pipe(res);
        return;
      }
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
      } else if (req.url.startsWith('/api/block') && req.method === 'GET') {
        // Read-only block probe (debugging aid, 2026-11-24): what THIS
        // body's client sees at a cell. The server-console say-probes
        // proved unreliable for bulk scans (paste mangling under load
        // misattributed results); this answers in one clean response.
        try {
          const q = new URL(req.url, 'http://localhost').searchParams;
          const { Vec3 } = require('vec3');
          const b = bot.blockAt(new Vec3(parseInt(q.get('x')), parseInt(q.get('y')), parseInt(q.get('z'))));
          let props = null;
          if (b) { try { props = b.getProperties(); } catch { props = null; } }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(b ? { name: b.name, props } : { name: null }));
        } catch (e) { res.writeHead(400); res.end('bad request'); }
      } else if (req.url === '/api/state/all') {
        // Pair dashboard feed: every registered body + shared settings.
        const names = Object.keys(shared.bodies).sort((a, b) => (shared.bodies[b].cfg.primary ? 1 : 0) - (shared.bodies[a].cfg.primary ? 1 : 0));
        const bodies = names.map(n => { try { return { ...shared.bodies[n].ctx.botState(), viewerPort: shared.bodies[n].cfg.viewerPort, callName: shared.bodies[n].cfg.callName }; } catch (e) { return { username: n, online: false }; } });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ bodies, settings }));
      } else if (req.url === '/' || req.url === '/dashboard.html') {
        fs.readFile(pairPath, (err, buf) => {
          if (err) { // pair page missing -> fall back to the single-body page
            fs.readFile(dashPath, (err2, buf2) => { if (err2) { res.writeHead(404); res.end('dashboard not found'); return; } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf2); });
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buf);
        });
      } else if (req.url === '/single') {
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
            const j = JSON.parse(body);
            const cmd = (j.message || '').toString().slice(0, 100);
            if (!cmd) { res.writeHead(400); res.end('empty'); return; }
            // Pair dashboard commands name their target body; without a
            // username the command addresses this server's own body.
            const target = (j.username && shared.bodies[j.username]) ? shared.bodies[j.username].ctx.bot : bot;
            console.log(`[dashboard] command -> ${target.username}: ${cmd}`);
            if (cmd.startsWith('/')) { try { target.chat(cmd); } catch {} res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true })); return; }
            target.emit('chat', 'Dashboard', cmd);
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
