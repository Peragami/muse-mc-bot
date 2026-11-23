// Muze bot v2 — Takumi's Minecraft server (Java Edition, Paper 1.21.4)
// Frameworks: mineflayer + pathfinder + statemachine (NestedStateMachine)
//   + collectblock + tool + auto-eat (v5 ESM, dynamic import) + armor-manager
//   + pvp + auto-totem + prismarine-viewer (only when VIEWER_PORT is set, firstPerson)
// Env: MC_HOST MC_PORT MC_USER MC_PROXY VIEWER_PORT AUTOSOLO=1
const http = require('http');
const net = require('net');
const { URL } = require('url');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USERNAME = process.env.MC_USER || 'Muze';
const PROXY = process.env.MC_PROXY || '';
const VIEWER_PORT = process.env.VIEWER_PORT ? parseInt(process.env.VIEWER_PORT, 10) : 0;
const AUTOSOLO = process.env.AUTOSOLO === '1';

function connectViaProxy(client) {
  // Manual HTTP CONNECT: this proxy resets Node http.request CONNECT handshakes,
  // but accepts a plain raw CONNECT (verified 2026-11-13 against the Tailscale tunnel).
  const u = new URL(PROXY);
  const headers = [`CONNECT ${HOST}:${PORT} HTTP/1.1`, `Host: ${HOST}:${PORT}`];
  if (u.username) {
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    headers.push(`Proxy-Authorization: Basic ${auth}`);
  }
  const socket = net.connect(parseInt(u.port, 10), u.hostname);
  let buf = Buffer.alloc(0);
  let done = false;
  socket.on('connect', () => socket.write(headers.join('\r\n') + '\r\n\r\n'));
  socket.on('data', (chunk) => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    done = true;
    const head = buf.slice(0, idx).toString('latin1');
    const rest = buf.slice(idx + 4);
    if (!/^HTTP\/1\.\d 200/.test(head)) { client.emit('error', new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`)); socket.destroy(); return; }
    socket.removeAllListeners('data');
    if (rest.length) socket.unshift(rest);
    client.setSocket(socket); client.emit('connect');
  });
  socket.on('error', (err) => { if (!done) client.emit('error', err); });
}

const options = { host: HOST, port: PORT, username: USERNAME, version: '1.21.4' };
if (PROXY) options.connect = connectViaProxy;
const bot = mineflayer.createBot(options);

// ---- plugin loading (each guarded) ----
function tryLoad(name, fn) { try { fn(); console.log(`[plugin] ${name} loaded`); } catch (e) { console.log(`[plugin] ${name} FAILED: ${e.message}`); } }
tryLoad('pathfinder', () => bot.loadPlugin(pathfinder));
tryLoad('collectblock', () => bot.loadPlugin(require('mineflayer-collectblock').plugin));
tryLoad('tool', () => bot.loadPlugin(require('mineflayer-tool').plugin));
tryLoad('pvp', () => bot.loadPlugin(require('mineflayer-pvp').plugin));
tryLoad('armor-manager', () => bot.loadPlugin(require('mineflayer-armor-manager')));
let autototemOk = false;
tryLoad('auto-totem', () => { bot.loadPlugin(require('mineflayer-auto-totem').autototem); autototemOk = true; });

// auto-eat v5: ESM only -> dynamic import, handle new + old API gracefully
async function loadAutoEat() {
  try {
    const mod = await import('mineflayer-auto-eat');
    const loader = mod.loader || mod.default || mod.plugin;
    if (typeof loader === 'function') bot.loadPlugin(loader);
    console.log('[plugin] auto-eat loaded (ESM)');
  } catch (e) {
    try { const old = require('mineflayer-auto-eat'); bot.loadPlugin(old.default || old); console.log('[plugin] auto-eat loaded (CJS fallback)'); }
    catch (e2) { console.log(`[plugin] auto-eat FAILED: ${e.message} / ${e2.message}`); }
  }
  try {
    if (bot.autoEat) {
      if (typeof bot.autoEat.setOpts === 'function') bot.autoEat.setOpts({ minHunger: 14, minHealth: 10, bannedFood: ['rotten_flesh','pufferfish','poisonous_potato','spider_eye'] });
      if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto();        // v5/v6 API
      else if ('disabled' in bot.autoEat) bot.autoEat.disabled = false;                    // old API
      else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable();
      console.log('[auto-eat] auto enabled');
    }
  } catch (e) { console.log('[auto-eat] enable failed:', e.message); }
}
loadAutoEat();

// ---- state ----
let desiredState = 'idle'; // idle | follow | come | busy
let guardMode = false, guardTargetName = null, guardTimer = null;
let fishingMode = false, soloMode = false, soloAbort = false;
let deathPos = null;
const targets = {};

// ---- state machine (NestedStateMachine) ----
let stateMachine = null;
function setupStateMachine() {
  try {
    const sm = require('mineflayer-statemachine');
    const idle = new sm.BehaviorIdle();
    const follow = new sm.BehaviorFollowEntity(bot, targets); follow.followDistance = 2;
    const moveTo = new sm.BehaviorMoveTo(bot, targets); moveTo.distance = 1;
    const transitions = [
      new sm.StateTransition({ parent: idle, child: follow, shouldTransition: () => desiredState === 'follow' && !!targets.entity }),
      new sm.StateTransition({ parent: follow, child: idle, shouldTransition: () => desiredState !== 'follow' }),
      new sm.StateTransition({ parent: idle, child: moveTo, shouldTransition: () => desiredState === 'come' && !!targets.position }),
      new sm.StateTransition({ parent: moveTo, child: idle, shouldTransition: () => desiredState !== 'come' || (moveTo.isFinished && moveTo.isFinished()) , onTransition: () => { if (desiredState === 'come') desiredState = 'idle'; } }),
      new sm.StateTransition({ parent: follow, child: moveTo, shouldTransition: () => desiredState === 'come' && !!targets.position }),
      new sm.StateTransition({ parent: moveTo, child: follow, shouldTransition: () => desiredState === 'follow' && !!targets.entity }),
    ];
    const root = new sm.NestedStateMachine(transitions, idle);
    root.stateName = 'root';
    stateMachine = new sm.BotStateMachine(bot, root);
    console.log('[statemachine] NestedStateMachine started (idle/follow/come)');
  } catch (e) { console.log('[statemachine] FAILED (fallback to direct pathfinder):', e.message); stateMachine = null; }
}

// ---- helpers ----
// Chat throttle: Paper kicks for chat spam when many bot.chat() calls fire in the
// same second (hit this in the solo demo). Queue messages, flush ~1 per 1.15s.
const chatQueue = [];
setInterval(() => { const m = chatQueue.shift(); if (m !== undefined) { try { bot.chat(m); } catch {} } }, 1150);
function say(msg) { console.log(`[chat-out] ${msg}`); chatQueue.push(msg); }
function fail(prefix, e) { console.log(`[error] ${prefix}: ${e && e.message || e}`); say(`${prefix}: ${(e && e.message || e).toString().slice(0, 80)}`); }
const LOG_TYPES = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];
const PLANK_OF = { oak_log:'oak_planks', birch_log:'birch_planks', spruce_log:'spruce_planks', jungle_log:'jungle_planks', acacia_log:'acacia_planks', dark_oak_log:'dark_oak_planks', mangrove_log:'mangrove_planks', cherry_log:'cherry_planks' };
const HOSTILES = new Set(['zombie','skeleton','creeper','spider','enderman','witch','pillager','vindicator','drowned','husk','stray','phantom','slime','magma_cube','blaze','ghast','piglin','hoglin','ravager','vex','evoker','guardian','elder_guardian','shulker','silverfish','endermite','cave_spider','zombie_villager','zombified_piglin','piglin_brute','warden','bogged','breeze']);
function countItem(name) { return bot.inventory ? bot.inventory.items().filter(i => i.name === name).reduce((a,i)=>a+i.count,0) : 0; }
function invList() { return bot.inventory ? bot.inventory.items().map(i => `${i.name} x${i.count}`) : []; }
function findBlocks(names, maxDist = 32, count = 20) {
  try { const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined); if (!ids.length) return []; return bot.findBlocks({ matching: ids, maxDistance: maxDist, count }); } catch { return []; }
}
function stopAll(reason = 'とまった') {
  soloAbort = true; fishingMode = false; guardMode = false;
  if (guardTimer) { clearInterval(guardTimer); guardTimer = null; }
  desiredState = 'idle'; targets.entity = null;
  try { bot.pathfinder.setGoal(null); } catch {}
  try { if (bot.pvp) { if (bot.pvp.forceStop) bot.pvp.forceStop(); else if (bot.pvp.stop) bot.pvp.stop(); } } catch {}
  try { if (bot.collectBlock) bot.collectBlock.cancelTask().catch(()=>{}); } catch {}
  try { bot.clearControlStates(); } catch {}
  console.log('[stopAll]', reason); say(reason);
}
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms / 1000}s`)), ms))]);
}
// If a hostile is close, fight back with the best tool in hand before continuing.
// Night deaths during long steps were the top mission-abort cause.
async function checkDanger() {
  const hostile = nearestHostile(7);
  if (!hostile) return;
  const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_pickaxe')) || bot.inventory.items().find(i => i.name.endsWith('_axe'));
  if (weapon) { try { await bot.equip(weapon, 'hand'); } catch {} }
  console.log(`[defense] fighting ${hostile.name} at ${bot.entity.position.distanceTo(hostile.position).toFixed(1)}m`);
  try { await withTimeout(bot.pvp.attack(hostile), 30000, 'defense'); } catch (e) { console.log('[defense]', e.message); }
}

