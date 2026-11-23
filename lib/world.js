module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { LOG_TYPES, HOSTILES } = ctx.C;
ctx.gotoWatched = async function (goal, timeoutMs, label) {
  const { Vec3 } = require('vec3');
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let lastPos = bot.entity ? bot.entity.position.clone() : null;
    let lastMoveAt = Date.now();
    let settled = false;
    const watcher = setInterval(() => {
      try {
        if (!bot.entity || settled) return;
        if (bot.entity.position.distanceTo(lastPos) > 1) { lastPos = bot.entity.position.clone(); lastMoveAt = Date.now(); return; }
        if (Date.now() - lastMoveAt > 6000) {
          console.log(`[goto] ${label}: no progress for 6s — cancelling and nudging`);
          try { bot.pathfinder.setGoal(null); } catch {}
          try {
            bot.lookAt(new Vec3(goal.x, bot.entity.position.y + 1.6, goal.z), false).catch(() => {});
            bot.setControlState('forward', true); bot.setControlState('jump', true);
            setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 500);
            setTimeout(() => { try { bot.clearControlStates(); } catch {} }, 2000);
          } catch {}
          lastMoveAt = Date.now();
        }
      } catch {}
    }, 1000);
    try { await ctx.withTimeout(bot.pathfinder.goto(goal), timeoutMs, label); settled = true; return true; }
    catch (e) { settled = true; lastErr = e; console.log(`[goto] ${label}: attempt ${attempt + 1} failed: ${e.message}`); await new Promise(r => setTimeout(r, 2300)); }
    finally { clearInterval(watcher); try { bot.clearControlStates(); } catch {} }
  }
  throw lastErr || new Error(`${label} failed`);
}
// If a hostile is close, fight back with the best tool in hand before continuing.
// Night deaths during long steps were the top mission-abort cause.
ctx.checkDanger = async function () {
  const hostile = ctx.nearestHostile(7);
  if (!hostile) return;
  const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_pickaxe')) || bot.inventory.items().find(i => i.name.endsWith('_axe'));
  if (weapon) { try { await bot.equip(weapon, 'hand'); } catch {} }
  console.log(`[defense] fighting ${hostile.name} at ${bot.entity.position.distanceTo(hostile.position).toFixed(1)}m`);
  try { await ctx.withTimeout(bot.pvp.attack(hostile), 30000, 'defense'); } catch (e) { console.log('[defense]', e.message); }
}

