// Core factory: creates ONE bot body (its own mineflayer bot, plugins,
// state S and helpers) around shared process-wide singletons (settings,
// memory, log buffer). bot.js builds two bodies — Muze and Yume — in a
// single process so they share one brain: one settings/memory store,
// and missions can be split across bodies without inter-process
// coordination (pair setup, user request 2026-11-23).
const net = require('net');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const C0 = require('./consts');
const shared = require('./shared');
const fs2 = require('fs');
const path2 = require('path');

// ---- shared singletons ----
const SETTINGS_PATH = path2.join(__dirname, '..', 'settings.json');
const settings = { autoEat: true, autoFight: true, autoPickup: true, nightSurvival: true, autoRecover: true, autoEquip: true, autoFish: true, home: null };
function loadSettings() {
  try {
    const j = JSON.parse(fs2.readFileSync(SETTINGS_PATH, 'utf8'));
    for (const k of Object.keys(settings)) if (typeof j[k] === 'boolean') settings[k] = j[k];
    if (j.home && typeof j.home.x === 'number' && typeof j.home.y === 'number' && typeof j.home.z === 'number') settings.home = { x: j.home.x, y: j.home.y, z: j.home.z };
  } catch {}
  console.log('[settings] loaded:', JSON.stringify(settings));
}
function saveSettings() {
  try { fs2.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch (e) { console.log('[settings] save failed:', e.message); }
}
loadSettings();

const MEMORY_PATH = path2.join(__dirname, '..', 'memory.json');
const memory = { chest: null, chestContents: [], spots: {}, deaths: [], bed: null, furnace: null };
function loadMemory() {
  try {
    const j = JSON.parse(fs2.readFileSync(MEMORY_PATH, 'utf8'));
    if (j.chest && typeof j.chest.x === 'number') memory.chest = j.chest;
    if (j.bed && typeof j.bed.x === 'number') memory.bed = j.bed;
    if (j.furnace && typeof j.furnace.x === 'number') memory.furnace = j.furnace;
    if (Array.isArray(j.chestContents)) memory.chestContents = j.chestContents;
    if (j.spots && typeof j.spots === 'object') memory.spots = j.spots;
    if (Array.isArray(j.deaths)) memory.deaths = j.deaths;
    if (j.fillSpec && typeof j.fillSpec === 'object') memory.fillSpec = j.fillSpec;
  } catch {}
  console.log('[memory] loaded: chest=' + JSON.stringify(memory.chest) + ' spots=' + Object.keys(memory.spots).join(',') + ' deaths=' + memory.deaths.length);
}
function saveMemory() {
  try { fs2.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2)); } catch (e) { console.log('[memory] save failed:', e.message); }
}
loadMemory();

// ---- shared log ring buffer (both bodies write here; lines from
// module code are not body-tagged, dashboard shows the combined feed)
const logBuf = [];
{
  const _origLog = console.log.bind(console);
  console.log = (...a) => { try { logBuf.push(new Date().toISOString().slice(11, 19) + ' ' + a.map(x => typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)).join(' ')); if (logBuf.length > 80) logBuf.shift(); } catch {} _origLog(...a); };
}