async function collectByNames(names, count, label, maxDist = 32) {
  const positions = findBlocks(names, maxDist, Math.max(count * 2, count));
  if (!positions.length) { say(`${label}が近くに見つからない`); return 0; }
  const blocks = positions.map(p => bot.blockAt(p)).filter(Boolean).slice(0, count);
  desiredState = 'busy'; say(`${label}を${blocks.length}個掘るね`);
  // Long pathfinding during collect can grow memory/CPU unbounded; cap each collect call.
  try { await withTimeout(bot.collectBlock.collect(blocks), 90000, label); }
  catch (e) { console.log(`[collect] ${label}: ${e.message} (partial progress may remain in inventory)`); try { await bot.collectBlock.cancelTask(); } catch {} }
  finally { if (desiredState === 'busy') desiredState = 'idle'; }
  return blocks.length;
}
// Manual stone mining. Do NOT use collectblock for stone: its vein flood-fill treats
// all connected underground stone as one vein and OOM'd the bot repeatedly in testing.
// Instead: pick single surface-exposed stone blocks, walk up, dig one by one.
async function excavateForStone() {
  // Dig a small hole next to the bot (through dirt) until stone is exposed.
  const base = bot.entity.position.floored();
  for (let depth = 0; depth < 7; depth++) {
    const b = bot.blockAt(base.offset(2, -depth, 0));
    if (!b || b.name === 'air') continue;
    if (b.name === 'stone') return true;
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2)), 30000, 'excavate goto');
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      await withTimeout(bot.dig(b), 30000, 'excavate dig');
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.log('[stone] excavate:', e.message); return false; }
  }
  return false;
}
async function mineStoneManual(count = 3) {
  let dug = 0;
  for (let i = 0; i < count; i++) {
    // Stone directly underfoot (after excavating down): dig it and drop in.
    // Widen the shaft right after falling in: dig one feet-level neighbour too,
    // so the bot is never trapped in a 1-wide hole (placement/movement broke there).
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (below && below.name === 'stone') {
      try { const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand'); await withTimeout(bot.dig(below), 45000, 'dig below'); dug++; await new Promise(r => setTimeout(r, 700));
        try { const base = bot.entity.position.floored(); for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) { const side = bot.blockAt(base.offset(dx, 0, dz)); if (side && side.name !== 'air') { await withTimeout(bot.dig(side), 30000, 'widen shaft'); break; } } } catch {}
        continue; }
      catch (e) { console.log('[stone] dig below failed:', e.message); }
    }
    const positions = findBlocks(['stone'], 16, 30);
    let target = null;
    for (const p of positions) {
      const b = bot.blockAt(p); if (!b) continue;
      const exposed = [[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => { const n = bot.blockAt(p.offset(x,y,z)); return n && (n.name === 'air' || n.name === 'cave_air'); });
      if (exposed) { target = b; break; }
    }
    if (!target) { console.log('[stone] no exposed stone nearby, excavating'); if (await excavateForStone()) continue; break; }
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2)), 45000, 'stone goto');
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe'));
      if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      else if (bot.tool) { try { await bot.tool.equipForBlock(target); } catch {} }
      const fresh = bot.blockAt(target.position);
      if (fresh && fresh.name === 'stone') { await withTimeout(bot.dig(fresh), 45000, 'dig'); dug++; await new Promise(r => setTimeout(r, 700)); }
    } catch (e) { console.log('[stone] dig failed:', e.message); break; }
    if (soloAbort) break;
  }
  return dug;
}
// Place an inventory block on top of a solid neighbour cell whose top is air.
async function placeItemOnGround(itemName) {
  const { Vec3 } = require('vec3');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error(`${itemName}を持っていない`);
  await bot.equip(item, 'hand');
  const base = bot.entity.position.floored();
  const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dandelion', 'poppy', 'oxeye_daisy', 'azure_bluet', 'dead_bush', 'seagrass', 'tall_seagrass']);
  const offsets = [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2],[1,1],[-1,-1],[1,-1],[-1,1],[3,0],[-3,0],[0,3],[0,-3],[2,2],[-2,-2],[2,-2],[-2,2]];
  for (const dy of [0, -1, 1, -2]) {
    for (const [dx, dz] of offsets) {
      const ground = bot.blockAt(base.offset(dx, dy - 1, dz));
      if (!ground || ground.boundingBox !== 'block') continue;
      const cell = bot.blockAt(base.offset(dx, dy, dz));
      if (!cell || !REPLACEABLE.has(cell.name)) continue;
      // A refused placeBlock on one marginal cell used to abort the whole
      // placement (live 2026-11-23 pickaxe run). Catch, verify, move on.
      try {
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        await new Promise(r => setTimeout(r, 400));
        const placed = bot.blockAt(base.offset(dx, dy, dz));
        if (placed && placed.name === itemName) return true;
        console.log(`[place] ${itemName} at ${dx},${dy},${dz} did not stick (${placed ? placed.name : '?'}), trying next cell`);
      } catch (e) { console.log(`[place] placeBlock refused at ${dx},${dy},${dz}: ${e.message}; trying next cell`); }
    }
  }
  // Fallback: dig out a spot. In a 1-wide dug shaft every neighbour cell is stone,
  // so no natural spot exists (hit live 2026-11-13: bot trapped at y=54 in its own
  // stone-mining shaft). Dig one feet-level neighbour whose below-block is solid.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const below = bot.blockAt(base.offset(dx, -1, dz));
    const cell = bot.blockAt(base.offset(dx, 0, dz));
    if (!below || below.boundingBox !== 'block' || !cell) continue;
    if (!['stone', 'dirt', 'gravel', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'grass_block', 'coarse_dirt'].includes(cell.name)) continue;
    try {
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand');
      await withTimeout(bot.dig(cell), 30000, 'dig place spot');
      await new Promise(r => setTimeout(r, 500));
      const fresh = bot.blockAt(base.offset(dx, 0, dz));
      if (fresh && REPLACEABLE.has(fresh.name)) { await bot.placeBlock(below, new Vec3(0, 1, 0)); return true; }
    } catch (e) { console.log('[place] dig-out fallback:', e.message); }
  }
  // diagnostics: dump surroundings so placement failures are debuggable from the log
  try {
    const names = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { const b = bot.blockAt(base.offset(dx, dy, dz)); names.push(`${dx},${dy},${dz}=${b ? b.name : '?'}`); }
    console.log(`[place] no spot near ${base}: ${names.join(' ')}`);
  } catch {}
  throw new Error('置ける場所（固い地面＋上の空き）が近くにない');
}
function nearestHostile(range = 16) {
  if (!bot.entity) return null;
  let best = null, bd = range;
  for (const e of Object.values(bot.entities)) { if (!e || e === bot.entity || !e.position) continue; if (!HOSTILES.has(e.name)) continue; const d = bot.entity.position.distanceTo(e.position); if (d < bd) { bd = d; best = e; } }
  return best;
}
async function attackEntity(ent) { if (!ent) { say('近くに敵がいない'); return; } desiredState = 'busy'; say(`${ent.name || ent.displayName || '敵'}とたたかう`); try { await bot.pvp.attack(ent); } catch(e) { console.log('[pvp]', e.message); } finally { if (desiredState === 'busy') desiredState = 'idle'; } }

