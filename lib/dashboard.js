const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const shared = require('./shared');
// ---- prismarine-viewer entity fixes (user report 2026-11-25) ----
// The bundled viewer has three entity-rendering defects:
//  1. trader_llama is missing from its entity definitions, so a
//     wandering trader's llama falls back to a magenta box.
//  2. Mobs whose textures only exist as variants (llama, villager,
//     horse, cat, ...) have no 'default' texture, and the viewer
//     silently skips meshes without one — those mobs are invisible.
//  3. Zombie/husk geometry uses the classic 64x32 UV layout while
//     the bundled 1.16.4 textures are 64x64, scrambling the skin.
//     Cropped 64x32 copies live in viewer-patches/ (repo root).
// Fixes are applied to node_modules at startup (source JSON + the
// prebuilt web bundle + texture files) so they survive restarts;
// a reinstall is healed on the next boot. Failures only log.
// Extract a single-quoted JS string literal starting at `from`
// (just past the opening quote); returns { value, end } with end at
// the closing quote, or null.
function extractJsString (str, from) {
  let out = '';
  let i = from;
  while (i < str.length) {
    const c = str[i];
    if (c === '\\') {
      const n = str[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'v') out += '\v';
      else if (n === '0') out += '\0';
      else if (n === 'u') { out += String.fromCharCode(parseInt(str.substr(i + 2, 4), 16)); i += 4; }
      else out += n;
      i += 2;
      continue;
    }
    if (c === "'") return { value: out, end: i };
    out += c;
    i++;
  }
  return null;
}
// Find the entities dataset embedded in the viewer bundle (a
// JSON.parse('...') literal), apply the same normalization as the
// source JSON, and splice it back. Returns the new bundle text,
// 'already' when nothing needed changing, or null when the dataset
// was not found / verification failed (bundle left untouched).
function patchBundleEntities (bundle, data) {
  const BS = String.fromCharCode(92);
  const marker = "JSON.parse('";
  let searchFrom = 0;
  while (true) {
    const at = bundle.indexOf(marker, searchFrom);
    if (at < 0) return null;
    const contentStart = at + marker.length;
    const lit = extractJsString(bundle, contentStart);
    if (!lit) return null;
    let obj = null;
    try { obj = JSON.parse(lit.value); } catch (e) { /* not this one */ }
    if (obj && obj.llama && obj.llama.geometry && Object.keys(obj).length > 50) {
      let changed = false;
      for (const e of Object.values(obj)) {
        if (e && e.geometry && e.geometry.default && e.textures && !e.textures.default) {
          const first = Object.values(e.textures)[0];
          if (first) { e.textures.default = first; changed = true; }
        }
      }
      if (!obj.trader_llama && obj.llama) {
        obj.trader_llama = { identifier: 'minecraft:trader_llama', textures: { default: 'textures/entity/llama/creamy' }, geometry: obj.llama.geometry };
        changed = true;
      }
      if (!changed) return 'already';
      const escaped = JSON.stringify(obj).split(BS).join(BS + BS).split("'").join(BS + "'").split('"').join(BS + '"');
      const out = bundle.slice(0, contentStart) + escaped + bundle.slice(lit.end);
      // verify before anyone writes this: re-extract and re-parse
      const check = extractJsString(out, contentStart);
      if (!check) return null;
      try {
        const verify = JSON.parse(check.value);
        if (!verify.trader_llama || !verify.llama.textures.default) return null;
      } catch (e) { return null; }
      return out;
    }
    searchFrom = contentStart;
  }
}
let viewerPatched = false;
function applyViewerPatches () {
  if (viewerPatched) return;
  viewerPatched = true;
  try {
    const root = path.join(__dirname, '..');
    const pv = path.join(root, 'node_modules', 'prismarine-viewer');
    const notes = [];
    // (1)+(2): entity definitions — normalize the source JSON first
    const srcPath = path.join(pv, 'viewer', 'lib', 'entity', 'entities.json');
    const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    const defaults = {};
    let srcChanged = false;
    for (const [name, e] of Object.entries(data)) {
      if (e && e.geometry && e.geometry.default && e.textures) {
        if (!e.textures.default) {
          const first = Object.values(e.textures)[0];
          if (first) { e.textures.default = first; srcChanged = true; }
        }
        if (e.textures.default) defaults[name] = e.textures.default;
      }
    }
    if (!data.trader_llama && data.llama) {
      data.trader_llama = { textures: { default: 'textures/entity/llama/creamy' }, geometry: data.llama.geometry };
      srcChanged = true;
    }
    if (srcChanged) {
      fs.writeFileSync(srcPath, JSON.stringify(data));
      notes.push(`source json: default textures + trader_llama (${Object.keys(defaults).length} mobs)`);
    }
    // Sync the same fixes into the prebuilt bundle the browser loads.
    // Webpack embeds entities.json as a JSON.parse('...') string
    // literal. Instead of text surgery (escape-fragile), extract that
    // literal, transform the parsed data, and splice it back — with a
    // re-parse of the result before anything is written.
    const BS = String.fromCharCode(92);
    const bundlePath = path.join(pv, 'public', 'index.js');
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    const patchedBundle = patchBundleEntities(bundle, data);
    if (patchedBundle === 'already') notes.push('bundle: already patched');
    else if (patchedBundle) { fs.writeFileSync(bundlePath, patchedBundle); notes.push('bundle: entities rewritten with fixes'); }
    else notes.push('bundle: entities dataset not found, skipped');
    // (3): cropped 64x32 textures for the classic-layout mobs
    const patchTexRoot = path.join(root, 'viewer-patches', 'textures');
    const texFiles = ['1.16.4/entity/zombie/zombie.png', '1.16.4/entity/zombie/husk.png'];
    for (const rel of texFiles) {
      const src = path.join(patchTexRoot, rel);
      const dst = path.join(pv, 'public', 'textures', rel);
      try {
        if (fs.existsSync(src) && (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst)))) {
          fs.copyFileSync(src, dst);
          notes.push(`texture placed: ${rel}`);
        }
      } catch (e) { /* one bad file must not stop the others */ }
    }
    // (4): chests are block entities in vanilla, so in the viewer's
    // prebuilt block data (blocksStates/<ver>.json + the atlas PNG
    // it references) their models have no elements and they render
    // as nothing. Paint chest sprites (viewer-patches/sprites/) into
    // unused atlas tiles and author a box model pointing at them.
    // Front faces +z: the home double chest faces south, into the
    // room. Tiles are chosen deterministically (scan from the atlas
    // end for fully transparent, unreferenced tiles).
    try {
      const ver = '1.21.4';
      const TILE = 0.015625; // one 16px tile of the 1024px atlas
      const statesPath = path.join(pv, 'public', 'blocksStates', ver + '.json');
      const states = JSON.parse(fs.readFileSync(statesPath, 'utf8'));
      const chestKeys = ['chest', 'trapped_chest', 'ender_chest'];
      const needsModel = (k) => { const e = states[k] && states[k].variants && states[k].variants['']; return !!(e && e.model && !(e.model.elements && e.model.elements.length)); };
      if (chestKeys.some(needsModel)) {
        const { createCanvas, Image } = require('canvas');
        const atlasPath = path.join(pv, 'public', 'textures', ver + '.png');
        const atlasImg = new Image();
        atlasImg.src = fs.readFileSync(atlasPath);
        const cv = createCanvas(atlasImg.width, atlasImg.height);
        const g = cv.getContext('2d');
        g.drawImage(atlasImg, 0, 0);
        const usedTiles = new Set();
        (function walk (o) {
          if (!o || typeof o !== 'object') return;
          if (typeof o.u === 'number' && typeof o.su === 'number' && typeof o.v === 'number') usedTiles.add(Math.round(o.u * 64) + ',' + Math.round(o.v * 64));
          for (const v of Object.values(o)) walk(v);
        })(states);
        const imgData = g.getImageData(0, 0, cv.width, cv.height).data;
        const tileFree = (col, row) => {
          if (usedTiles.has(col + ',' + row)) return false;
          for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            if (imgData[((row * 16 + y) * cv.width + col * 16 + x) * 4 + 3] !== 0) return false;
          }
          return true;
        };
        const picks = [];
        for (let idx = 64 * 64 - 1; idx >= 0 && picks.length < chestKeys.length * 3; idx--) {
          const col = idx % 64; const row = Math.floor(idx / 64);
          if (tileFree(col, row)) picks.push({ col, row });
        }
        if (picks.length >= chestKeys.length * 3) {
          const faceRect = (tile, face) => {
            const tu = tile.col / 64; const tv = tile.row / 64;
            const flip = (face === 'down' || face === 'north');
            return { u: flip ? tu + TILE : tu, v: tv, su: flip ? -TILE : TILE, sv: TILE, bu: tu + TILE / 2, bv: tv + TILE / 2 };
          };
          const texRef = (tile) => ({ u: tile.col / 64, v: tile.row / 64, su: TILE, sv: TILE });
          let p = 0;
          for (const key of chestKeys) {
            if (!needsModel(key)) continue;
            const tiles = {};
            for (const faceName of ['front', 'side', 'top']) {
              const tile = picks[p++];
              tiles[faceName] = tile;
              const spr = new Image();
              spr.src = fs.readFileSync(path.join(root, 'viewer-patches', 'sprites', `${key}_${faceName}.png`));
              g.drawImage(spr, tile.col * 16, tile.row * 16);
            }
            states[key].variants[''].model = {
              textures: { particle: texRef(tiles.side), front: texRef(tiles.front), side: texRef(tiles.side), top: texRef(tiles.top) },
              elements: [{ from: [1, 0, 1], to: [15, 15, 15], faces: {
                up: { texture: faceRect(tiles.top, 'up') },
                down: { texture: faceRect(tiles.side, 'down') },
                north: { texture: faceRect(tiles.side, 'north') },
                south: { texture: faceRect(tiles.front, 'south') },
                west: { texture: faceRect(tiles.side, 'west') },
                east: { texture: faceRect(tiles.side, 'east') }
              } }],
              ao: true
            };
          }
          fs.writeFileSync(atlasPath, cv.toBuffer());
          fs.writeFileSync(statesPath, JSON.stringify(states));
          notes.push('chest models authored + atlas painted (blocksStates 1.21.4)');
        } else notes.push('chest patch: not enough free atlas tiles');
      }
    } catch (e) { notes.push(`chest patch failed: ${e.message}`); }
    console.log(`[viewer-patch] ${notes.length ? notes.join('; ') : 'already applied'}`);
  } catch (e) {
    console.log(`[viewer-patch] FAILED (viewer continues unpatched): ${e.message}`);
  }
}
module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { VIEWER_PORT, STATE_PORT, AUTOSOLO } = ctx.C;
  shared.bodies[ctx.C.USERNAME] = { ctx, cfg: ctx.cfg };