function connectViaProxy(client) {
  // Manual HTTP CONNECT: this proxy resets Node http.request CONNECT handshakes,
  // but accepts a plain raw CONNECT (verified 2026-11-13 against the Tailscale tunnel).
  const { HOST, PORT, PROXY } = C0;
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

// ---- per-body factory ----
function createCtx(cfg) {
  const ctx = { C: { ...C0, USERNAME: cfg.username, VIEWER_PORT: cfg.viewerPort, STATE_PORT: cfg.statePort }, targets: {}, cfg };
  ctx.S = {
    desiredState: 'idle', guardMode: false, guardTargetName: null, guardTimer: null,
    fishingMode: false, soloMode: false, soloAbort: false, deathPos: null,
    stateMachine: null, autoLabel: '', baseMode: false, pickaxeMode: false,
    swordMode: false, armorMode: false, autoBusy: false, lastEatAt: 0, lastEquipAt: 0,
    lastHuntAt: 0, lastStockAt: 0, lastFishAt: 0, nightMode: false, homeWaitMode: false, deathTimes: [],
    lastDeathByMob: false, firstSpawnSeen: false, stateServerStarted: false, autototemOk: false, bedMode: false,
    pondMode: false, returningHome: false, assistMode: false, givingMode: false, fixtureMode: false, repairMode: false, holeMode: false,
  };
  const S = ctx.S;
  const { HOST, PORT, PROXY } = ctx.C;
  const options = { host: HOST, port: PORT, username: cfg.username, version: '1.21.4' };
  if (PROXY) options.connect = connectViaProxy;
  const bot = mineflayer.createBot(options);

  // ---- plugin loading (each guarded) ----
  function tryLoad(name, fn) { try { fn(); console.log(`[plugin] ${name} loaded (${cfg.username})`); } catch (e) { console.log(`[plugin] ${name} FAILED (${cfg.username}): ${e.message}`); } }
  tryLoad('pathfinder', () => bot.loadPlugin(pathfinder));
  tryLoad('collectblock', () => bot.loadPlugin(require('mineflayer-collectblock').plugin));
  tryLoad('tool', () => bot.loadPlugin(require('mineflayer-tool').plugin));
  tryLoad('pvp', () => bot.loadPlugin(require('mineflayer-pvp').plugin));
  tryLoad('armor-manager', () => bot.loadPlugin(require('mineflayer-armor-manager')));
  tryLoad('auto-totem', () => { bot.loadPlugin(require('mineflayer-auto-totem').autototem); S.autototemOk = true; });

  // auto-eat v5: ESM only -> dynamic import, handle new + old API gracefully
  async function loadAutoEat() {
    try {
      const mod = await import('mineflayer-auto-eat');
      const loader = mod.loader || mod.default || mod.plugin;
      if (typeof loader === 'function') bot.loadPlugin(loader);
      console.log(`[plugin] auto-eat loaded (ESM) (${cfg.username})`);
    } catch (e) {
      try { const old = require('mineflayer-auto-eat'); bot.loadPlugin(old.default || old); console.log(`[plugin] auto-eat loaded (CJS fallback) (${cfg.username})`); }
      catch (e2) { console.log(`[plugin] auto-eat FAILED (${cfg.username}): ${e.message} / ${e2.message}`); }
    }
    try {
      if (bot.autoEat) {
        if (typeof bot.autoEat.setOpts === 'function') bot.autoEat.setOpts({ minHunger: 14, minHealth: 10, bannedFood: ['rotten_flesh', 'pufferfish', 'poisonous_potato', 'spider_eye'] });
        if (typeof bot.autoEat.enableAuto === 'function') bot.autoEat.enableAuto();        // v5/v6 API
        else if ('disabled' in bot.autoEat) bot.autoEat.disabled = false;                    // old API
        else if (typeof bot.autoEat.enable === 'function') bot.autoEat.enable();
        console.log(`[auto-eat] auto enabled (${cfg.username})`);
      }
    } catch (e) { console.log(`[auto-eat] enable failed (${cfg.username}):`, e.message); }
  }
  loadAutoEat();

  // ---- state machine (NestedStateMachine) ----
  ctx.setupStateMachine = function () {
    try {
      const sm = require('mineflayer-statemachine');
      const idle = new sm.BehaviorIdle();
      const follow = new sm.BehaviorFollowEntity(bot, ctx.targets); follow.followDistance = 2;
      const moveTo = new sm.BehaviorMoveTo(bot, ctx.targets); moveTo.distance = 1;
      const transitions = [
        new sm.StateTransition({ parent: idle, child: follow, shouldTransition: () => S.desiredState === 'follow' && !!ctx.targets.entity }),
        new sm.StateTransition({ parent: follow, child: idle, shouldTransition: () => S.desiredState !== 'follow' }),
        new sm.StateTransition({ parent: idle, child: moveTo, shouldTransition: () => S.desiredState === 'come' && !!ctx.targets.position }),
        new sm.StateTransition({ parent: moveTo, child: idle, shouldTransition: () => S.desiredState !== 'come' || (moveTo.isFinished && moveTo.isFinished()), onTransition: () => { if (S.desiredState === 'come') S.desiredState = 'idle'; } }),
        new sm.StateTransition({ parent: follow, child: moveTo, shouldTransition: () => S.desiredState === 'come' && !!ctx.targets.position }),
        new sm.StateTransition({ parent: moveTo, child: follow, shouldTransition: () => S.desiredState === 'follow' && !!ctx.targets.entity }),
      ];
      const root = new sm.NestedStateMachine(transitions, idle);
      root.stateName = 'root';
      S.stateMachine = new sm.BotStateMachine(bot, root);
      console.log(`[statemachine] NestedStateMachine started (${cfg.username})`);
    } catch (e) { console.log(`[statemachine] FAILED (${cfg.username}):`, e.message); S.stateMachine = null; }
  }

  // ---- helpers ----
  // Chat throttle: Paper kicks for chat spam when many bot.chat() calls fire in the
  // same second (hit this in the solo demo). Queue messages, flush ~1 per 1.15s.
  const chatQueue = [];
  setInterval(() => { const m = chatQueue.shift(); if (m !== undefined) { try { bot.chat(m); } catch {} } }, 1150);
  ctx.say = function (msg) { console.log(`[chat-out] ${msg}`); chatQueue.push(msg); }
  ctx.fail = function (prefix, e) { console.log(`[error] ${prefix}: ${e && e.message || e}`); ctx.say(`${prefix}: ${(e && e.message || e).toString().slice(0, 80)}`); }
  ctx.countItem = function (name) { return bot.inventory ? bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0) : 0; }
  // Inventory reads on this server can be phantoms (stale-but-consistent
  // window state). For decisions that matter, poll until two reads agree.
  ctx.stableCount = async function (name) { let prev = -1; for (let i = 0; i < 8; i++) { const c = ctx.countItem(name); if (c === prev) return c; prev = c; await new Promise(r => setTimeout(r, 1200)); } return prev; }
  // Shared fixture locks (user request 2026-11-24): with two bodies and
  // ONE chest/furnace, simultaneous container use corrupts both flows.
  // Re-entrant per body (depth), stale after 180s, and a waiter gives up
  // after 90s and proceeds unlocked — a lock must never deadlock a bot.
  ctx.acquireLock = async function (name, timeoutMs = 90000) {
    const ME = cfg.username;
    const start = Date.now();
    while (true) {
      const cur = shared.locks[name];
      // Free, or already mine (re-entrant: keep the original timestamp
      // so the stale takeover still bounds the total hold time).
      if (!cur || cur.by === ME) { shared.locks[name] = { by: ME, at: cur && cur.by === ME ? cur.at : Date.now(), depth: (cur && cur.by === ME ? cur.depth + 1 : 1) }; return true; }
      if (Date.now() - cur.at > 180000) { console.log(`[lock] ${name} stale (held by ${cur.by}) — taking over`); shared.locks[name] = { by: ME, at: Date.now(), depth: 1 }; return true; }
      if (Date.now() - start > timeoutMs) { console.log(`[lock] ${name} busy (${cur.by}) — proceeding without lock`); return false; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  ctx.releaseLock = function (name) {
    const cur = shared.locks[name];
    if (cur && cur.by === cfg.username) { cur.depth--; if (cur.depth <= 0) delete shared.locks[name]; }
  }
  ctx.invList = function () { return bot.inventory ? bot.inventory.items().map(i => `${i.name} x${i.count}`) : []; }
  ctx.findBlocks = function (names, maxDist = 32, count = 20) {
    try { const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(x => x !== undefined); if (!ids.length) return []; return bot.findBlocks({ matching: ids, maxDistance: maxDist, count }); } catch { return []; }
  }
  ctx.stopAll = function (reason = 'とまった') {
    S.soloAbort = true; S.fishingMode = false; S.guardMode = false; S.nightMode = false; S.pondMode = false; S.returningHome = false; S.assistMode = false; S.givingMode = false; S.repairMode = false; S.holeMode = false;
    if (shared.combat && shared.combat.by === cfg.username) shared.combat = null;
    if (shared.transfer && (shared.transfer.from === cfg.username || shared.transfer.to === cfg.username)) shared.transfer = null;
    if (S.guardTimer) { clearInterval(S.guardTimer); S.guardTimer = null; }
    S.desiredState = 'idle'; ctx.targets.entity = null;
    try { bot.pathfinder.setGoal(null); } catch {}
    try { if (bot.pvp) { if (bot.pvp.forceStop) bot.pvp.forceStop(); else if (bot.pvp.stop) bot.pvp.stop(); } } catch {}
    try { if (bot.collectBlock) bot.collectBlock.cancelTask().catch(() => {}); } catch {}
    try { bot.clearControlStates(); } catch {}
    console.log('[stopAll]', reason); ctx.say(reason);
  }
  ctx.withTimeout = function (promise, ms, label) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms / 1000}s`)), ms))]);
  }
  ctx.saveSettings = saveSettings;
  ctx.saveMemory = saveMemory;
  ctx.rememberSpot = function (kind) {
    try {
      if (!bot.entity) return;
      const p = bot.entity.position;
      memory.spots[kind] = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now() };
      ctx.saveMemory();
      console.log(`[memory] remembered ${kind} spot (${memory.spots[kind].x}, ${memory.spots[kind].z})`);
    } catch {}
  }
  Object.assign(ctx, { bot, goals, Movements, settings, memory, logBuf, chatQueue });
  ctx.bot = bot;
  return ctx;
}
module.exports = createCtx;