// ---- guard mode ----
function startGuard(username) {
  guardMode = true; guardTargetName = username; say(`${username}を護衛するね`);
  if (guardTimer) clearInterval(guardTimer);
  guardTimer = setInterval(async () => {
    if (!guardMode) return;
    try {
      const hostile = nearestHostile(16);
      if (hostile && (!bot.pvp || !bot.pvp.target)) { console.log('[guard] hostile', hostile.name); await attackEntity(hostile); return; }
      const player = bot.players[guardTargetName]?.entity;
      if (player && bot.entity && bot.entity.position.distanceTo(player.position) > 4) {
        targets.entity = player; // return near player via pathfinder directly (avoid fighting statemachine)
        try { bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true); } catch {}
        setTimeout(() => { if (guardMode && !nearestHostile(16)) { try { bot.pathfinder.setGoal(null); } catch {} } }, 4000);
      }
    } catch (e) { console.log('[guard] tick:', e.message); }
  }, 3000);
}

// ---- fishing ----
async function fishLoop() {
  const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
  if (!rod) { say('釣り竿を持ってない'); return; }
  fishingMode = true; say('釣りをはじめる。「とまれ」でやめるよ');
  try { await bot.equip(rod, 'hand'); } catch(e) { fail('竿の装備に失敗', e); return; }
  while (fishingMode) {
    try { await bot.fish(); if (fishingMode) console.log('[fish] caught / retry'); } catch (e) { console.log('[fish]', e.message); if (!fishingMode) break; await new Promise(r => setTimeout(r, 1000)); }
  }
  console.log('[fish] stopped');
}

// ---- craft helper ----
const JP_CRAFT = { '木のツルハシ':'wooden_pickaxe','石のツルハシ':'stone_pickaxe','作業台':'crafting_table','棒':'stick','松明':'torch','つるはし':'wooden_pickaxe','ツルハシ':'wooden_pickaxe' };
function findCraftingTable() { const pos = findBlocks(['crafting_table'], 16, 1); return pos.length ? bot.blockAt(pos[0]) : null; }
async function craftItem(itemName, count = 1) {
  const item = bot.registry.itemsByName[itemName];
  if (!item) { say(`${itemName} というアイテムが分からない`); return false; }
  let table = findCraftingTable();
  // Walk up to the table first: crafting against a table left behind in a shaft
  // silently fails when it is more than a few blocks away.
  if (table && bot.entity && bot.entity.position.distanceTo(table.position) > 3) {
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2)), 30000, 'goto table'); table = findCraftingTable() || table; } catch (e) {
      console.log('[craft] goto table:', e.message);
      // Recovery: an unreachable table (across a shaft, another level) must not sink
      // the craft. Place the carried table right here, or craft a fresh one (2x2 recipe).
      try {
        if (countItem('crafting_table') > 0) { await placeItemOnGround('crafting_table'); }
        else {
          const plankItem = bot.inventory.items().find(i => i.name.endsWith('_planks') && i.count >= 4);
          if (plankItem) { const rs = bot.recipesFor(bot.registry.itemsByName['crafting_table'].id, null, 1, null) || []; if (rs.length) { await bot.craft(rs[0], 1); await new Promise(r => setTimeout(r, 800)); if (countItem('crafting_table') > 0) await placeItemOnGround('crafting_table'); } }
        }
        table = findCraftingTable() || table;
        console.log(`[craft] table recovery: now ${table ? 'have table' : 'still none'}`);
      } catch (e2) { console.log('[craft] table recovery failed:', e2.message); }
    }
  }
  let recipes = [];
  // Inventory sync can lag several seconds on a slow server right after collecting/crafting;
  // poll a while before concluding ingredients are missing (run5 failed stick/table this way).
  for (let i = 0; i < 12; i++) {
    try { recipes = bot.recipesFor(item.id, null, 1, table) || []; } catch {}
    if (recipes.length) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!recipes.length && !table) {
    // try placing a crafting table from inventory
    const ct = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (ct) {
      try { await placeItemOnGround('crafting_table'); await new Promise(r=>setTimeout(r,500)); table = findCraftingTable(); if (table) recipes = bot.recipesFor(item.id, null, 1, table) || []; }
      catch (e) { console.log('[craft] place table failed:', e.message); }
    }
  }
  if (!recipes.length) {
    // Fallback: recipesFor's delta check can reject recipes we actually have materials for
    // (e.g. ingredients split across stacks). If recipesAll knows the recipe, try crafting it anyway.
    try {
      const all = bot.recipesAll ? bot.recipesAll(item.id, null, table) : [];
      if (all && all.length) {
        console.log(`[craft] ${itemName}: recipesFor empty, trying recipesAll fallback`);
        const before = countItem(itemName);
        await bot.craft(all[0], count, table || undefined);
        for (let i = 0; i < 8 && countItem(itemName) <= before; i++) await new Promise(r => setTimeout(r, 1000));
        if (countItem(itemName) > before) { say(`${itemName}を作った`); return true; }
        say(`${itemName}: 素材が足りないみたい`); return false;
      }
      say(`${itemName}: レシピが見つからない（作業台が要るかも）`);
    } catch (e) { console.log(`[craft] ${itemName} fallback failed: ${e.message}`); say(`${itemName}: 素材不足か作業台不足`); }
    return false;
  }
  const beforeCount = countItem(itemName);
  try {
    // 'missing ingredient' can fire spuriously while inventory is still syncing; retry a few times.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await bot.craft(recipes[0], count, table || undefined); lastErr = null; break; }
      catch (e) { lastErr = e; console.log(`[craft] ${itemName} attempt ${attempt + 1} failed: ${e.message}`); await new Promise(r => setTimeout(r, 2000)); const rs = bot.recipesFor(item.id, null, 1, table) || []; if (rs.length) recipes = rs; }
    }
    if (lastErr) throw lastErr;
    for (let i = 0; i < 10 && countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
    // Verify the item actually arrived; a "successful" bot.craft under lag can produce nothing
    // (wooden_pickaxe in run10: craft returned, inventory unchanged). Retry the craft itself.
    for (let retry = 0; retry < 2 && countItem(itemName) <= beforeCount; retry++) {
      // The first craft's product can land AFTER the verify window above; re-poll
      // briefly before spending ingredients on a duplicate (live 2026-11-23: a lagged
      // crafting_table craft produced 2 tables and starved the pickaxe of planks).
      for (let i = 0; i < 5 && countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
      if (countItem(itemName) > beforeCount) break;
      console.log(`[craft] ${itemName}: no item after craft, retry ${retry + 1}`);
      const t2 = findCraftingTable() || table; const rs = bot.recipesFor(item.id, null, 1, t2) || recipes;
      try { await bot.craft(rs[0], count, t2 || undefined); } catch (e) { console.log(`[craft] ${itemName} retry failed: ${e.message}`); }
      for (let i = 0; i < 8 && countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
    }
    if (countItem(itemName) <= beforeCount) {
      // Final settle attempt: pause, refresh table + recipes, one last craft.
      // Silent no-op crafts on this slow CT cleared after a pause in the
      // 2026-11-23 pickaxe run once the mission retried from the outside.
      console.log(`[craft] ${itemName}: final settle attempt`);
      await new Promise(r => setTimeout(r, 5000));
      const t3 = findCraftingTable() || table; const rs3 = bot.recipesFor(item.id, null, 1, t3) || [];
      if (rs3.length) { try { await bot.craft(rs3[0], count, t3 || undefined); } catch (e) { console.log(`[craft] ${itemName} final attempt failed: ${e.message}`); } }
      for (let i = 0; i < 8 && countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`[craft] ${itemName}: ${beforeCount} -> ${countItem(itemName)}`);
    if (countItem(itemName) <= beforeCount) return false;
    say(`${itemName}を作った`); return true; }
  catch (e) { fail(`${itemName}のクラフト失敗`, e); return false; }
}

// ---- sleep ----
async function goSleep() {
  const bedNames = Object.keys(bot.registry.blocksByName).filter(n => n.endsWith('_bed'));
  const pos = findBlocks(bedNames, 32, 1);
  if (!pos.length) { say('近くにベッドが見つからない'); return; }
  const bed = bot.blockAt(pos[0]);
  try { desiredState = 'busy'; await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)); await bot.sleep(bed); say('寝たよ。おやすみ'); }
  catch (e) { fail('寝れなかった', e); } finally { if (desiredState === 'busy') desiredState = 'idle'; }
}