ctx.collectByNames = async function (names, count, label, maxDist = 32) {
  const positions = ctx.findBlocks(names, maxDist, Math.max(count * 2, count));
  if (!positions.length) { ctx.say(`${label}が近くに見つからない`); return 0; }
  const blocks = positions.map(p => bot.blockAt(p)).filter(Boolean).slice(0, count);
  S.desiredState = 'busy'; ctx.say(`${label}を${blocks.length}個掘るね`);
  // Long pathfinding during collect can grow memory/CPU unbounded; cap each collect call.
  try { await ctx.withTimeout(bot.collectBlock.collect(blocks), 90000, label); }
  catch (e) { console.log(`[collect] ${label}: ${e.message} (partial progress may remain in inventory)`); try { await bot.collectBlock.cancelTask(); } catch {} }
  finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; }
  if (blocks.length > 0 && names.some(n => LOG_TYPES.includes(n))) ctx.rememberSpot('forest');
  return blocks.length;
}
// Manual stone mining. Do NOT use collectblock for stone: its vein flood-fill treats
// all connected underground stone as one vein and OOM'd the bot repeatedly in testing.
// Instead: pick single surface-exposed stone blocks, walk up, dig one by one.
ctx.excavateForStone = async function () {
  // Dig a small hole next to the bot (through dirt) until stone is exposed.
  const base = bot.entity.position.floored();
  for (let depth = 0; depth < 7; depth++) {
    const b = bot.blockAt(base.offset(2, -depth, 0));
    if (!b || b.name === 'air') continue;
    if (b.name === 'stone') return true;
    try {
      await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2)), 30000, 'excavate goto');
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      await ctx.withTimeout(bot.dig(b), 30000, 'excavate dig');
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { console.log('[stone] excavate:', e.message); return false; }
  }
  return false;
}
ctx.mineStoneManual = async function (count = 3) {
  let dug = 0;
  for (let i = 0; i < count; i++) {
    // Stone directly underfoot (after excavating down): dig it and drop in.
    // Widen the shaft right after falling in: dig one feet-level neighbour too,
    // so the bot is never trapped in a 1-wide hole (placement/movement broke there).
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (below && below.name === 'stone') {
      try { const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand'); await ctx.withTimeout(bot.dig(below), 45000, 'dig below'); dug++; await new Promise(r => setTimeout(r, 700));
        try { const base = bot.entity.position.floored(); for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) { const side = bot.blockAt(base.offset(dx, 0, dz)); if (side && side.name !== 'air') { await ctx.withTimeout(bot.dig(side), 30000, 'widen shaft'); break; } } } catch {}
        continue; }
      catch (e) { console.log('[stone] dig below failed:', e.message); }
    }
    const positions = ctx.findBlocks(['stone'], 16, 30);
    let target = null;
    for (const p of positions) {
      const b = bot.blockAt(p); if (!b) continue;
      const exposed = [[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => { const n = bot.blockAt(p.offset(x,y,z)); return n && (n.name === 'air' || n.name === 'cave_air'); });
      if (exposed) { target = b; break; }
    }
    if (!target) { console.log('[stone] no exposed stone nearby, excavating'); if (await ctx.excavateForStone()) continue; break; }
    try {
      await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2)), 45000, 'stone goto');
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe'));
      if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      else if (bot.tool) { try { await bot.tool.equipForBlock(target); } catch {} }
      const fresh = bot.blockAt(target.position);
      if (fresh && fresh.name === 'stone') { await ctx.withTimeout(bot.dig(fresh), 45000, 'dig'); dug++; await new Promise(r => setTimeout(r, 700)); }
    } catch (e) { console.log('[stone] dig failed:', e.message); break; }
    if (S.soloAbort) break;
  }
  if (dug > 0) ctx.rememberSpot('stone');
  return dug;
}
// Gather cobblestone: mineStoneManual only sees 16 blocks around the
// bot, and the base sits in deep soil where its excavation probe fails.
// Relocate (preferring higher ground, where stone outcrops) and retry.
ctx.gatherCobble = async function (need) {
  const { Vec3 } = require('vec3');
  const have = () => ctx.countItem('cobblestone');
  if (have() >= need) return true;
  await ctx.mineStoneManual(Math.min(need - have(), 8)).catch(() => 0);
  if (have() >= need) return true;
  for (let hop = 0; hop < 4 && have() < need && !S.soloAbort; hop++) {
    const p = bot.entity.position;
    let best = null;
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2, d = 22 + Math.random() * 14;
      const tx = Math.floor(p.x + Math.cos(a) * d), tz = Math.floor(p.z + Math.sin(a) * d);
      let top = null;
      for (let y = Math.floor(p.y) + 16; y >= Math.floor(p.y) - 16; y--) { const b = bot.blockAt(new Vec3(tx, y, tz)); if (b && b.boundingBox === 'block') { top = y; break; } }
      if (top !== null && (!best || top > best.top)) best = { x: tx, z: tz, top };
    }
    if (!best) break;
    console.log(`[stone] relocating for stone toward (${best.x}, ${best.z}) groundY=${best.top}`);
    try { await ctx.gotoWatched(new goals.GoalNear(best.x, best.top + 1, best.z, 3), 60000, 'stone relocation'); } catch {}
    await new Promise(r => setTimeout(r, 1200));
    await ctx.mineStoneManual(Math.min(need - have(), 8)).catch(() => 0);
  }
  console.log(`[stone] gatherCobble: ${have()}/${need}`);
  return have() >= need;
}
// Place an inventory block on top of a solid neighbour cell whose top is air.
ctx.placeItemOnGround = async function (itemName) {
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
      await ctx.withTimeout(bot.dig(cell), 30000, 'dig place spot');
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
ctx.nearestHostile = function (range = 16) {
  if (!bot.entity) return null;
  let best = null, bd = range;
  for (const e of Object.values(bot.entities)) { if (!e || e === bot.entity || !e.position) continue; if (!HOSTILES.has(e.name)) continue; const d = bot.entity.position.distanceTo(e.position); if (d < bd) { bd = d; best = e; } }
  return best;
}
ctx.attackEntity = async function (ent) { if (!ent) { ctx.say('近くに敵がいない'); return; } S.desiredState = 'busy'; ctx.say(`${ent.name || ent.displayName || '敵'}とたたかう`); try { await bot.pvp.attack(ent); } catch(e) { console.log('[pvp]', e.message); } finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; } }
};