// ---- viewer (firstPerson, only when VIEWER_PORT set) ----
ctx.startViewer = function () {
  if (!VIEWER_PORT) return;
  applyViewerPatches();
  if (process.env.SOLO_NOVIEWER === '1' && AUTOSOLO) { console.log('[viewer] skipped (SOLO_NOVIEWER=1 + AUTOSOLO: lighter solo run)'); return; }
  try {
    const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true, viewDistance: 4 });
    console.log(`[viewer] first-person viewer on http://localhost:${VIEWER_PORT}`);
  } catch (e) { console.log(`[viewer] FAILED (canvas/WebGL dependency?): ${e.message}`); }
  // Spectator camera (user request 2026-11-24, replacing the
  // MuzeCam bot): a second, orbit viewer on the SAME connection.
  // All camera control happens locally in the browser (rotate /
  // zoom / pan over the chunks this bot has loaded), so there is
  // no control lag. Verified feasible: one bot can serve two
  // viewers at once.
  if (ctx.cfg && ctx.cfg.orbitPort) {
    try {
      const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
      mineflayerViewer(bot, { port: ctx.cfg.orbitPort, firstPerson: false, viewDistance: 8 });
      console.log(`[viewer] orbit spectator viewer on http://localhost:${ctx.cfg.orbitPort}`);
    } catch (e) { console.log(`[viewer] orbit FAILED: ${e.message}`); }
  }
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
      } else if (req.url === '/api/events') {
        // Event feed for the pair dashboard (user improvement
        // 2026-11-24): the interesting lines out of the shared log
        // buffer — deaths, rescues, medic runs, fishing, cleanups —
        // so nobody has to read journalctl to know what happened.
        const tags = ['[help]', '[rescue]', '[medic]', '[drown]', '[desync]', '[fall]', '[death]', '[fish]', '[cleanup]', '[pond]', '[well]', '[scout]', '[coop]', '[fixture]', '[night]', '[watch]'];
        const events = ctx.logBuf.filter(l => tags.some(t => l.includes(t))).slice(-40);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ events }));
      } else if (req.url === '/api/state/all') {
        // Pair dashboard feed: every registered body + shared settings.
        const names = Object.keys(shared.bodies).sort((a, b) => (shared.bodies[b].cfg.primary ? 1 : 0) - (shared.bodies[a].cfg.primary ? 1 : 0));
        const bodies = names.map(n => { try { return { ...shared.bodies[n].ctx.botState(), viewerPort: shared.bodies[n].cfg.viewerPort, callName: shared.bodies[n].cfg.callName }; } catch (e) { return { username: n, online: false }; } });
        const sharedState = {
          helpReq: shared.helpReq, rescue: shared.rescue, medicReq: shared.medicReq,
          pondJob: shared.pondJob ? { by: shared.pondJob.by, remaining: Math.max(0, shared.pondJob.cells.length - shared.pondJob.next) } : null
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ bodies, settings, shared: sharedState }));
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