// ---- chest / give ----
const DEPOSIT_KEEP = (name) => /(_pickaxe|_axe|_sword|_shovel|_hoe)$/.test(name) || name === 'fishing_rod';
function isFood(name) { try { const f = bot.registry.foodsByName; return !!(f && f[name]); } catch { return false; } }
async function depositToChest() {
  const pos = findBlocks(['chest','trapped_chest'], 32, 1);
  if (!pos.length) { say('近くにチェストが見つからない'); return; }
  try {
    desiredState = 'busy';
    const chestBlock = bot.blockAt(pos[0]);
    await bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));
    const chest = await bot.openContainer(chestBlock);
    let n = 0;
    for (const item of [...bot.inventory.items()]) {
      if (DEPOSIT_KEEP(item.name) || isFood(item.name)) continue;
      try { await chest.deposit(item.type, null, item.count); n += item.count; } catch (e) { console.log('[deposit]', item.name, e.message); }
    }
    try { chest.close(); } catch {}
    say(n ? `素材を${n}個預けた` : '預けるものがなかった（食料とツールは手元に残す）');
  } catch (e) { fail('預けられなかった', e); } finally { if (desiredState === 'busy') desiredState = 'idle'; }
}
const JP_ITEMS = { '木':'oak_log','原木':'oak_log','板材':'oak_planks','石':'cobblestone','鉄':'iron_ingot','棒':'stick','作業台':'crafting_table','松明':'torch','パン':'bread' };
async function giveItem(username, query) {
  const name = JP_ITEMS[query] || query;
  const item = bot.inventory.items().find(i => i.name === name) || bot.inventory.items().find(i => i.name.includes(name));
  if (!item) { say(`${query}は持ってない`); return; }
  const player = bot.players[username]?.entity;
  try {
    if (player) { desiredState = 'busy'; await bot.pathfinder.goto(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2)); }
    await bot.tossStack(item); say(`${item.name}を渡した`);
  } catch (e) { fail('渡せなかった', e); } finally { if (desiredState === 'busy') desiredState = 'idle'; }
}

// ---- solo survival ----
async function soloSurvival() {
  if (soloMode) { say('もうソロで動いてるよ'); return; }
  soloMode = true; soloAbort = false; nightMode = false;
  const started = Date.now(); const LIMIT = 8 * 60 * 1000;
  const step = async (label, fn) => {
    if (soloAbort) throw new Error('stopped');
    if (Date.now() - started > LIMIT) throw new Error('timeout');
    say(label); console.log(`[solo] ${label}`);
    try { await fn(); console.log(`[solo] OK: ${label}`); return true; } catch (e) { console.log(`[solo] FAIL: ${label}: ${e.message}`); say(`スキップ: ${label}（${e.message.slice(0,60)}）`); return false; }
  };
  try {
    say('一人でサバイバルをはじめるよ');
    await step('木を探して原木を掘る', async () => {
      const countLogs = () => bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((a,i)=>a+i.count,0);
      await collectByNames(LOG_TYPES, 3, '原木');
      // Spawn surroundings vary per run; if no tree was reachable, relocate and retry.
      for (const [dx, dz] of [[20,0],[-20,10],[10,-20],[-15,-15]]) {
        if (countLogs() > 0 || soloAbort) break;
        console.log(`[solo] no logs yet, relocating by (${dx},${dz}) and retrying`);
        try { const p = bot.entity.position; await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)), 45000, 'relocate'); } catch (e) { console.log('[solo] relocate:', e.message); }
        await collectByNames(LOG_TYPES, 3, '原木');
      }
      if (!countLogs()) throw new Error('原木が1個も集まらなかった');
      console.log(`[solo] logs in inventory: ${countLogs()}`);
    });
    await step('原木を板材にする', async () => {
      const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
      if (!log) throw new Error('原木がない'); const plank = PLANK_OF[log.name];
      // Craft planks ONE log at a time: a multi-craft under lag desynced the grid and
      // produced a birch_button from a lone plank in testing. 1 craft = 1 log -> 4 planks.
      const nLogs = countItem(log.name);
      for (let i = 0; i < nLogs; i++) { if (!await craftItem(plank, 1)) { if (countItem(plank) >= 4) break; throw new Error('板材クラフト失敗'); } }
    });
    // Crafting table BEFORE sticks: recipesFor(crafting_table) rejected the recipe when planks
    // were split into uneven stacks after the stick craft (10 planks in 3 stacks, run9).
    await step('作業台を作る', async () => { if (countItem('crafting_table') === 0 && !await craftItem('crafting_table', 1)) throw new Error('作業台クラフト失敗'); });
    await step('棒を作る', async () => { if (!await craftItem('stick', 1)) throw new Error('棒クラフト失敗'); });
    await step('作業台を置く', async () => {
      // A table placed earlier may already stand nearby; check before demanding one in inventory.
      if (findCraftingTable()) return;
      // inventory sync can lag right after crafting; re-check a few times
      for (let i = 0; i < 3 && !bot.inventory.items().some(it => it.name === 'crafting_table'); i++) await new Promise(r => setTimeout(r, 1000));
      if (!bot.inventory.items().some(i => i.name === 'crafting_table')) throw new Error('作業台がない');
      if (findCraftingTable()) return;
      await placeItemOnGround('crafting_table');
    });
    await step('木のツルハシを作る', async () => { if (countItem('wooden_pickaxe') === 0 && !await craftItem('wooden_pickaxe', 1)) throw new Error('木ピッケル失敗'); });
    await step('石を掘る', async () => {
      const pick = bot.inventory.items().find(i => i.name.endsWith('_pickaxe')); if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      // Manual mining only (see mineStoneManual: collectblock vein-fill OOMs on stone).
      say('石を手掘りするね（露出した石を1個ずつ）');
      await mineStoneManual(3);
      if (countItem('cobblestone') < 3) throw new Error(`丸石が${countItem('cobblestone')}個しか集まらなかった`);
    });
    await step('石のツルハシを作る', async () => { if (countItem('stone_pickaxe') === 0 && !await craftItem('stone_pickaxe', 1)) throw new Error('石ピッケル失敗（丸石が足りない等）'); });
  } catch (e) { console.log('[solo] aborted:', e.message); say(`ソロ中断: ${e.message}`); }
  finally {
    soloMode = false;
    const inv = invList().join(', ') || 'なし';
    console.log(`[solo] finished inventory: ${inv}`); say(`ソロ終了。今の持ち物: ${inv.slice(0, 180)}`);
  }
}

// ---- wooden pickaxe mission (solo's opening chain, stops at the pickaxe) ----
let pickaxeMode = false;
async function pickaxeMission() {
  if (pickaxeMode) { say('もうツルハシを作ってる途中だよ'); return; }
  if (countItem('wooden_pickaxe') > 0) { say('木のツルハシはもう持ってるよ'); const p = bot.inventory.items().find(i => i.name === 'wooden_pickaxe'); try { await bot.equip(p, 'hand'); } catch {} return; }
  pickaxeMode = true; soloAbort = false; nightMode = false;
  const started = Date.now(); const LIMIT = 6 * 60 * 1000;
  const step = async (label, fn) => {
    if (soloAbort) throw new Error('stopped');
    if (Date.now() - started > LIMIT) throw new Error('timeout');
    say(label); console.log(`[pickaxe] ${label}`);
    await fn(); console.log(`[pickaxe] OK: ${label}`);
  };
  try {
    say('木のツルハシを作るね');
    await step('木を探して原木を掘る', async () => {
      const countLogs = () => bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((a, i) => a + i.count, 0);
      // 5 logs, not 3: on this slow CT a lagged craft can double-craft the table
      // (observed live: 2 tables ate 8 planks and the pickaxe starved at 2 planks).
      // Settle first: right after a (re)spawn the surrounding chunks are still
      // loading and findBlocks sees nothing (live 2026-11-23: 0 logs in 4 tries).
      await new Promise(r => setTimeout(r, 5000));
      await collectByNames(LOG_TYPES, 5, '原木');
      for (const [dx, dz] of [[20, 0], [-20, 10], [10, -20], [-15, -15], [45, 0], [-45, 20], [0, 45], [0, -45]]) {
        if (countLogs() > 0 || soloAbort) break;
        console.log(`[pickaxe] no logs yet, relocating by (${dx},${dz}) and retrying`);
        try { const p = bot.entity.position; await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)), 45000, 'relocate'); } catch (e) { console.log('[pickaxe] relocate:', e.message); }
        await collectByNames(LOG_TYPES, 5, '原木');
      }
      if (!countLogs()) throw new Error('原木が1個も集まらなかった');
    });
    await step('原木を板材にする', async () => {
      const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
      if (!log) throw new Error('原木がない'); const plank = PLANK_OF[log.name];
      const nLogs = countItem(log.name);
      for (let i = 0; i < nLogs; i++) { if (!await craftItem(plank, 1)) { if (countItem(plank) >= 4) break; throw new Error('板材クラフト失敗'); } }
    });
    await step('作業台を作る', async () => { if (countItem('crafting_table') === 0 && !findCraftingTable() && !await craftItem('crafting_table', 1)) throw new Error('作業台クラフト失敗'); });
    await step('棒を作る', async () => { if (countItem('stick') < 2 && !await craftItem('stick', 1)) throw new Error('棒クラフト失敗'); });
    await step('作業台を置く', async () => {
      // A table placed by an earlier run may already stand nearby; check that
      // BEFORE demanding a carried one (the inventory guard used to throw first).
      if (findCraftingTable()) return;
      for (let i = 0; i < 3 && !bot.inventory.items().some(it => it.name === 'crafting_table'); i++) await new Promise(r => setTimeout(r, 1000));
      if (!bot.inventory.items().some(i => i.name === 'crafting_table')) throw new Error('作業台がない');
      if (findCraftingTable()) return;
      // placeBlock can be refused on a marginal cell and placeItemOnGround gives
      // up on the first refusal; retry from slightly different stances.
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await placeItemOnGround('crafting_table'); } catch (e) { lastErr = e; console.log(`[pickaxe] place attempt ${attempt + 1} failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 800));
        if (findCraftingTable()) return;
        try { const p = bot.entity.position; await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + 2 - attempt, p.y, p.z + 1 + attempt, 1)), 20000, 'place shuffle'); } catch {}
      }
      if (lastErr) throw lastErr;
      throw new Error('作業台を置けなかった');
    });
    await step('木のツルハシを作る', async () => {
      if (countItem('wooden_pickaxe') > 0) return;
      // Top planks back up to >=3 before the pickaxe craft: convert leftover logs,
      // or go gather 2 more logs (the table double-craft can starve this step).
      const countPlanks = () => bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
      for (let round = 0; round < 2 && countPlanks() < 3; round++) {
        const lg = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
        if (lg) { await craftItem(PLANK_OF[lg.name], 1); }
        else {
          await collectByNames(LOG_TYPES, 2, '原木');
          const lg2 = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
          if (lg2) await craftItem(PLANK_OF[lg2.name], 1);
        }
      }
      if (countPlanks() < 3) throw new Error('板材が3枚に届かない');
      // On this slow CT a craft can silently no-op even with recipes + materials
      // (craftItem's own retries included). Outer retries with a settle pause and
      // a small stance shuffle clear the desync often enough.
      let crafted = false;
      for (let attempt = 0; attempt < 3 && !crafted; attempt++) {
        if (attempt > 0) {
          console.log(`[pickaxe] pickaxe craft outer retry ${attempt}`);
          await new Promise(r => setTimeout(r, 5000));
          try { const t = findCraftingTable(); if (t) await withTimeout(bot.pathfinder.goto(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 1)), 20000, 'back to table'); } catch {}
        }
        crafted = await craftItem('wooden_pickaxe', 1);
      }
      if (!crafted) throw new Error('木ピッケル失敗');
    });
    const pick = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
    if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
    say('木のツルハシ、完成！');
    console.log('[pickaxe] MISSION COMPLETE');
  } catch (e) { console.log('[pickaxe] aborted:', e.message); say(`ツルハシ作り中断: ${e.message}`); }
  finally {
    pickaxeMode = false;
    const inv = invList().join(', ') || 'なし';
    console.log(`[pickaxe] finished inventory: ${inv}`); say(`今の持ち物: ${inv.slice(0, 170)}`);
  }
}

// ---- iron sword mission (think-and-do: full chain from empty inventory) ----
// Chain: logs -> planks/table/sticks -> wooden pick -> cobble x11 -> stone pick +
// furnace -> dig down scanning for iron ore -> mine raw iron -> smelt -> iron sword.
// Death aborts a run (soloAbort); the mission retries from the current inventory
// state a few times, since every step checks counts before acting.
let swordMode = false;
async function digDownScanIron(maxDepth = 44) {
  // Dig straight down (block below, like the proven solo stone method) and rescan
  // for iron ore at each level. findBlocks reads loaded chunk data, so buried ore
  // shows up within range before we reach it.
  for (let d = 0; d < maxDepth; d++) {
    if (soloAbort) return false;
    if (findBlocks(['iron_ore', 'deepslate_iron_ore'], 32, 3).length) return true;
    const y = Math.floor(bot.entity.position.y);
    if (y <= 14) break;
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.name === 'air' || below.name === 'bedrock') break;
    if (below.name === 'water' || below.name === 'lava') break;
    try {
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand');
      await withTimeout(bot.dig(below), 30000, 'dig down');
      await new Promise(r => setTimeout(r, 600));
    } catch (e) { console.log('[sword] dig down:', e.message); break; }
  }
  return findBlocks(['iron_ore', 'deepslate_iron_ore'], 32, 3).length > 0;
}
// Manual iron mining. Do NOT use collectblock for buried ore: reaching it makes
// collectblock flood-fill/search huge connected stone regions and OOM-killed the
// bot live (2026-11-13 run5). Instead walk/dig to scanned ore with bounded
// pathfinder goals and dig adjacent ore blocks one by one with the stone pick.
async function mineIronManual(need = 3) {
  for (let round = 0; round < 14 && countItem('raw_iron') < need && !soloAbort; round++) {
    const poses = findBlocks(['iron_ore', 'deepslate_iron_ore'], 24, 6);
    if (!poses.length) {
      // Nothing scanned nearby: sink a few levels (rescan happens each level inside)
      const found = await digDownScanIron(5);
      if (!found && Math.floor(bot.entity.position.y) <= 14) {
        // At iron depth already: tunnel horizontally a few blocks and rescan.
        const base = bot.entity.position.floored();
        let advanced = false;
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const feet = bot.blockAt(base.offset(dx, 0, dz)); const head = bot.blockAt(base.offset(dx, 1, dz)); const floorB = bot.blockAt(base.offset(dx, -1, dz));
          if (!feet || !head || !floorB || floorB.boundingBox !== 'block') continue;
          try {
            const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand');
            if (feet.name !== 'air') await withTimeout(bot.dig(feet), 30000, 'tunnel feet');
            const head2 = bot.blockAt(base.offset(dx, 1, dz)); if (head2 && head2.name !== 'air') await withTimeout(bot.dig(head2), 30000, 'tunnel head');
            await withTimeout(bot.pathfinder.goto(new goals.GoalNear(base.x + dx, base.y, base.z + dz, 0)), 20000, 'tunnel step');
            advanced = true; break;
          } catch (e) { console.log('[iron] tunnel:', e.message); }
        }
        if (!advanced) break;
      }
      continue;
    }
    const ore = bot.blockAt(poses[0]);
    if (!ore) continue;
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2)), 60000, 'iron goto'); } catch (e) { console.log('[iron] goto:', e.message); }
    // Dig every ore block now adjacent (vein), with the stone pick equipped.
    for (let k = 0; k < 8; k++) {
      const near = findBlocks(['iron_ore', 'deepslate_iron_ore'], 4, 8).map(p => bot.blockAt(p)).filter(Boolean);
      if (!near.length) break;
      const pick = bot.inventory.items().find(i => i.name === 'stone_pickaxe') || bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
      if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      try { await withTimeout(bot.dig(near[0]), 30000, 'dig iron'); } catch (e) { console.log('[iron] dig:', e.message); break; }
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 500));
    console.log(`[iron] raw_iron so far: ${countItem('raw_iron')}`);
  }
  return countItem('raw_iron');
}
async function smeltRawIron() {
  const raw = countItem('raw_iron');
  if (!raw) throw new Error('鉄鉱石（raw_iron）がない');
  let fpos = findBlocks(['furnace'], 16, 1);
  if (!fpos.length) {
    if (countItem('furnace') === 0 && !await craftItem('furnace', 1)) throw new Error('かまどが作れない（丸石8個）');
    await placeItemOnGround('furnace');
    await new Promise(r => setTimeout(r, 600));
    fpos = findBlocks(['furnace'], 16, 1);
    if (!fpos.length) throw new Error('かまどを置けたか確認できない');
  }
  const fblock = bot.blockAt(fpos[0]);
  await withTimeout(bot.pathfinder.goto(new goals.GoalNear(fblock.position.x, fblock.position.y, fblock.position.z, 2)), 45000, 'furnace goto');
  const furnace = await bot.openFurnace(fblock);
  try {
    const fuelItem = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal')
      || bot.inventory.items().find(i => i.name.endsWith('_planks'))
      || bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
    if (!fuelItem) throw new Error('燃料（石炭/板材/原木）がない');
    const fuelCount = fuelItem.name === 'coal' || fuelItem.name === 'charcoal' ? 1 : Math.min(fuelItem.count, Math.max(2, raw));
    await furnace.putFuel(fuelItem.type, null, fuelCount);
    const rawItem = bot.registry.itemsByName['raw_iron'];
    await furnace.putInput(rawItem.id, null, raw);
    say(`精錬中…（鉄鉱石${raw}個）`);
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      if (soloAbort) throw new Error('stopped');
      const out = furnace.outputItem();
      if (out && out.count >= 2) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    const out = furnace.outputItem();
    if (out) { await furnace.takeOutput(); console.log(`[sword] smelted output: ${out.name} x${out.count}`); }
  } finally { try { furnace.close(); } catch {} }
  for (let i = 0; i < 10 && countItem('iron_ingot') < 2; i++) await new Promise(r => setTimeout(r, 1000));
  if (countItem('iron_ingot') < 2) throw new Error(`鉄インゴットが${countItem('iron_ingot')}個しかない`);
}
async function swordMission() {
  if (swordMode) { say('もう鉄の剣を作ってる途中だよ'); return; }
  swordMode = true; nightMode = false;
  const started = Date.now(); const LIMIT = 25 * 60 * 1000;
  const step = async (label, fn) => {
    if (soloAbort) throw new Error('stopped');
    if (Date.now() - started > LIMIT) throw new Error('timeout');
    await checkDanger().catch(() => {});
    say(label); console.log(`[sword] ${label}`);
    try { await fn(); console.log(`[sword] OK: ${label}`); return true; } catch (e) { console.log(`[sword] FAIL: ${label}: ${e.message}`); say(`スキップ: ${label}（${e.message.slice(0, 60)}）`); return false; }
  };
  try {
    say('鉄の剣を一から作るよ。考えながら進めるね');
    for (let attempt = 1; attempt <= 3 && countItem('iron_sword') === 0; attempt++) {
      if (attempt > 1) { say(`再挑戦 ${attempt}回目（死んだ場所の近くに落ちた物は諦めて集め直す）`); await new Promise(r => setTimeout(r, 3000)); }
      soloAbort = false;
      const countLogs = () => bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((a, i) => a + i.count, 0);
      await step('原木を集める（目標7個）', async () => {
        // Skip when downstream progress already covers the wood budget (restarts
        // used to re-collect 7 logs even with a full stack of planks in hand).
        const plankTotal = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
        if (countItem('stone_pickaxe') > 0 || countItem('wooden_pickaxe') > 0 || plankTotal + countLogs() * 4 >= 16) { console.log(`[sword] wood already sufficient (planks ${plankTotal}, logs ${countLogs()})`); return; }
        if (countLogs() >= 7) return;
        await collectByNames(LOG_TYPES, 7 - countLogs(), '原木');
        for (const [dx, dz] of [[20, 0], [-20, 10], [10, -20]]) {
          if (countLogs() >= 4 || soloAbort) break;
          try { const p = bot.entity.position; await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)), 45000, 'relocate'); } catch {}
          await collectByNames(LOG_TYPES, 7 - countLogs(), '原木');
        }
        if (!countLogs()) throw new Error('原木が集まらなかった');
      });
      await step('板材にする', async () => {
        const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
        if (countItem('crafting_table') > 0 || bot.inventory.items().some(i => i.name.endsWith('_planks') && i.count >= 9)) return;
        if (!log) { if (bot.inventory.items().some(i => i.name.endsWith('_planks'))) return; throw new Error('原木も板材もない'); }
        const plank = PLANK_OF[log.name]; const n = countItem(log.name);
        for (let i = 0; i < n; i++) { if (!await craftItem(plank, 1) && i >= 2) break; }
        if (countItem(plank) < 4) throw new Error('板材が足りない');
      });
      await step('作業台を作って置く', async () => {
        if (countItem('crafting_table') === 0 && !findCraftingTable()) { if (!await craftItem('crafting_table', 1)) throw new Error('作業台クラフト失敗'); }
        if (!findCraftingTable() && countItem('crafting_table') > 0) await placeItemOnGround('crafting_table');
      });
      await step('棒を作る', async () => { if (countItem('stick') < 2 && !await craftItem('stick', 1)) throw new Error('棒クラフト失敗'); });
      await step('木のツルハシを作る', async () => { if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe')) && !await craftItem('wooden_pickaxe', 1)) throw new Error('木のツルハシ失敗'); });
      await step('丸石を11個集める', async () => {
        for (let r = 0; r < 4 && countItem('cobblestone') < 11 && !soloAbort; r++) await mineStoneManual(11 - countItem('cobblestone'));
        if (countItem('cobblestone') < 11) throw new Error(`丸石${countItem('cobblestone')}個どまり`);
      });
      await step('石のツルハシを作る', async () => { if (countItem('stone_pickaxe') === 0 && !await craftItem('stone_pickaxe', 1)) throw new Error('石のツルハシ失敗'); });
      await step('かまどを作る', async () => { if (countItem('furnace') === 0 && !findBlocks(['furnace'], 16, 1).length && !await craftItem('furnace', 1)) throw new Error('かまど失敗（丸石8個）'); });
      await step('鉄鉱石を探して掘る', async () => {
        if (countItem('raw_iron') >= 2 || countItem('iron_ingot') >= 2) return;
        // Hard gate: iron ore drops nothing with a wooden pick. If the stone pick
        // step failed earlier, redo cobble + stone pick right here instead of
        // wasting the run digging ore that cannot drop.
        if (countItem('stone_pickaxe') === 0) {
          say('石のツルハシがないので、先に作り直すね');
          for (let r = 0; r < 3 && countItem('cobblestone') < 3 && !soloAbort; r++) await mineStoneManual(3 - countItem('cobblestone'));
          if (countItem('stick') < 2) await craftItem('stick', 1);
          if (!await craftItem('stone_pickaxe', 1)) throw new Error('石のツルハシが作れず、鉄掘りに入れない');
        }
        const pick = bot.inventory.items().find(i => i.name === 'stone_pickaxe');
        if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
        await mineIronManual(3);
        if (countItem('raw_iron') < 2) throw new Error(`鉄鉱石が${countItem('raw_iron')}個しか見つからなかった`);
      });
      await step('鉄を精錬する', async () => { if (countItem('iron_ingot') < 2) await smeltRawIron(); });
      await step('鉄の剣を作る', async () => {
        if (countItem('stick') < 1) await craftItem('stick', 1);
        if (!await craftItem('iron_sword', 1)) throw new Error('鉄の剣クラフト失敗');
      });
      if (soloAbort) console.log(`[sword] attempt ${attempt} died/aborted`);
    }
    if (countItem('iron_sword') > 0) {
      const sw = bot.inventory.items().find(i => i.name === 'iron_sword');
      try { await bot.equip(sw, 'hand'); } catch {}
      say('鉄の剣、完成！ 手に持ったよ');
      console.log('[sword] MISSION COMPLETE: iron_sword');
    } else {
      say('鉄の剣まで届かなかった…。今の到達点はログに残したよ');
      console.log('[sword] MISSION INCOMPLETE');
    }
  } catch (e) { console.log('[sword] aborted:', e.message); say(`鉄の剣ミッション中断: ${e.message}`); }
  finally {
    swordMode = false;
    const inv = invList().join(', ') || 'なし';
    console.log(`[sword] finished inventory: ${inv}`); say(`今の持ち物: ${inv.slice(0, 170)}`);
  }
}

// ---- iron armor mission (next mission, chosen by Muze 2026-11-13) ----
// Goal: iron pickaxe + full iron armor, equipped. Works in batches:
// mine ~10 raw iron -> smelt -> craft what's affordable (pick first) -> repeat.
// Total ingots needed: pick 3 + helmet 5 + chestplate 8 + leggings 7 + boots 4 = 27.
let armorMode = false;
const ARMOR_PLAN = [
  ['iron_pickaxe', 3], ['iron_chestplate', 8], ['iron_leggings', 7], ['iron_helmet', 5], ['iron_boots', 4],
];
async function armorMission() {
  if (armorMode || swordMode) { say('別のミッション中だよ'); return; }
  armorMode = true; nightMode = false;
  const started = Date.now(); const LIMIT = 60 * 60 * 1000;
  const missing = () => ARMOR_PLAN.filter(([name]) => countItem(name) === 0);
  const ingotsNeeded = () => missing().reduce((a, [, cost]) => a + cost, 0);
  try {
    say('次のミッションは鉄装備一式＋鉄のツルハシにするね。掘って・精錬して・作るを繰り返すよ');
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!missing().length) break;
      if (Date.now() - started > LIMIT) { say('時間切れで中断'); break; }
      soloAbort = false;
      // Ensure a stone pickaxe exists as the mining tool until the iron one is ready.
      if (countItem('stone_pickaxe') === 0 && countItem('iron_pickaxe') === 0) {
        for (let r = 0; r < 3 && countItem('cobblestone') < 3 && !soloAbort; r++) await mineStoneManual(3 - countItem('cobblestone'));
        if (countItem('stick') < 2) await craftItem('stick', 1);
        await craftItem('stone_pickaxe', 1);
      }
      for (let cycle = 0; cycle < 8 && missing().length && !soloAbort; cycle++) {
        if (Date.now() - started > LIMIT) break;
        await checkDanger().catch(() => {});
        const have = countItem('iron_ingot') + countItem('raw_iron');
        const need = ingotsNeeded() - have;
        console.log(`[armor] cycle ${cycle}: missing=${missing().map(m => m[0]).join(',')} ingots=${countItem('iron_ingot')} raw=${countItem('raw_iron')} need=${need}`);
        if (need > 0) {
          say(`鉄あと${need}個分を掘りに行くね`);
          const target = countItem('raw_iron') + Math.min(need, 12);
          for (let t = 0; t < 3 && countItem('raw_iron') < target && !soloAbort; t++) await mineIronManual(target);
        }
        if (countItem('raw_iron') > 0) { say('精錬するね'); try { await smeltRawIron(); } catch (e) { console.log('[armor] smelt:', e.message); say(`精錬で詰まった: ${e.message.slice(0, 60)}`); } }
        // Craft in plan order with whatever ingots are on hand.
        for (const [name, cost] of ARMOR_PLAN) {
          if (countItem(name) > 0) continue;
          if (countItem('iron_ingot') < cost) continue;
          if (name === 'iron_pickaxe' && countItem('stick') < 1) await craftItem('stick', 1);
          say(`${name}を作るね`);
          await craftItem(name, 1);
        }
        if (soloAbort) break;
      }
      if (soloAbort) console.log(`[armor] attempt ${attempt} died/aborted`);
    }
    const done = ARMOR_PLAN.filter(([n]) => countItem(n) > 0).map(([n]) => n);
    const left = missing().map(([n]) => n);
    try { if (bot.armorManager?.equipAll) await bot.armorManager.equipAll(); } catch {}
    if (countItem('iron_pickaxe') > 0) { const p = bot.inventory.items().find(i => i.name === 'iron_pickaxe'); try { await bot.equip(p, 'hand'); } catch {} }
    if (!left.length) { say('鉄装備一式＋鉄のツルハシ、完成！'); console.log('[armor] MISSION COMPLETE'); }
    else { say(`到達点: ${done.join(', ') || 'なし'}／残り: ${left.join(', ')}`); console.log(`[armor] MISSION INCOMPLETE: done=${done} left=${left}`); }
  } catch (e) { console.log('[armor] aborted:', e.message); say(`鉄装備ミッション中断: ${e.message}`); }
  finally {
    armorMode = false;
    const inv = invList().join(', ') || 'なし';
    console.log(`[armor] finished inventory: ${inv}`); say(`今の持ち物: ${inv.slice(0, 170)}`);
  }
}

// ---- viewer (firstPerson, only when VIEWER_PORT set) ----
function startViewer() {
  if (!VIEWER_PORT) return;
  if (process.env.SOLO_NOVIEWER === '1' && AUTOSOLO) { console.log('[viewer] skipped (SOLO_NOVIEWER=1 + AUTOSOLO: lighter solo run)'); return; }
  try {
    const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true, viewDistance: 4 });
    console.log(`[viewer] first-person viewer on http://localhost:${VIEWER_PORT}`);
  } catch (e) { console.log(`[viewer] FAILED (canvas/WebGL dependency?): ${e.message}`); }
}

// ---- state API + dashboard (only when STATE_PORT set) ----
const STATE_PORT = process.env.STATE_PORT ? parseInt(process.env.STATE_PORT, 10) : 0;
let stateServerStarted = false;
function itemJson(it) { return it ? { name: it.name, displayName: it.displayName, count: it.count } : null; }
function botState() {
  const slots = (bot.inventory && bot.inventory.slots) || [];
  const at = (i) => itemJson(slots[i]);
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
    online: !!bot.entity
  };
}
function startStateServer() {
  if (!STATE_PORT || stateServerStarted) return;
  stateServerStarted = true;
  try {
    const fs = require('fs');
    const path = require('path');
    const dashPath = path.join(__dirname, 'dashboard.html');
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(botState()));
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

// ---- lifecycle ----
bot.once('spawn', () => {
  try { bot.pathfinder.setMovements(new Movements(bot)); } catch {}
  setupStateMachine(); startViewer(); startStateServer();
  say('むぜ、来たよ');
  console.log(`spawned as ${USERNAME} at ${bot.entity.position}`);
  // auto-totem: try plugin, fall back to manual off-hand equip
  const totemTick = async () => { try { if (autototemOk && bot.autototem?.equip) bot.autototem.equip(); else { const off = bot.inventory.slots[45]; if (!off && bot.health <= 10) { const t = bot.inventory.items().find(i => i.name === 'totem_of_undying'); if (t) await bot.equip(t, 'off-hand'); } } } catch {} };
  bot.on('physicsTick', totemTick);
  setTimeout(() => { try { bot.armorManager?.equipAll(); } catch {} }, 2000);
  if (deathPos) say(`前に死んだ場所は ${Math.floor(deathPos.x)}, ${Math.floor(deathPos.y)}, ${Math.floor(deathPos.z)}。「もどって」で戻るよ`);
  if (AUTOSOLO) setTimeout(() => soloSurvival(), 3000);
  if (process.env.AUTO_SWORD === '1') setTimeout(() => swordMission(), 4000);
  if (process.env.AUTO_ARMOR === '1') setTimeout(() => armorMission(), 4000);
});
bot.on('death', () => { try { deathPos = bot.entity.position.clone(); console.log(`[death] at ${deathPos}`); } catch {} soloAbort = true; fishingMode = false; guardMode = false; deathTimes.push(Date.now()); deathTimes = deathTimes.filter(t => Date.now() - t < 3 * 60 * 1000); if (deathTimes.length >= 3) console.log(`[death] loop detected: ${deathTimes.length} deaths in 3 min`); });

// ---- night survival + death-loop protection ----
// Incident 2026-11-23: after finishing a mission at dusk the bot idled in the
// open, got mobbed at world spawn, and died 5+ times in a row (respawn -> slain
// by shade-sheltering zombies). Standing still at night is what kills it, so
// at night an idle bot keeps moving (zombies cannot catch a walking bot) and
// fights back at point blank. A death-loop breaker forces this mode on.
let nightMode = false;
let deathTimes = [];
let firstSpawnSeen = false;
function anyMissionActive() { return soloMode || pickaxeMode || swordMode || armorMode || fishingMode || guardMode; }
async function nightSurvival() {
  if (nightMode) return;
  nightMode = true;
  console.log('[night] survival mode start');
  say('夜は危ないから動き回ってやり過ごすね');
  try {
    while (nightMode && bot.time && !bot.time.isDay) {
      const h = nearestHostile(4);
      if (h) {
        // Bound the fight: pvp.attack never resolves when the hostile is
        // unreachable (e.g. a zombie under the bot's hill/tree), and the first
        // live night run froze on exactly that — no movement, no logs.
        try { await withTimeout(bot.pvp.attack(h), 6000, 'night fight'); } catch (e) { console.log(`[night] fight gave up: ${e.message}`); }
        // Whether it died or not, move on: wandering away is the escape.
      }
      if (!bot.entity) break;
      const p = bot.entity.position;
      const ang = Math.random() * Math.PI * 2;
      const dist = 14 + Math.random() * 10;
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + Math.cos(ang) * dist, p.y, p.z + Math.sin(ang) * dist, 2)), 20000, 'night wander'); } catch (e) { console.log(`[night] wander failed: ${e.message}`); }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) { console.log('[night] survival error:', e.message); }
  finally { nightMode = false; console.log('[night] survival mode end'); }
}
// Respawn handling: first spawn is set up by the once('spawn') handler above.
bot.on('spawn', () => {
  if (!firstSpawnSeen) { firstSpawnSeen = true; return; }
  console.log('[spawn] respawned');
  setTimeout(async () => {
    try {
      if (!bot.entity || !bot.time) return;
      if (!bot.time.isDay) { nightSurvival(); return; }
      // Daytime: walk back to the death spot to recover dropped items (5 min
      // despawn) when nothing hostile is around.
      if (deathPos && !nearestHostile(12)) {
        const dp = deathPos; deathPos = null;
        say('落としたものを回収しに行くね');
        try {
          await withTimeout(bot.pathfinder.goto(new goals.GoalNear(dp.x, dp.y, dp.z, 1)), 60000, 'recover drops');
          await new Promise(r => setTimeout(r, 3000));
          console.log('[spawn] drop recovery walk done');
          say('回収できたはず。今の持ち物を確認してね');
        } catch (e) { console.log('[spawn] drop recovery failed:', e.message); }
      }
    } catch (e) { console.log('[spawn] respawn handler:', e.message); }
  }, 1500);
});
// Watchdog: an idle bot must never sit in the open at night, and repeated
// deaths force survival mode even mid-evening.
setInterval(() => {
  try {
    if (!bot.entity || !bot.time || nightMode) return;
    const looped = deathTimes.length >= 3;
    if (!bot.time.isDay && (looped || !anyMissionActive())) { console.log(`[night] watchdog engaging survival (looped=${looped})`); nightSurvival(); }
  } catch {}
}, 20000);
bot.on('kicked', (r) => console.log('kicked:', r));
bot.on('error', (e) => console.log('error:', e.message));
bot.on('end', (r) => console.log('disconnected:', r));

const HELP = ['ヘルプ: ついてきて/こっちきて/とまれ/木切って/石掘って/鉄掘って/たたかって/まもって/装備して/食べて/もちもの/寝て/釣って/◯◯作って/もどって/預けて/木ちょうだい/一人でサバイバル'];

// ---- chat commands ----
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  console.log(`<${username}> ${message}`);
  const msg = message.trim();
  try {
    if (msg.includes('とまれ') || msg === 'stop') { stopAll(); return; }
    if (msg.includes('ヘルプ') || msg === 'help') { HELP.forEach(h => say(h)); return; }
    if (msg.includes('一人でサバイバル') || msg.includes('ソロでやって')) { soloSurvival(); return; }
    if (msg.includes('鉄の剣')) { swordMission(); return; }
    if (msg.includes('鉄装備')) { armorMission(); return; }
    if (msg.includes('まもって') || msg.includes('護衛して')) { startGuard(username); return; }
    if (msg === '寝て' || msg === 'ねて' || msg.includes('寝て')) { goSleep(); return; }
    if (msg.includes('釣って') || msg === 'つり' || msg.includes('釣りして')) { fishLoop(); return; }
    if (msg.includes('もどって')) {
      if (!deathPos) { say('死んだ場所の記録がない'); return; }
      desiredState = 'busy'; say('死んだ場所へ戻るね');
      try { await bot.pathfinder.goto(new goals.GoalNear(deathPos.x, deathPos.y, deathPos.z, 2)); say('着いた'); } catch (e) { fail('戻れなかった', e); } finally { if (desiredState==='busy') desiredState='idle'; } return;
    }
    if (msg.includes('預けて')) { depositToChest(); return; }
    const giveMatch = msg.match(/^(?:渡して)\s*(\S+)$/) || (msg.includes('ちょうだい') ? [null, msg.replace('ちょうだい','').trim() || '木'] : null);
    if (giveMatch) { giveItem(username, giveMatch[1]); return; }
    // wooden pickaxe: full chain from gathering (plain craftItem has no materials to work with)
    if ((msg.includes('ツルハシ') || msg.includes('ピッケル')) && msg.includes('作って') && !msg.includes('石') && !msg.includes('鉄')) { pickaxeMission(); return; }
    // craft: "<something>作って"
    const craftMatch = msg.match(/^(.+?)(?:を)?作って$/);
    if (craftMatch) { const key = craftMatch[1].trim(); const id = JP_CRAFT[key] || (/^[a-z_]+$/.test(key) ? key : null); if (id) { desiredState='busy'; try { await craftItem(id, 1); } finally { if(desiredState==='busy') desiredState='idle'; } } else say(`「${key}」の作り方は未対応。対応: 木のツルハシ/石のツルハシ/作業台/棒/松明/英語ID`); return; }
    if (msg.includes('ついてきて') || msg === 'follow') {
      const target = bot.players[username]?.entity; if (!target) { say('姿が見えない'); return; }
      targets.entity = target;
      if (stateMachine) { desiredState = 'follow'; } else { bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); }
      say('ついていく'); return;
    }
    if (msg.includes('こっちきて') || msg === 'come') {
      const target = bot.players[username]?.entity; if (!target) { say('姿が見えない'); return; }
      targets.position = target.position.clone();
      if (stateMachine) { desiredState = 'come'; } else { await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1)); }
      say('いくね'); return;
    }
    // collect counts: 木を5個 / 木 5
    const countMatch = msg.match(/(\d+)\s*(?:個)?/); const cnt = countMatch ? Math.min(parseInt(countMatch[1], 10) || 1, 64) : 1;
    if (/木切って|木を切って|原木掘って/.test(msg) || /^木\s*\d*\s*(掘って|切って)?$/.test(msg) && /掘|切/.test(msg)) { const n = await collectByNames(LOG_TYPES, cnt === 1 && !countMatch ? 1 : cnt, '原木'); say(n ? '掘れたよ' : '掘れなかった'); return; }
    if (msg.includes('石掘って')) { const before = countItem('cobblestone'); await mineStoneManual(Math.min(cnt, 11)); say(countItem('cobblestone') > before ? '掘れたよ' : '石が掘れなかった（露出した石が近くにないかも）'); return; }
    if (msg.includes('鉄掘って')) { const n = await collectByNames(['iron_ore','deepslate_iron_ore'], cnt, '鉄鉱石'); say(n ? '掘れたよ' : '掘れなかった'); return; }
    const generic = msg.match(/([a-z_]+)\s*(?:を)?掘って/) || msg.match(/掘って\s*([a-z_]+)/);
    if (generic) { const n = await collectByNames([generic[1]], cnt, generic[1]); say(n ? '掘れたよ' : '掘れなかった'); return; }
    if (msg.includes('掘って')) { say('何を掘るか教えて。例: 木切って / 石掘って / 鉄掘って / iron_ore掘って'); return; }
    if (msg.includes('たたかって') || msg.includes('攻撃')) {
      let ent = nearestHostile(16);
      if (!ent) { // nearest any non-player entity
        const es = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && e.type === 'mob'); es.sort((a,b)=>bot.entity.position.distanceTo(a.position)-bot.entity.position.distanceTo(b.position)); ent = es[0] || null; }
      await attackEntity(ent); return;
    }
    if (msg.includes('装備して')) { try { await bot.armorManager.equipAll(); say('装備した'); } catch (e) { fail('装備できなかった', e); } return; }
    if (msg.includes('食べて')) {
      try { if (bot.autoEat?.eat) await bot.autoEat.eat(); else if (bot.autoEat?.eatAt) await bot.autoEat.eatAt(); else { const food = bot.inventory.items().find(i => isFood(i.name)); if (!food) { say('食べ物を持ってない'); return; } await bot.equip(food, 'hand'); await bot.consume(); } say('食べた'); } catch (e) { fail('食べられなかった', e); } return;
    }
    if (msg.includes('もちもの') || msg === 'inventory') { const l = invList(); if (!l.length) say('何も持ってない'); else { let buf=''; for (const s of l) { if ((buf+s).length>170){ say(buf); buf=''; } buf += (buf?', ':'')+s; } if (buf) say(buf); } return; }
    const tossMatch = msg.match(/捨てて\s*(\S+)/); if (tossMatch) { const name = JP_ITEMS[tossMatch[1]] || tossMatch[1]; const it = bot.inventory.items().find(i=>i.name===name); if (!it) say('それは持ってない'); else { try { await bot.tossStack(it); say(`${name}を捨てた`);} catch(e){fail('捨てられなかった',e);} } return; }
    if (msg.includes('むぜ')) { say('なに？ ヘルプって言うとコマンド一覧出すよ'); return; }
  } catch (e) { fail('コマンド処理で失敗', e); }
});
