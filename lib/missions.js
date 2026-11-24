module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { LOG_TYPES, PLANK_OF, ARMOR_PLAN } = ctx.C;
  const shared = require('./shared');
  const { Vec3 } = require('vec3');
// ---- guard mode ----
ctx.startGuard = function (username) {
  S.guardMode = true; S.guardTargetName = username; ctx.say(`${username}を護衛するね`);
  if (S.guardTimer) clearInterval(S.guardTimer);
  S.guardTimer = setInterval(async () => {
    if (!S.guardMode) return;
    try {
      const hostile = ctx.nearestHostile(16);
      if (hostile && (!bot.pvp || !bot.pvp.target)) { console.log('[guard] hostile', hostile.name); await ctx.attackEntity(hostile); return; }
      const player = bot.players[S.guardTargetName]?.entity;
      if (player && bot.entity && bot.entity.position.distanceTo(player.position) > 4) {
        ctx.targets.entity = player; // return near player via pathfinder directly (avoid fighting statemachine)
        try { bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true); } catch {}
        setTimeout(() => { if (S.guardMode && !ctx.nearestHostile(16)) { try { bot.pathfinder.setGoal(null); } catch {} } }, 4000);
      }
    } catch (e) { console.log('[guard] tick:', e.message); }
  }, 3000);
}

// ---- fishing ----
// Full flow (user request 2026-11-23): gather the materials, craft the
// rod, find water, then fish. String comes from hunting spiders —
// there is no other source above ground.
ctx.huntString = async function (need = 2) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + 4 * 60 * 1000;
  let hops = 0;
  while (ctx.countItem('string') < need && Date.now() < deadline) {
    // Surface spiders only: without the height filter the hunt chased
    // a cave spider at y=40 and dragged the bot down into a cave
    // system (live 2026-11-23 night). String for a rod is a daylight,
    // above-ground errand.
    const spiders = Object.values(bot.entities).filter(e => e && e.position && (e.name === 'spider' || e.name === 'cave_spider') && bot.entity.position.distanceTo(e.position) <= 36 && Math.abs(e.position.y - bot.entity.position.y) <= 6);
    spiders.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
    const sp = spiders[0];
    if (!sp) {
      if (++hops > 5) break;
      const a = Math.random() * Math.PI * 2;
      const tx = Math.floor(bot.entity.position.x + Math.cos(a) * 24), tz = Math.floor(bot.entity.position.z + Math.sin(a) * 24);
      try { await ctx.gotoWatched(new goals.GoalNear(tx, bot.entity.position.y, tz, 2), 25000, 'spider-search'); } catch {}
      await wait(1200); // let entities stream in after arriving
      continue;
    }
    console.log(`[fish] hunting spider for string at ${sp.position}`);
    const before = ctx.countItem('string');
    try { await ctx.safeFight(sp, { timeout: 60000 }); } catch (e) { console.log('[fish] spider fight:', e.message); }
    try { await ctx.gotoWatched(new goals.GoalNear(sp.position.x, sp.position.y, sp.position.z, 1), 15000, 'string-pickup'); } catch {}
    await wait(1500);
    if (ctx.countItem('string') > before) { try { ctx.rememberSpot('spider'); } catch {} }
  }
  return ctx.countItem('string') >= need;
}
ctx.ensureFishingRod = async function () {
  if (ctx.countItem('fishing_rod') > 0) return true;
  try { await ctx.withdrawFromChest('fishing_rod', 1); } catch (e) { console.log('[fish] rod withdraw:', e.message); }
  if (ctx.countItem('fishing_rod') > 0) return true;
  // Cooperation: if the partner carries a spare rod, borrow it instead
  // of crafting one from scratch (lib/coop.js).
  try { const p = ctx.partnerCtx && ctx.partnerCtx(); if (p && p.ctx.countItem('fishing_rod') >= 2) { if (await ctx.askPartnerFor('fishing_rod', 1) && ctx.countItem('fishing_rod') > 0) return true; } } catch (e) { console.log('[fish] ask partner for rod:', e.message); }
  if (ctx.countItem('stick') < 3) { try { await ctx.withdrawFromChest('stick', 3); } catch {} }
  if (ctx.countItem('string') < 2) { try { await ctx.withdrawFromChest('string', 2); } catch {} }
  if (ctx.countItem('stick') < 3) {
    if (!bot.inventory.items().some(i => i.name.endsWith('_planks') && i.count >= 2)) {
      try { await ctx.withdrawFromChest('oak_planks', 4); } catch {}
      if (!bot.inventory.items().some(i => i.name.endsWith('_planks'))) {
        const log = bot.inventory.items().find(i => i.name.endsWith('_log'));
        if (log) { try { await ctx.craftItem(log.name.replace('_log', '_planks'), 1); } catch {} }
      }
    }
    if (bot.inventory.items().some(i => i.name.endsWith('_planks') && i.count >= 2)) { try { await ctx.craftItem('stick', 1); } catch (e) { console.log('[fish] stick craft:', e.message); } }
  }
  // Cooperation first: if the partner has string to spare, they bring
  // it over — no spider hunt needed (user example 2026-11-23).
  if (ctx.countItem('string') < 2) { try { await ctx.askPartnerFor('string', 2 - ctx.countItem('string')); } catch (e) { console.log('[fish] ask partner for string:', e.message); } }
  if (ctx.countItem('string') < 2) { try { await ctx.huntString(2); } catch (e) { console.log('[fish] huntString:', e.message); } }
  if (ctx.countItem('stick') < 3 || ctx.countItem('string') < 2) { console.log(`[fish] materials short: stick=${ctx.countItem('stick')} string=${ctx.countItem('string')}`); return false; }
  // The rod needs a 3x3 grid. After a spider hunt the bot is out in the
  // field with no table (and too few planks left to make one — the
  // first live run failed exactly here), so craft it back at the base
  // where a table is placed.
  if (!ctx.findCraftingTable() && ctx.countItem('crafting_table') === 0 && settings.home) { console.log('[fish] no table here — crafting the rod back at base'); try { await ctx.goHome(); } catch (e) { console.log('[fish] goHome:', e.message); } }
  let ok = false;
  try { ok = await ctx.craftItem('fishing_rod', 1); } catch (e) { console.log('[fish] rod craft:', e.message); }
  await new Promise(r => setTimeout(r, 800));
  return !!(ok && ctx.countItem('fishing_rod') > 0);
}
ctx.findFishingSpot = async function (opts = {}) {
  const { Vec3 } = require('vec3');
  const isWater = (p) => { try { const b = bot.blockAt(p); return !!(b && b.name === 'water'); } catch { return false; } };
  const bankFor = (wpos) => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let dy = -1; dy <= 1; dy++) {
        const p = new Vec3(wpos.x + dx, wpos.y + dy, wpos.z + dz);
        try { const b = bot.blockAt(p); const above = bot.blockAt(p.offset(0, 1, 0)); if (b && b.boundingBox === 'block' && above && above.boundingBox === 'empty') return p; } catch {}
      }
    }
    return null;
  };
  // "Open water" — the game's treasure rule: the bobber must land
  // where a 5x5 patch of surface around it is all water, with water
  // below and air above. Casts hugging the bank (what the bot did at
  // first, aiming at its own feet) can only ever yield fish and junk;
  // treasure (enchanted books, rods, saddles...) needs mid-water.
  // Column-relative surface check: a river surface is not one flat
  // y-level (steps where it flows down a block broke the first, flat
  // version of this check everywhere). Each of the 5x5 columns needs
  // its own water surface within a block of the candidate's, nothing
  // solid poking through, and water one block below the surface.
  const columnSurface = (x, z, y0) => {
    for (let y = y0 + 2; y >= y0 - 3; y--) {
      let b = null;
      try { b = bot.blockAt(new Vec3(x, y, z)); } catch {}
      if (!b) continue;
      if (b.name === 'water') return y;
      if (b.boundingBox === 'block') return null;
    }
    return null;
  };
  const openPointNear = (p) => {
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
      const cx = p.x + dx, cz = p.z + dz;
      const s0 = columnSurface(cx, cz, p.y);
      if (s0 === null) continue;
      let ok = true;
      for (let ox = -2; ox <= 2 && ok; ox++) for (let oz = -2; oz <= 2 && ok; oz++) {
        const s = columnSurface(cx + ox, cz + oz, p.y);
        if (s === null || Math.abs(s - s0) > 1) { ok = false; break; }
        const below = bot.blockAt(new Vec3(cx + ox, s - 1, cz + oz));
        if (!below || below.name !== 'water') { ok = false; break; }
      }
      if (ok) return new Vec3(cx, s0, cz);
    }
    return null;
  };
  const bankNearWater = (p, R) => {
    for (let r = 0; r <= R; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const c = new Vec3(p.x + dx, p.y, p.z + dz);
      if (!isWater(c)) continue;
      const b = bankFor(c); if (b) return b;
    }
    return null;
  };
  let fallbackSpot = null;
  const consider = (s) => {
    if (!s) return null;
    const op = openPointNear(s.water);
    if (op) {
      const bank = bankNearWater(op, 10);
      if (bank) { memory.spots.water = { x: op.x, y: op.y, z: op.z, at: Date.now() }; memory.spots.lake = { x: op.x, y: op.y, z: op.z, at: Date.now() }; ctx.saveMemory(); console.log(`[fish] open-water spot at ${op} (treasure possible)`); return { water: op, bank, open: true }; }
    }
    if (!fallbackSpot && s.bank) fallbackSpot = { water: s.water, bank: s.bank, open: false };
    return null;
  };
  if (memory.spots && memory.spots.water) {
    const w = memory.spots.water; const wp = new Vec3(w.x, w.y, w.z);
    if (isWater(wp)) { const s = consider({ water: wp, bank: bankNearWater(wp, 10) }); if (s) return s; }
  }
  // findBlocks misses things on this server — sweep blockAt directly.
  const sweep = (c, R) => {
    for (let r = 0; r <= R; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let y = c.y - 13; y <= c.y + 1; y++) {
          const p = new Vec3(c.x + dx, y, c.z + dz);
          if (!isWater(p)) continue;
          const bank = bankFor(p);
          if (bank) return { water: p, bank };
        }
      }
    }
    return null;
  };
  if (bot.entity) { const s = consider(sweep(bot.entity.position.floored(), 48)); if (s) return s; }
  if (settings.home) { const s = consider(sweep(new Vec3(settings.home.x, settings.home.y, settings.home.z), 48)); if (s) return s; }
  // No water nearby (the base area is dry — the first live run proved
  // it): hop outward and rescan, bounded so a dry area cannot strand
  // the bot far from home.
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 5 && bot.entity && opts.searchFar !== false; i++) {
    const [dx, dz] = dirs[i % dirs.length];
    const tx = Math.floor(bot.entity.position.x + dx * 44), tz = Math.floor(bot.entity.position.z + dz * 44);
    console.log(`[fish] water search hop ${i + 1}: -> (${tx}, ${tz})`);
    try { await ctx.gotoWatched(new goals.GoalNear(tx, bot.entity.position.y, tz, 3), 45000, 'water-search'); } catch {}
    await wait(1000);
    if (!bot.entity) break;
    const s = consider(sweep(bot.entity.position.floored(), 44));
    if (s) return s;
  }
  if (fallbackSpot) { memory.spots.water = { x: fallbackSpot.water.x, y: fallbackSpot.water.y, z: fallbackSpot.water.z, at: Date.now() }; ctx.saveMemory(); console.log('[fish] no open water anywhere — bank spot it is (fish/junk only)'); return fallbackSpot; }
  return null;
}
ctx.fishMission = async function (opts = {}) {
  const auto = !!opts.auto;
  if (S.fishingMode) return;
  S.fishingMode = true; S.desiredState = 'busy';
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  let caught = 0;
  try {
    if (!auto) ctx.say('釣りの準備をするね');
    try { await ctx.prepareForMission(); } catch {}
    if (!(await ctx.ensureFishingRod())) { ctx.say('釣り竿の材料がそろわなかった（糸が足りない）'); return; }
    const spot = await ctx.findFishingSpot();
    if (!spot) { ctx.say('近くに釣れそうな水場が見つからない'); return; }
    try { await ctx.gotoWatched(new goals.GoalNear(spot.bank.x, spot.bank.y, spot.bank.z, 1), 40000, 'goto fishing spot'); } catch {}
    const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
    if (!rod) { ctx.say('釣り竿が見当たらない'); return; }
    try { await bot.equip(rod, 'hand'); } catch (e) { ctx.fail('竿の装備に失敗', e); return; }
    ctx.say(auto ? '昼の釣りをはじめる' : '釣りをはじめる。「とまれ」でやめるよ');
    console.log(`[fish] session start at bank ${spot.bank} (auto=${auto}, open=${!!spot.open})`);
    const until = Date.now() + (auto ? 8 * 60 * 1000 : 30 * 60 * 1000);
    let castErrors = 0;
    while (S.fishingMode && Date.now() < until) {
      if (bot.time && bot.time.timeOfDay > 11000) { console.log('[fish] dusk — wrapping up'); break; }
      if (bot.health < 20 || ctx.nearestHostile(5)) { console.log('[fish] interrupted (danger or hurt)'); break; }
      if (ctx.countItem('fishing_rod') === 0) { console.log('[fish] rod gone/broken'); break; }
      // Open-water spots are aimed at directly (the bobber must land
      // mid-water for treasure). Bank fallback spots keep the pulled-
      // in aim: a level cast there overshoots a small pond, the bobber
      // lands on the far bank and bot.fish() waits forever for a bite
      // that cannot come (first live session hung exactly so).
      const aim = spot.water.offset(0.5, spot.open ? -0.1 : 0.1, 0.5);
      if (!spot.open) {
        aim.x = bot.entity.position.x + (aim.x - bot.entity.position.x) * 0.45;
        aim.z = bot.entity.position.z + (aim.z - bot.entity.position.z) * 0.45;
      }
      try { await bot.lookAt(aim, true); } catch {}
      try {
        await Promise.race([bot.fish(), new Promise((_, rej) => setTimeout(() => rej(new Error('cast timeout — no bite')), 50000))]);
        caught++; castErrors = 0; console.log(`[fish] caught #${caught}`);
      }
      catch (e) { try { bot.deactivateItem(); } catch {} castErrors++; console.log('[fish] cast:', e.message); if (castErrors >= 5) { console.log('[fish] too many failed casts — giving up this spot'); break; } await wait(1500); }
    }
  } catch (e) { console.log('[fish] mission error:', e.message); }
  finally {
    S.fishingMode = false;
    S.lastFishAt = Date.now();
    console.log(`[fish] session end: caught=${caught}`);
    if (!auto) ctx.say(`釣りおわり。${caught}匹釣れた`);
    // After an auto session at a far-off water spot, head back home so
    // dusk does not catch the bot far from the hut.
    if (auto && settings.home && bot.entity) {
      const { Vec3 } = require('vec3');
      if (bot.entity.position.distanceTo(new Vec3(settings.home.x, settings.home.y, settings.home.z)) > 48) {
        console.log('[fish] far from home — heading back');
        // Flagged as active work: this walk home runs after fishingMode
        // cleared, and an unflagged goHome kept cancelling the pond
        // mission's gotos on 2026-11-23 (goal-changed dig failures).
        S.returningHome = true;
        try { await ctx.goHome(); } catch (e) { console.log('[fish] goHome after session:', e.message); }
        S.returningHome = false;
      }
    }
    if (S.desiredState === 'busy') S.desiredState = 'idle';
  }
}

// ---- open-water construction (user request 2026-11-23) ----
// No natural water near the base qualifies as open water, so reshape
// the river itself: widen the surface to a full 5x5 and deepen the
// bed to 3. Digging only — no bucket/iron chain needed.
ctx.makeOpenWater = async function () {
  if (S.pondMode) return;
  S.pondMode = true; S.fishingMode = false; S.desiredState = 'busy';
  const { Vec3 } = require('vec3');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    // Settle first: cancel any stray movement (e.g. a walk home left
    // over from a stopped session) so its gotos cannot fight the digs.
    S.returningHome = false;
    try { bot.pathfinder.setGoal(null); } catch {}
    try { bot.clearControlStates(); } catch {}
    await wait(2000);
    ctx.say('開けた水域を作りに行くね');
    try { await ctx.prepareForMission(); } catch {}
    const base = await ctx.findFishingSpot({ searchFar: false });
    if (!base) { ctx.say('水場自体が見つからない'); return; }
    if (base.open) { ctx.say('もう開けた水域があるよ'); return; }
    const refY = base.water.y;
    const surfAt = (x, z) => { for (let y = refY + 2; y >= refY - 3; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue; if (b.name === 'water') return y; if (b.boundingBox === 'block') return null; } return null; };
    const depthAt = (x, z, s) => { let d = 0; for (let y = s; y >= s - 5; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.name === 'water') d++; else break; } return d; };
    // Pick the 5x5 patch near the known water with the most
    // water-surface cells — the least digging to finish.
    let best = null;
    for (let ox = base.water.x - 8; ox <= base.water.x + 8; ox++) for (let oz = base.water.z - 8; oz <= base.water.z + 8; oz++) {
      let score = 0;
      for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) { const s = surfAt(ox + dx, oz + dz); if (s !== null && Math.abs(s - refY) <= 1) score++; }
      if (!best || score > best.score) best = { ox, oz, score };
    }
    console.log(`[pond] patch origin (${best.ox}, ${best.oz}) score=${best.score}/25 refY=${refY}`);
    if (best.score < 10) { ctx.say('川の形が悪くて、広げられそうな場所がない'); return; }
    const digs = [];
    for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
      const x = best.ox + dx, z = best.oz + dz;
      const s = surfAt(x, z);
      if (s === null) {
        // Land inside the patch: dig the column down to refY-2 so
        // water flows in (top-down, so sand/gravel cannot undercut).
        for (let y = refY + 2; y >= refY - 2; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.boundingBox === 'block') digs.push(new Vec3(x, y, z)); }
      } else {
        let d = depthAt(x, z, s);
        let y = s - d; // first solid under the water column
        while (d < 3) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b || b.boundingBox !== 'block') break; digs.push(new Vec3(x, y, z)); y--; d++; }
      }
    }
    console.log(`[pond] ${digs.length} blocks to dig`);
    const tool = bot.inventory.items().find(i => i.name.endsWith('_shovel')) || bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
    if (tool) { try { await bot.equip(tool, 'hand'); } catch {} }
    let dug = 0;
    for (const target of digs) {
      if (bot.time && bot.time.timeOfDay > 10500) { console.log('[pond] dusk — stopping construction'); ctx.say('夕方だから工事は中断するね'); return; }
      if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 8) {
        try { await ctx.gotoWatched(new goals.GoalNear(base.bank.x, base.bank.y, base.bank.z, 1), 20000, 'pond breathe'); } catch {}
        await wait(2500);
      }
      const b0 = bot.blockAt(target);
      if (!b0 || b0.boundingBox !== 'block') continue;
      try { await ctx.gotoWatched(new goals.GoalNear(target.x, target.y, target.z, 2), 20000, 'pond dig approach'); } catch {}
      const bb = bot.blockAt(target);
      if (!bb || bb.boundingBox !== 'block') continue;
      try { await ctx.withTimeout(bot.dig(bb), 30000, 'pond dig'); dug++; if (dug % 10 === 0) console.log(`[pond] dug ${dug}/${digs.length}`); } catch (e) { console.log('[pond] dig failed:', e.message); }
    }
    console.log(`[pond] construction done: dug=${dug}/${digs.length}`);
    await wait(3000); // let the water settle
    const check = await ctx.findFishingSpot({ searchFar: false });
    if (check && check.open) ctx.say('開けた水域ができた。レアも釣れるはず');
    else ctx.say('広げてみたけど、まだ開けた水域の条件に届いてないみたい');
  } catch (e) { console.log('[pond] error:', e.message); }
  finally { S.pondMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}

// ---- fishing pond, dry-pit method (user choice 2026-11-24) ----
// The underwater widening above failed live twice: digging under
// water stalls (pathfinding + breath + two bodies in a 5x5 space).
// Land digging is proven, so: find flat land near the river, dig a
// 5x5 pit 3 deep, and carry the water in with a bucket. The pit is
// remembered (memory.spots.pond) so a dusk-aborted run resumes
// instead of digging a second, deeper pit.
ctx.ensureBucket = async function () {
  if (ctx.countItem('bucket') + ctx.countItem('water_bucket') > 0) return true;
  // Iron chain: stone pickaxe -> mine raw iron -> smelt -> craft.
  if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) { try { await ctx.pickaxeMission(); } catch (e) { console.log('[pond] pickaxe:', e.message); } }
  for (let round = 0; round < 3 && ctx.countItem('iron_ingot') < 3; round++) {
    if (ctx.countItem('raw_iron') + ctx.countItem('iron_ingot') < 3) { try { await ctx.mineIronManual(3); } catch (e) { console.log('[pond] mine iron:', e.message); } }
    if (ctx.countItem('raw_iron') > 0) { try { await ctx.smeltRawIron(); } catch (e) { console.log('[pond] smelt iron:', e.message); } }
    await new Promise(r => setTimeout(r, 800));
  }
  if (ctx.countItem('iron_ingot') >= 3) { try { await ctx.craftItem('bucket', 1); } catch (e) { console.log('[pond] craft bucket:', e.message); } }
  return ctx.countItem('bucket') > 0;
}
// ---- pond: shared water work (ctx level, both bodies) ----
// Hoisted out of makePond so the PARTNER can haul water too: the
// user pointed out (2026-11-24) that Yume idles through the whole
// pond build. makePond publishes the dry cells as shared.pondJob;
// both bodies pull cells from the same queue (work stealing) and
// carry water from the infinite well beside the pit.
ctx.isSourceCell = function (x, y, z) {
  const b = bot.blockAt(new Vec3(x, y, z));
  if (!b || b.name !== 'water') return false;
  try { const pr = b.getProperties(); return !!pr && (pr.level === 0 || pr.level === '0'); } catch { return false; }
};
ctx.scoopWaterAt = async function (target) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (ctx.countItem('water_bucket') > 0) return true;
  // Approach the BANK beside the source, not the water cell itself:
  // a goal in the water makes gotoWatched give up in under a second.
  let bank = null;
  for (const [bx, bz] of [[target.x + 1, target.z], [target.x - 1, target.z], [target.x, target.z + 1], [target.x, target.z - 1], [target.x + 1, target.z + 1], [target.x + 1, target.z - 1], [target.x - 1, target.z + 1], [target.x - 1, target.z - 1]]) {
    for (let by = target.y + 2; by >= target.y - 1 && !bank; by--) {
      const g = bot.blockAt(new Vec3(bx, by, bz));
      const above = bot.blockAt(new Vec3(bx, by + 1, bz));
      if (g && g.boundingBox === 'block' && g.name !== 'water' && (!above || above.boundingBox === 'empty')) bank = { x: bx, y: by, z: bz };
    }
    if (bank) break;
  }
  const dest = bank || target;
  try { await ctx.gotoWatched(new goals.GoalNear(dest.x, dest.y, dest.z, bank ? 1 : 2), 45000, 'scoop approach'); }
  catch (e) { console.log('[pond] scoop approach failed:', e.message, 'at', JSON.stringify(bot.entity.position)); }
  const dp = bot.entity.position;
  if (Math.hypot(dp.x - (target.x + 0.5), dp.z - (target.z + 0.5)) > 5) { console.log('[pond] scoop: too far from the source — skipped'); return false; }
  const before = ctx.countItem('water_bucket');
  const bucket = bot.inventory.items().find(i => i.name === 'bucket');
  if (!bucket) return false;
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
  try { await bot.equip(bucket, 'hand'); } catch {}
  try { await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.4, target.z + 0.5), true); } catch {}
  await wait(300);
  try { bot.activateItem(); } catch {}
  // The scoop's result can take many seconds to appear in the
  // client inventory on this laggy server — poll before concluding.
  for (let i = 0; i < 10 && ctx.countItem('water_bucket') === before; i++) await wait(500);
  if (ctx.countItem('water_bucket') === before) { const wb = bot.blockAt(new Vec3(target.x, target.y, target.z)); if (wb) { try { await bot.activateBlock(wb); } catch {} for (let i = 0; i < 6 && ctx.countItem('water_bucket') === before; i++) await wait(500); } }
  const ok = ctx.countItem('water_bucket') > before;
  if (ok) console.log(`[pond] ${bot.username} scooped at ${target.x}, ${target.y}, ${target.z}`);
  return ok;
};
ctx.pourWaterAt = async function (x, y, z, pit) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const cur = bot.blockAt(new Vec3(x, y, z));
  if (cur && cur.name === 'water') return true;
  // Stand-point rule: never pour from inside the target column —
  // the server refuses to fill a cell the body occupies, and rim
  // pours overshoot the reach (a full day of failed west-edge
  // pours, 2026-11-24). For a pit cell, stand in the pit two cells
  // toward the centre, at the layer below the target.
  if (pit) {
    const cx = pit.ox + 2, cz = pit.oz + 2;
    const sx = Math.max(pit.ox, Math.min(pit.ox + 4, x + Math.sign(cx - x) * 2));
    const sz = Math.max(pit.oz, Math.min(pit.oz + 4, z + Math.sign(cz - z) * 2));
    try { await ctx.gotoWatched(new goals.GoalNear(sx, pit.floorY + 1, sz, 1), 25000, 'pour stand'); } catch {}
  } else {
    try { await ctx.gotoWatched(new goals.GoalNear(x, y, z, 3), 25000, 'pour stand'); } catch {}
  }
  const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (!wb) return false;
  try { await bot.equip(wb, 'hand'); } catch {}
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
  // Pour against a solid neighbour's face (wall faces for the top
  // layer, the floor for the bottom layer), down-pour last.
  const refs = [new Vec3(x + 1, y, z), new Vec3(x - 1, y, z), new Vec3(x, y, z + 1), new Vec3(x, y, z - 1), new Vec3(x, y - 1, z)];
  for (const rp of refs) {
    const rb = bot.blockAt(rp);
    if (!rb || rb.boundingBox !== 'block') continue;
    const aim = new Vec3((rp.x + x) / 2 + 0.5, (rp.y + y) / 2 + 0.4, (rp.z + z) / 2 + 0.5);
    try { await bot.lookAt(aim, true); } catch {}
    await wait(250);
    try { bot.activateItem(); } catch {}
    await wait(900);
    const after = bot.blockAt(new Vec3(x, y, z));
    if (after && after.name === 'water') return true;
  }
  try { await bot.lookAt(new Vec3(x + 0.5, y - 0.5, z + 0.5), true); } catch {}
  await wait(250);
  try { bot.activateItem(); } catch {}
  await wait(900);
  const after = bot.blockAt(new Vec3(x, y, z));
  return !!(after && after.name === 'water');
};
ctx.ensureWellAtPond = async function (ox, oz, floorY) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (memory.spots && memory.spots.well) {
    const w = memory.spots.well;
    let n = 0;
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (ctx.isSourceCell(w.x + dx, w.y, w.z + dz)) n++;
    if (n >= 2) { console.log(`[pond] well verified at ${w.x}, ${w.y}, ${w.z} (${n} source cells)`); return { x: w.x, y: w.y, z: w.z }; }
    console.log('[pond] remembered well is dead — rebuilding');
  }
  // Seed water comes from the pit's own bottom layer (full of
  // sources once the bottom is in) — no lake trip needed. Keep
  // several candidates: one run's first pick was a cell the view
  // showed as water but the server had as dirt, and its scoop
  // failed — fall through to the next candidate instead of dying.
  const seeds = [];
  for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) if (ctx.isSourceCell(ox + dx, floorY + 1, oz + dz)) seeds.push({ x: ox + dx, y: floorY + 1, z: oz + dz });
  if (!seeds.length) { console.log('[pond] well: no seed source in the pit bottom'); return null; }
  const DIGGABLE = new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'coarse_dirt', 'podzol']);
  let well = null;
  for (const [dxo, dzo] of [[-3, 1], [-3, -2], [1, 5], [5, 1], [-3, 3], [3, -3], [-3, -4], [-4, 0]]) {
    const wx = ox + dxo, wz = oz + dzo;
    const gys = [0, 1, 2, 3].map(i => ctx.groundYAt(wx + (i % 2), wz + Math.floor(i / 2), floorY + 4));
    if (gys.some(g => g < 0) || Math.max(...gys) !== Math.min(...gys)) continue;
    const tops = [0, 1, 2, 3].map(i => bot.blockAt(new Vec3(wx + (i % 2), gys[i], wz + Math.floor(i / 2))));
    if (tops.some(t => !t || !DIGGABLE.has(t.name))) continue;
    well = { x: wx, y: gys[0], z: wz };
    break;
  }
  if (!well) { console.log('[pond] well: no flat 2x2 patch near the pit'); return null; }
  for (let i = 0; i < 4; i++) {
    const cxp = well.x + (i % 2), czp = well.z + Math.floor(i / 2);
    try { await ctx.gotoWatched(new goals.GoalNear(cxp, well.y, czp, 2), 25000, 'well dig approach'); } catch {}
    const bb = bot.blockAt(new Vec3(cxp, well.y, czp));
    if (bb && bb.boundingBox === 'block') { try { await ctx.withTimeout(bot.dig(bb), 30000, 'well dig'); } catch (e) { console.log('[pond] well dig failed:', e.message); } }
  }
  console.log(`[pond] well dug at (${well.x}, ${well.y}, ${well.z}) — seeding from the pit bottom`);
  for (const [cxp, czp] of [[well.x, well.z], [well.x + 1, well.z + 1]]) {
    let scooped = false;
    for (const s of seeds.slice(0, 4)) { if (await ctx.scoopWaterAt(s)) { scooped = true; break; } }
    if (!scooped) { console.log('[pond] well: every seed scoop failed'); return null; }
    if (!await ctx.pourWaterAt(cxp, well.y, czp, null)) { console.log('[pond] well: seed pour failed'); return null; }
  }
  await wait(2500); // the other two cells regenerate into sources
  let n = 0;
  for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (ctx.isSourceCell(well.x + dx, well.y, well.z + dz)) n++;
  if (n < 2) { console.log(`[pond] well: only ${n} source cells after seeding`); return null; }
  memory.spots = memory.spots || {};
  memory.spots.well = well;
  ctx.saveMemory();
  console.log(`[pond] infinite well ready at (${well.x}, ${well.y}, ${well.z})`);
  return { x: well.x, y: well.y, z: well.z };
};
ctx.fillPondCells = async function (job) {
  let done = 0, failed = 0;
  const deadline = Date.now() + 8 * 60000;
  while (shared.pondJob === job && job.next < job.cells.length && Date.now() < deadline) {
    if (bot.time && bot.time.timeOfDay > 10500) { console.log('[pond] fill: dusk — stopping'); break; }
    const [x, y, z] = job.cells[job.next++];
    const cur = bot.blockAt(new Vec3(x, y, z));
    if (cur && cur.name === 'water') { done++; continue; }
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (ctx.countItem('water_bucket') === 0 && !await ctx.scoopWaterAt(job.src)) break;
      ok = await ctx.pourWaterAt(x, y, z, job.pit);
    }
    if (ok) done++; else { failed++; console.log(`[pond] ${bot.username}: cell ${x},${y},${z} failed`); }
  }
  console.log(`[pond] ${bot.username} fill share: ${done} ok, ${failed} failed`);
  return { done, failed };
};

// Fill the pond-side well (user improvement test 2026-11-24): the
// 2x2 pit dug beside the pond yesterday (floor y = pond floorY+2)
// never got its water — the pathfinder cannot reach it from inside
// the pond. Fill it as a pair haul job (shared.pondJob) from the
// pond itself, which also exercises the two-body water haul for
// real. On >= 2 source cells the well works as an infinite source.
ctx.fillWellMission = async function () {
  if (S.pondMode) return false;
  S.pondMode = true; S.desiredState = 'busy';
  try {
    const site = memory.spots && memory.spots.pond;
    if (!site) { ctx.say('池の場所を知らないから井戸の場所も分からない'); return false; }
    const wx = site.ox - 3, wz = site.oz + 1, wy = site.floorY + 3;
    const cells = [];
    for (const dx of [0, 1]) for (const dz of [0, 1]) {
      const b = bot.blockAt(new Vec3(wx + dx, wy, wz + dz));
      if (!b || b.name !== 'water') cells.push([wx + dx, wy, wz + dz]);
    }
    if (!cells.length) { ctx.say('井戸はもう水でいっぱいだよ'); memory.spots.well = { x: wx, y: wy, z: wz }; ctx.saveMemory(); return true; }
    ctx.say('井戸に水を入れるね。二人で運ぶよ');
    if (ctx.countItem('bucket') + ctx.countItem('water_bucket') === 0) { try { await ctx.withdrawFromChest('bucket', 1); } catch {} }
    const job = { cells, next: 0, src: { x: site.ox + 2, y: site.floorY + 2, z: site.oz + 2 }, pit: { ox: wx, oz: wz, floorY: wy - 1 }, by: bot.username, at: Date.now() };
    shared.pondJob = job;
    try { await ctx.fillPondCells(job); } finally { if (shared.pondJob === job) shared.pondJob = null; }
    let sources = 0;
    for (const dx of [0, 1]) for (const dz of [0, 1]) if (ctx.isSourceCell(wx + dx, wy, wz + dz)) sources++;
    console.log(`[well] fill result: ${sources}/4 source cells`);
    if (sources >= 2) { memory.spots.well = { x: wx, y: wy, z: wz }; ctx.saveMemory(); ctx.say(`井戸ができたよ（水源 ${sources}/4）`); return true; }
    ctx.say('井戸に水が溜まらなかった…');
    return false;
  } catch (e) { console.log('[well] failed:', e.message); return false; }
  finally { S.pondMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
};

// ---- rescue: dig a stuck partner out (user request 2026-11-24) ----
// The stuck body publishes shared.helpReq {by, x, y, z, reason};
// the free partner answers here: walk to the surface above her,
// dig a 1-block-rise staircase down to the cell beside her, tell
// her the exit is open (shared.rescue.phase + chat), and watch
// her climb out via the partner ctx before heading home.
ctx.rescuePartner = async function (req) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tx = req.x, ty = req.y, tz = req.z;
  shared.rescue = { for: req.by, by: bot.username, phase: 'going', at: Date.now() };
  ctx.say(`${req.by}、助けに行くね`);
  if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
    try { await ctx.pickaxeMission(); } catch (e) { console.log('[rescue] pickaxe:', e.message); }
    if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) { console.log('[rescue] no pickaxe — cannot dig a rescue'); ctx.say('ツルハシがなくて掘れない…'); shared.rescue.phase = 'failed'; return false; }
  }
  const surfY = ctx.groundYAt(tx, tz, ty + 24);
  if (surfY < 0 || surfY <= ty) { console.log('[rescue] no surface found above the stuck spot'); shared.rescue.phase = 'failed'; return false; }
  // Exit direction: lowest ground a few cells out, biased to home.
  let best = null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const gy = ctx.groundYAt(tx + dx * 4, tz + dz * 4, ty + 24);
    const dHome = settings.home ? Math.hypot(tx + dx * 4 - settings.home.x, tz + dz * 4 - settings.home.z) : 0;
    const score = (gy < 0 ? 99 : gy) * 2 + dHome * 0.1;
    if (!best || score < best.score) best = { dx, dz, score };
  }
  const { dx, dz } = best;
  console.log(`[rescue] surface y=${surfY}, exit direction ${dx},${dz}`);
  try { await ctx.gotoWatched(new goals.GoalNear(tx, surfY + 1, tz, 2), 60000, 'rescue approach'); } catch (e) { console.log('[rescue] approach:', e.message); }
  shared.rescue.phase = 'digging'; shared.rescue.at = Date.now();
  ctx.say('階段を掘るね');
  // Step j: feet at (tx + dx*(1+j), ty + j, tz + dz*(1+j)), plus
  // the head cell one above it. Dig from the top step (surface)
  // down to j=0, the cell beside the stuck body, stepping down
  // into each cleared cell as it opens.
  const topJ = surfY - ty + 1;
  const digCell = async (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b || b.boundingBox !== 'block') return true;
    if (b.name === 'bedrock') return false;
    try { await ctx.withTimeout(bot.dig(b), 30000, 'rescue dig'); } catch (e) { console.log(`[rescue] dig ${x},${y},${z}:`, e.message); return false; }
    await wait(300);
    const after = bot.blockAt(new Vec3(x, y, z));
    return !after || after.boundingBox !== 'block';
  };
  for (let j = topJ; j >= 0; j--) {
    const fx = tx + dx * (1 + j), fy = ty + j, fz = tz + dz * (1 + j);
    try { await ctx.gotoWatched(new goals.GoalNear(fx - dx, fy + 1, fz - dz, 1), 30000, 'rescue step'); } catch {}
    if (!await digCell(fx, fy + 1, fz)) console.log(`[rescue] head cell ${fx},${fy + 1},${fz} not cleared`);
    if (!await digCell(fx, fy, fz)) console.log(`[rescue] step cell ${fx},${fy},${fz} not cleared`);
    try { await ctx.gotoWatched(new goals.GoalNear(fx, fy, fz, 0), 20000, 'rescue descend'); } catch {}
    if (bot.time && bot.time.timeOfDay > 11000) { console.log('[rescue] dusk — aborting the dig'); shared.rescue.phase = 'failed'; return false; }
  }
  shared.rescue.phase = 'open'; shared.rescue.at = Date.now();
  const dirName = dx === 1 ? '東' : dx === -1 ? '西' : dz === 1 ? '南' : '北';
  ctx.say(`道開けたよ！${dirName}側に階段を掘ったから、上がってきて`);
  console.log(`[rescue] staircase open toward ${dx},${dz} — waiting for ${req.by} to climb out`);
  const pw = ctx.partnerCtx();
  const watchPos = () => {
    if (pw && pw.name === req.by && pw.ctx && pw.ctx.bot && pw.ctx.bot.entity) return pw.ctx.bot.entity.position;
    const ent = Object.values(bot.entities || {}).find(e => e && e.username === req.by);
    return ent ? ent.position : null;
  };
  const deadline = Date.now() + 120000;
  let out = false;
  while (Date.now() < deadline) {
    await wait(5000);
    const pp = watchPos();
    if (!pp) break;
    if (pp.y >= surfY - 1) { out = true; break; }
    if (!shared.helpReq || shared.helpReq.by !== req.by) { out = true; break; }
  }
  console.log(`[rescue] ${out ? 'partner is out' : 'partner not confirmed out yet'}`);
  if (out) { ctx.say('出られたね、よかった'); if (shared.helpReq && shared.helpReq.by === req.by) shared.helpReq = null; }
  shared.rescue.phase = out ? 'done' : 'open';
  try { await ctx.gotoWatched(new goals.GoalNear(tx + dx * (1 + topJ), surfY + 1, tz + dz * (1 + topJ), 2), 60000, 'rescue climb out'); } catch {}
  return out;
};

// ---- cave fill: the hollow layer under the hut hill ----
// (user improvement 2026-11-24: ~253 enclosed air cells under
// the base, left sealed in the morning job.) One bot goes in
// alone: dig the old plugged shaft at (177,-109) back down,
// tunnel into the cave, fill every spec column from inside
// (memory.fillSpec.cave = [{x,z,yTop,yBot}]), then seal the
// tunnel and pillar up the shaft, filling it behind itself.
ctx.caveFillMission = async function () {
  if (S.caveMode) return;
  S.caveMode = true; S.soloAbort = false; S.desiredState = 'busy'; S.activityLabel = '空洞ふさぎ中';
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const spec = memory.fillSpec && Array.isArray(memory.fillSpec.cave) ? memory.fillSpec.cave : null;
  const EX = 177, EZ = -109; // the morning's plugged shaft
  let filled = 0, colsDone = 0, entered = false;
  let lastProgressAt = Date.now();
  const scanCol = (col) => { const a = []; for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava') a.push(y); } return a; };
  const pillarOnce = async (x, z) => {
    const p = bot.entity.position;
    const by = Math.floor(p.y);
    const item = bot.inventory.items().find(i => i.name === 'dirt');
    if (!item) return false;
    try { await bot.equip(item, 'hand'); } catch {}
    if (!bot.heldItem || bot.heldItem.name !== 'dirt') return false;
    const ref = bot.blockAt(new Vec3(x, by - 1, z));
    if (!ref || ref.boundingBox !== 'block') return false;
    bot.setControlState('jump', true);
    let ok = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      await wait(40);
      if (bot.entity.position.y > by + 0.9) { try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); ok = true; } catch {} break; }
    }
    bot.setControlState('jump', false);
    await wait(350);
    const cell = bot.blockAt(new Vec3(x, by, z));
    return ok && !!cell && cell.name === 'dirt' && Math.floor(bot.entity.position.y) >= by + 1;
  };
  try {
    if (!spec || !spec.length) { ctx.say('空洞の場所が分からない'); return; }
    ctx.say('小屋の下の空洞を埋めに行くね');
    // Fill material: ~260 cells. The chest held only 59 dirt,
    // so cobblestone counts too (the fill is underground and
    // invisible), and the west scrape patch tops it up. A small
    // dirt reserve is kept for the exit (tunnel seal + pillars).
    try { await ctx.depositToChest(); } catch {}
    try { await ctx.withdrawFromChest('dirt', 256); } catch {}
    try { await ctx.withdrawFromChest('cobblestone', 128); } catch {}
    S.desiredState = 'busy';
    const fillTotal = () => ctx.countItem('dirt') + ctx.countItem('cobblestone');
    if (fillTotal() < 220) {
      const sc = (memory.fillSpec && memory.fillSpec.scrape) || { x0: 156, x1: 168, z0: -112, z1: -96 };
      console.log('[cave] scraping dirt at the west patch');
      const scrapeUntil = Date.now() + 300000;
      for (let x = sc.x0; x <= sc.x1 && fillTotal() < 264 && Date.now() < scrapeUntil; x++) for (let z = sc.z0; z <= sc.z1 && fillTotal() < 264 && Date.now() < scrapeUntil; z++) {
        if (!S.caveMode || S.soloAbort) break;
        const gy = ctx.groundYAt(x, z, 74);
        if (gy < 0) continue;
        const b = bot.blockAt(new Vec3(x, gy, z));
        const above = bot.blockAt(new Vec3(x, gy + 1, z));
        if (b && (b.name === 'dirt' || b.name === 'grass_block') && above && above.boundingBox === 'empty') {
          try { await ctx.gotoWatched(new goals.GoalNear(x, gy, z, 2), 20000, 'cave scrape'); await ctx.withTimeout(bot.dig(b), 20000, 'cave scrape dig'); await wait(400); } catch {}
        }
      }
      S.desiredState = 'busy';
    }
    console.log(`[cave] fill material on hand: dirt ${ctx.countItem('dirt')}, cobble ${ctx.countItem('cobblestone')}`);
    if (fillTotal() < 100) { ctx.say('材料が足りなくて空洞は無理だった'); return; }
    if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
      try { await ctx.pickaxeMission(); } catch {}
      S.desiredState = 'busy';
    }
    // ---- entry: stand on the plug and dig straight down ----
    try { await ctx.gotoWatched(new goals.GoalNear(EX, 70, EZ, 1), 30000, 'cave entry approach'); } catch {}
    try { await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalBlock(EX, 71, EZ)), 15000, 'cave entry step on'); } catch {}
    if (Math.floor(bot.entity.position.x) !== EX || Math.floor(bot.entity.position.z) !== EZ) { ctx.say('入口に立てなかった'); return; }
    for (let i = 0; i < 8; i++) {
      const p = bot.entity.position;
      if (Math.floor(p.x) !== EX || Math.floor(p.z) !== EZ) break;
      if (Math.floor(p.y) <= 65) { entered = true; break; }
      const below = bot.blockAt(new Vec3(EX, Math.floor(p.y) - 1, EZ));
      if (!below || below.boundingBox !== 'block') { entered = true; break; }
      try { await ctx.withTimeout(bot.dig(below), 30000, 'cave entry dig'); } catch (e) { console.log('[cave] entry dig:', e.message); break; }
      await wait(350);
    }
    if (!entered) { ctx.say('入口が掘れなかった'); return; }
    // Tunnel north into the cave space at (177,-107): dig the
    // feet and head cells of the (177,-108) wall.
    for (const wy of [65, 66]) {
      const wb = bot.blockAt(new Vec3(EX, wy, EZ + 1));
      if (wb && wb.boundingBox === 'block') { try { await ctx.withTimeout(bot.dig(wb), 30000, 'cave tunnel dig'); } catch {} await wait(300); }
    }
    try { await ctx.gotoWatched(new goals.GoalBlock(EX, 64, EZ + 2), 30000, 'cave step in'); } catch {}
    console.log(`[cave] inside at ${bot.entity.position}`);
    // ---- fill loop, nearest columns first, two passes ----
    const cols = spec.slice().sort((a, b) => (Math.abs(a.x - EX) + Math.abs(a.z - EZ)) - (Math.abs(b.x - EX) + Math.abs(b.z - EZ)));
    for (let pass = 0; pass < 2; pass++) {
      for (const col of cols) {
        if (!S.caveMode || S.soloAbort) break;
        if (Date.now() - lastProgressAt > 300000) { console.log('[cave] watchdog: no progress for 5 min — aborting'); ctx.say('進まなくなったから一旦出るね'); pass = 99; break; }
        let airs = scanCol(col);
        if (!airs.length) continue;
        try { await ctx.gotoWatched(new goals.GoalNear(col.x, col.yBot, col.z, 2), 45000, 'cave move'); } catch {}
        airs = scanCol(col);
        for (const y of airs) {
          if (!S.caveMode || S.soloAbort) break;
          // Dirt until the exit reserve (12), then cobblestone.
          const mat = ctx.countItem('dirt') > 12 ? 'dirt' : (ctx.countItem('cobblestone') > 0 ? 'cobblestone' : (ctx.countItem('dirt') > 0 ? 'dirt' : null));
          if (!mat) { console.log('[cave] out of fill material'); ctx.say('材料が尽きたから一旦出るね'); pass = 99; break; }
          const ok = await ctx.placeBlockAt(col.x, y, col.z, mat).catch(() => false);
          if (ok) { filled++; lastProgressAt = Date.now(); }
        }
        if (!scanCol(col).length) colsDone++;
      }
    }
    console.log(`[cave] fill done: ${filled} blocks, ${colsDone}/${cols.length} columns clear`);
    ctx.say(`空洞は${filled}マス埋めたよ。出るね`);
  } catch (e) { console.log('[cave] failed:', e.message); }
  finally {
    // ---- exit: seal the tunnel, pillar up the shaft ----
    if (entered) {
      try {
        try { await ctx.gotoWatched(new goals.GoalNear(EX, 65, EZ, 1), 45000, 'cave exit approach'); } catch {}
        // Seal the tunnel cells from the shaft side.
        for (const wy of [65, 66]) { await ctx.placeBlockAt(EX, wy, EZ + 1, 'dirt').catch(() => false); }
        // Step into the shaft column and pillar out.
        try { await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalBlock(EX, 65, EZ)), 15000, 'cave exit step in'); } catch {}
        let guard = 0;
        while (Math.floor(bot.entity.position.y) < 71 && guard++ < 10) {
          let ok = false;
          for (let t = 0; t < 3 && !ok; t++) ok = await pillarOnce(EX, EZ);
          if (!ok) { console.log('[cave] exit pillar failed at y=' + Math.floor(bot.entity.position.y)); break; }
        }
        console.log(`[cave] exited, bot at ${bot.entity.position}`);
      } catch (e) { console.log('[cave] exit:', e.message); }
    }
    try { await ctx.goHome(); } catch {}
    S.caveMode = false; S.activityLabel = '';
    if (S.desiredState === 'busy') S.desiredState = 'idle';
  }
};

// ---- cleanup: stray crafting tables + stray pond water ----
// (user request 2026-11-24: Yume solo, directed by Muze) Tables
// multiplied around the yard during laggy crafting sessions, and
// water ended up in odd places around the pond during the fill.
// Keep the one table inside the hut, dig up every other table
// near home, and remove every water cell outside the pond box
// (scoop sources into the pond, plug what will not scoop).
ctx.cleanupMission = async function () {
  if (S.cleanupMode) return;
  S.cleanupMode = true; S.desiredState = 'busy';
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const home = settings.home;
  let tablesDug = 0, waterGone = 0;
  try {
    ctx.say('片付けに行ってくるね');
    // ---- phase 1: stray crafting tables around home ----
    if (home) {
      // The keeper is the table inside the hut interior (3x3).
      let keep = null;
      for (let x = home.x - 1; x <= home.x + 1 && !keep; x++) for (let z = home.z - 1; z <= home.z + 1 && !keep; z++) {
        const b = bot.blockAt(new Vec3(x, home.y, z));
        if (b && b.name === 'crafting_table') keep = { x, y: home.y, z };
      }
      const strays = [];
      for (let x = home.x - 14; x <= home.x + 14; x++) for (let z = home.z - 14; z <= home.z + 14; z++) for (let y = home.y - 1; y <= home.y + 1; y++) {
        if (keep && x === keep.x && y === keep.y && z === keep.z) continue;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && b.name === 'crafting_table') strays.push({ x, y, z });
      }
      console.log(`[cleanup] tables: keep=${keep ? `${keep.x},${keep.y},${keep.z}` : 'none'} strays=${strays.length}`);
      for (const t of strays) {
        try { await ctx.gotoWatched(new goals.GoalNear(t.x, t.y, t.z, 2), 30000, 'cleanup table'); } catch {}
        const b = bot.blockAt(new Vec3(t.x, t.y, t.z));
        if (!b || b.name !== 'crafting_table') continue;
        try { await ctx.withTimeout(bot.dig(b), 20000, 'cleanup dig table'); tablesDug++; console.log(`[cleanup] dug stray table at ${t.x},${t.y},${t.z}`); } catch (e) { console.log('[cleanup] table dig:', e.message); }
        try { await ctx.gotoWatched(new goals.GoalNear(t.x, t.y, t.z, 1), 15000, 'cleanup pickup'); } catch {}
        await wait(400);
        if (bot.time && bot.time.timeOfDay > 10500) break;
      }
      ctx.say(`作業台は${tablesDug}個片付けたよ`);
    }
    // ---- phase 2: stray water around the pond ----
    const site = memory.spots && memory.spots.pond;
    if (site) {
      if (ctx.countItem('bucket') === 0 && ctx.countItem('water_bucket') === 0) {
        try { await ctx.withdrawFromChest('bucket', 1); } catch (e) { console.log('[cleanup] bucket withdraw:', e.message); }
      }
      try { await ctx.gotoWatched(new goals.GoalNear(site.ox - 1, site.floorY + 3, site.oz + 2, 2), 60000, 'cleanup to pond'); } catch {}
      const scanStrays = () => {
        const out = [];
        for (let x = site.ox - 6; x <= site.ox + 10; x++) for (let z = site.oz - 7; z <= site.oz + 7; z++) for (let y = site.floorY; y <= site.floorY + 5; y++) {
          const inPond = x >= site.ox && x <= site.ox + 4 && z >= site.oz && z <= site.oz + 4 && y >= site.floorY + 1 && y <= site.floorY + 2;
          if (inPond) continue;
          const b = bot.blockAt(new Vec3(x, y, z));
          if (b && b.name === 'water') out.push({ x, y, z, source: ctx.isSourceCell(x, y, z) });
        }
        // Sources first (removing them starves the flows), each
        // group top-down. The first live run sorted purely by
        // height and burned minutes trying to plug high FLOWING
        // cells whose exact-cell goals the pathfinder cannot reach.
        return out.sort((a, b2) => (b2.source - a.source) || (b2.y - a.y));
      };
      // Approach a cell loosely and report the distance left:
      // exact-cell goals over water / on rims stall the
      // pathfinder, so act from within reach instead.
      const nearCell = async (cell, range = 3) => {
        try { await ctx.gotoWatched(new goals.GoalNear(cell.x, cell.y, cell.z, range), 20000, 'cleanup near'); } catch {}
        const p = bot.entity.position;
        return Math.hypot(p.x - (cell.x + 0.5), p.y - cell.y, p.z - (cell.z + 0.5));
      };
      const emptyBucketIntoPond = async () => {
        if (ctx.countItem('water_bucket') === 0) return true;
        const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
        if (!wb) return false;
        try { await ctx.gotoWatched(new goals.GoalNear(site.ox + 2, site.floorY + 2, site.oz + 2, 3), 30000, 'cleanup dump approach'); } catch {}
        try { await bot.equip(wb, 'hand'); } catch {}
        try { await bot.lookAt(new Vec3(site.ox + 2.5, site.floorY + 2.4, site.oz + 2.5), true); } catch {}
        await wait(300);
        try { bot.activateItem(); } catch {}
        for (let i = 0; i < 10 && ctx.countItem('water_bucket') > 0; i++) await wait(500);
        return ctx.countItem('water_bucket') === 0;
      };
      const ensureDirt = async () => {
        if (ctx.countItem('dirt') > 0) return true;
        // Dig one DRY surface dirt/grass block somewhere around the
        // pond. The first version only searched the west rim —
        // which is exactly the flooded depression, so every
        // candidate was underwater and unreachable, and every plug
        // failed silently. Require air above the candidate.
        const cands = [];
        for (let x = site.ox - 8; x <= site.ox + 12; x++) for (let z = site.oz - 9; z <= site.oz + 9; z++) {
          if (x >= site.ox && x <= site.ox + 4 && z >= site.oz && z <= site.oz + 4) continue;
          const gy = ctx.groundYAt(x, z, site.floorY + 6);
          if (gy < 0) continue;
          const b = bot.blockAt(new Vec3(x, gy, z));
          const above = bot.blockAt(new Vec3(x, gy + 1, z));
          if (b && (b.name === 'dirt' || b.name === 'grass_block') && above && above.boundingBox === 'empty') cands.push({ x, y: gy, z });
        }
        const p0 = bot.entity.position;
        cands.sort((a, b2) => Math.hypot(a.x - p0.x, a.z - p0.z) - Math.hypot(b2.x - p0.x, b2.z - p0.z));
        for (const c of cands.slice(0, 5)) {
          try { await ctx.gotoWatched(new goals.GoalNear(c.x, c.y, c.z, 2), 20000, 'cleanup dirt'); await ctx.withTimeout(bot.dig(bot.blockAt(new Vec3(c.x, c.y, c.z))), 20000, 'cleanup dig dirt'); await nearCell(c, 1); await wait(600); } catch {}
          if (ctx.countItem('dirt') > 0) return true;
        }
        console.log('[cleanup] no dry dirt found for plugs');
        return false;
      };
      const ensureDirtStock = async (want) => {
        if (ctx.countItem('dirt') >= want) return true;
        try { await ctx.withdrawFromChest('dirt', want - ctx.countItem('dirt')); } catch {}
        // Scrape top-layer grass in one contained patch south-east
        // of the pond, so the dirt hunt leaves a single shallow
        // scrape instead of random holes.
        for (let x = site.ox + 2; x <= site.ox + 6 && ctx.countItem('dirt') < want; x++) for (let z = site.oz + 11; z <= site.oz + 15 && ctx.countItem('dirt') < want; z++) {
          const gy = ctx.groundYAt(x, z, site.floorY + 6);
          if (gy < 0) continue;
          const b = bot.blockAt(new Vec3(x, gy, z));
          const above = bot.blockAt(new Vec3(x, gy + 1, z));
          if (b && (b.name === 'grass_block' || b.name === 'dirt') && above && above.boundingBox === 'empty') {
            try { await ctx.gotoWatched(new goals.GoalNear(x, gy, z, 2), 20000, 'cleanup scrape'); await ctx.withTimeout(bot.dig(bot.blockAt(new Vec3(x, gy, z))), 20000, 'cleanup scrape dig'); await nearCell({ x, y: gy, z }, 1); await wait(400); } catch {}
          }
        }
        return ctx.countItem('dirt') > 0;
      };
      const plugCell = async (cell) => {
        if (!await ensureDirt()) return false;
        if (await nearCell(cell, 3) > 5) { console.log(`[cleanup] plug target ${cell.x},${cell.y},${cell.z} out of reach — skipping`); return false; }
        const ok = await ctx.placeBlockAt(cell.x, cell.y, cell.z, 'dirt').catch(() => false);
        if (!ok) return false;
        await wait(700);
        const b = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
        if (b && b.name === 'dirt') { try { await ctx.withTimeout(bot.dig(b), 20000, 'cleanup unplug'); } catch {} }
        await nearCell(cell, 1);
        const after = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
        return !!after && after.name !== 'water';
      };
      // A leftover water_bucket from an earlier run blocks every
      // scoop (the scoop branch requires an EMPTY bucket in hand).
      // Empty it into the pond before starting the passes.
      if (ctx.countItem('water_bucket') > 0) { const emptied = await emptyBucketIntoPond(); console.log(`[cleanup] pre-emptied the carried water bucket: ${emptied}`); }
      let plugOnly = ctx.countItem('bucket') === 0 && ctx.countItem('water_bucket') === 0;
      // High stacked cells (y70-71 over the rim) scoop cleanly from
      // the bank; try those first while the bucket is empty.
      if (!plugOnly) {
        const highs = scanStrays().filter(c => c.source && c.y >= site.floorY + 3);
        for (const cell of highs) {
          if (ctx.countItem('water_bucket') > 0) break;
          let done = false;
          try { done = await ctx.scoopWaterAt(cell); } catch (e) { console.log('[cleanup] scoop:', e.message); }
          if (done) {
            const stillThere = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
            if (stillThere && stillThere.name !== 'water') { waterGone++; console.log(`[cleanup] scooped high cell ${cell.x},${cell.y},${cell.z}`); }
          }
          await wait(300);
        }
        if (ctx.countItem('water_bucket') > 0) await emptyBucketIntoPond();
      }
      // Fill-in passes: place dirt INTO each remaining stray cell
      // and LEAVE it. The plug-then-dig version never worked —
      // placeBlockAt refused water cells outright until 'water'
      // joined REPLACEABLE_CELLS — and a filled spill basin is
      // walkable ground again, which is the point of the cleanup.
      let filled = 0;
      for (let pass = 0; pass < 6; pass++) {
        const strays = scanStrays().sort((a, b2) => (a.y - b2.y) || (Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z) - Math.hypot(b2.x - bot.entity.position.x, b2.z - bot.entity.position.z)));
        console.log(`[cleanup] fill pass ${pass}: ${strays.length} stray cells, dirt=${ctx.countItem('dirt')}`);
        if (!strays.length) break;
        if (bot.time && bot.time.timeOfDay > 10500) { console.log('[cleanup] dusk — stopping water work'); break; }
        if (!await ensureDirtStock(40)) { console.log('[cleanup] no dirt available — stopping fills'); break; }
        let progressed = false;
        for (const cell of strays.slice(0, 14)) {
          if (bot.time && bot.time.timeOfDay > 10500) break;
          if (ctx.countItem('dirt') === 0 && !await ensureDirtStock(40)) break;
          if (await nearCell(cell, 3) > 5.5) continue;
          const ok = await ctx.placeBlockAt(cell.x, cell.y, cell.z, 'dirt').catch(() => false);
          if (ok) { filled++; waterGone++; progressed = true; }
          await wait(250);
        }
        await wait(2000); // let flows settle before the re-scan
        if (!progressed) { console.log('[cleanup] no progress this pass — stopping'); break; }
      }
      console.log(`[cleanup] filled ${filled} cells with dirt`);
      const left = scanStrays().length;
      console.log(`[cleanup] water done: removed ${waterGone}, left ${left}`);
      ctx.say(`池のまわりの水は${waterGone}マス片付けたよ${left ? `（あと${left}マス残っちゃった）` : ''}`);
    }
    // ---- phase 3: home, deposit the spoils ----
    try { await ctx.goHome(); } catch {}
    try { await ctx.depositToChest(); } catch (e) { console.log('[cleanup] deposit:', e.message); }
    console.log(`[cleanup] done: tables=${tablesDug} water=${waterGone}`);
    ctx.say('片付け終わったよ');
    return true;
  } catch (e) {
    console.log('[cleanup] failed:', e.message);
    return false;
  } finally {
    S.cleanupMode = false;
    if (S.desiredState === 'busy') S.desiredState = 'idle';
  }
};

// ---- hole fill (user request 2026-11-24: Muze + Nemu + Yume
// fill the holes around/under the base together) ----
// The job spec lives in memory.fillSpec: { cols: [{x, z, yTop,
// yBot}], scrape: {x0, x1, z0, z1} }. The lead body publishes it
// as shared.fillJob; the partner claims columns from the same
// list via the life.js watcher (pondJob pattern). Columns are
// filled bottom-up where reachable; a column whose remaining air
// cannot be reached gets its top cells plugged so the surface is
// sealed. Fully enclosed deep pockets (no air near the top) are
// skipped — filling those would mean digging the base up.
ctx.fillHoleMission = async function (lead) {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (S.holeMode) return false;
  let job;
  if (lead) {
    const spec = memory.fillSpec;
    if (!spec || !Array.isArray(spec.cols) || !spec.cols.length) { ctx.say('ふさぐ場所が分からない'); return false; }
    job = { cols: spec.cols, scrape: spec.scrape || null, by: bot.username, at: Date.now(), claimed: {}, done: {} };
    shared.fillJob = job;
  } else {
    job = shared.fillJob;
    if (!job) return false;
  }
  S.holeMode = true; S.soloAbort = false; S.desiredState = 'busy'; S.activityLabel = '穴ふさぎ中';
  console.log(`[hole] fill start (${bot.username}, lead=${!!lead}): ${job.cols.length} columns`);
  if (lead) ctx.say('穴を埋めにいくね');
  // Start from a synced inventory: the held-item guard in
  // placeBlockAt fails constantly on a phantom view.
  try { await ctx.resyncViaChest(); } catch {}
  const stockDirt = async () => {
    if (ctx.countItem('dirt') >= 12) return true;
    try { await ctx.withdrawFromChest('dirt', 48 - ctx.countItem('dirt')); } catch {}
    S.desiredState = 'busy';
    await wait(1200);
    if (ctx.countItem('dirt') >= 12) return true;
    const sc = job.scrape;
    if (sc) {
      for (let x = sc.x0; x <= sc.x1 && ctx.countItem('dirt') < 32; x++) for (let z = sc.z0; z <= sc.z1 && ctx.countItem('dirt') < 32; z++) {
        const gy = ctx.groundYAt(x, z, 76);
        if (gy < 0) continue;
        const b = bot.blockAt(new Vec3(x, gy, z));
        const above = bot.blockAt(new Vec3(x, gy + 1, z));
        if (b && (b.name === 'grass_block' || b.name === 'dirt') && above && above.boundingBox === 'empty') {
          try { await ctx.gotoWatched(new goals.GoalNear(x, gy, z, 2), 20000, 'hole scrape'); await ctx.withTimeout(bot.dig(bot.blockAt(new Vec3(x, gy, z))), 20000, 'hole scrape dig'); await wait(500); } catch {}
        }
      }
    }
    return ctx.countItem('dirt') > 0;
  };
  const stockGravity = async () => {
    const have = () => ctx.countItem('sand') + ctx.countItem('gravel');
    if (have() >= 4) return true;
    try { await ctx.withdrawFromChest('sand', 32); } catch {}
    try { await ctx.withdrawFromChest('gravel', 32); } catch {}
    S.desiredState = 'busy';
    // No lake harvest: four live runs failed to dig a single
    // block there (the pathfinder cannot work the shore), so
    // gravity fill is opportunistic — when no sand/gravel is on
    // hand, deep columns use descendFill instead.
    return have() > 0;
  };
  const fillColumn = async (col) => {
    let placed = 0;
    // Rim positioning (2026-11-24, from the test-shaft failure):
    // a GoalNear on the target cell lets the pathfinder stand
    // the bot ON the fresh fill inside a 1-wide shaft — and the
    // server refuses every placement into the bot's own feet
    // cell, so the column died with its top cells open. Always
    // work from a solid rim cell beside the column instead.
    const rimGoto = async (label) => {
      const dist = Math.hypot(bot.entity.position.x - col.x, bot.entity.position.z - col.z);
      const tmo = dist > 30 ? 90000 : 20000;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = col.x + dx, nz = col.z + dz;
        const g = bot.blockAt(new Vec3(nx, col.yTop, nz));
        const a = bot.blockAt(new Vec3(nx, col.yTop + 1, nz));
        if (g && g.boundingBox === 'block' && a && a.boundingBox === 'empty') {
          try { await ctx.gotoWatched(new goals.GoalNear(nx, col.yTop, nz, 1), tmo, label); } catch {}
          return;
        }
      }
      try { await ctx.gotoWatched(new goals.GoalNear(col.x, col.yTop, col.z, 3), tmo, label); } catch {}
    };
    await rimGoto('hole rim');
    // Descend fill for open, deep columns (2026-11-24): when no
    // gravity blocks are on hand, dig straight down the SOLID
    // neighbour column, place dirt sideways into the target
    // column level by level, and pillar back up — the pillar
    // blocks fill the neighbour shaft behind the bot, so both
    // columns end up solid and the bot walks off the top.
    // Needs: a pickaxe, a fully solid neighbour column (scanned
    // first — never dig down into the unknown), and enough dirt
    // for both columns.
    const descendFill = async () => {
      let lowest = null;
      for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && b.boundingBox === 'empty' && b.name !== 'water') { lowest = y; break; } }
      const topB = bot.blockAt(new Vec3(col.x, col.yTop, col.z));
      if (!topB || topB.boundingBox !== 'empty' || lowest === null || col.yTop - lowest < 4) return false;
      if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
        // Same borrow as the rescue: craft a wooden pickaxe on
        // the spot instead of giving up (the bot's own pickaxe
        // had been deposited into the chest at a mission's end).
        try { await ctx.pickaxeMission(); } catch (e) { console.log('[hole] descendFill pickaxe:', e.message); }
        S.desiredState = 'busy';
        if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) { console.log('[hole] descendFill: no pickaxe'); return false; }
      }
      let dir = null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let solid = true;
        for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x + dx, y, col.z + dz)); if (!b || b.boundingBox !== 'block' || b.name === 'water' || b.name === 'lava') { solid = false; break; } }
        if (solid) { dir = { dx, dz }; break; }
      }
      if (!dir) { console.log(`[hole] descendFill: no solid neighbour column for ${col.x},${col.z}`); return false; }
      const depth = col.yTop - col.yBot + 1;
      if (ctx.countItem('dirt') < depth * 2 + 2 && !await stockDirt()) return false;
      if (ctx.countItem('dirt') < depth + 2) { console.log('[hole] descendFill: not enough dirt'); return false; }
      const nx = col.x + dir.dx, nz = col.z + dir.dz;
      console.log(`[hole] descendFill ${col.x},${col.z} via neighbour ${nx},${nz}, depth ${depth}`);
      // Stand on the neighbour column's top cell (GoalBlock =
      // feet in that exact cell, i.e. on top of the column).
      try { await ctx.gotoWatched(new goals.GoalNear(nx, col.yTop, nz, 1), 30000, 'hole descend approach'); } catch {}
      try { await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalBlock(nx, col.yTop + 1, nz)), 15000, 'hole descend step on'); } catch {}
      if (Math.floor(bot.entity.position.x) !== nx || Math.floor(bot.entity.position.z) !== nz) { console.log('[hole] descendFill: could not stand on the neighbour column'); return false; }
      // Dig straight down to yBot.
      const digDown = async () => {
        const t0 = Date.now();
        while (Math.floor(bot.entity.position.y) > col.yBot) {
          if (!S.holeMode || S.soloAbort) return false;
          if (Date.now() - t0 > 180000) { console.log('[hole] descend dig timeout'); return false; }
          const p = bot.entity.position;
          if (Math.floor(p.x) !== nx || Math.floor(p.z) !== nz) { console.log('[hole] descend dig: drifted off the shaft'); return false; }
          const below = bot.blockAt(new Vec3(nx, Math.floor(p.y) - 1, nz));
          if (!below || below.boundingBox !== 'block') { await wait(400); continue; }
          if (below.name === 'bedrock') return false;
          try { await ctx.withTimeout(bot.dig(below), 30000, 'hole descend dig'); } catch (e) { console.log('[hole] descend dig:', e.message); return false; }
          await wait(350);
        }
        return true;
      };
      if (!await digDown()) return false;
      const pillarUpOnce = async () => {
        const p = bot.entity.position;
        const bx = Math.floor(p.x), bz = Math.floor(p.z), by = Math.floor(p.y);
        const item = bot.inventory.items().find(i => i.name === 'dirt');
        if (!item) return false;
        try { await bot.equip(item, 'hand'); } catch {}
        if (!bot.heldItem || bot.heldItem.name !== 'dirt') return false;
        const ref = bot.blockAt(new Vec3(bx, by - 1, bz));
        if (!ref || ref.boundingBox !== 'block') return false;
        bot.setControlState('jump', true);
        let ok = false;
        const t0 = Date.now();
        while (Date.now() - t0 < 1500) {
          await wait(40);
          if (bot.entity.position.y > by + 0.9) {
            try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); ok = true; } catch {}
            break;
          }
        }
        bot.setControlState('jump', false);
        await wait(350);
        const cell = bot.blockAt(new Vec3(bx, by, bz));
        return ok && !!cell && cell.name === 'dirt' && Math.floor(bot.entity.position.y) >= by + 1;
      };
      // One jump-place is a coin flip under lag (it failed at
      // y=67 in the first live descend, stranding the climb);
      // three attempts make it dependable.
      const pillarUp = async () => {
        for (let t = 0; t < 3; t++) { if (await pillarUpOnce()) return true; await wait(400); }
        return false;
      };
      let filledTo = col.yBot - 1;
      for (let y = col.yBot; y <= col.yTop; y++) {
        if (!S.holeMode || S.soloAbort) break;
        if (ctx.countItem('dirt') === 0 && !await stockDirt()) break;
        const ok = await ctx.placeBlockAt(col.x, y, col.z, 'dirt').catch(() => false);
        if (!ok) { console.log(`[hole] descendFill: target place failed at y=${y}`); break; }
        filledTo = y;
        if (y < col.yTop && !await pillarUp()) { console.log(`[hole] descendFill: pillar failed at y=${y}`); break; }
      }
      placed += Math.max(0, filledTo - col.yBot + 1);
      // If we stopped early the bot may still be in the neighbour
      // shaft — pillar the rest of the way out (also its fill).
      let guard = 0;
      while (Math.floor(bot.entity.position.y) < col.yTop + 1 && guard++ < depth + 2) {
        if (!await pillarUp()) break;
      }
      console.log(`[hole] descendFill done: target filled to y=${filledTo}, bot at y=${Math.floor(bot.entity.position.y)}`);
      return filledTo >= col.yTop;
    };
    // Gravity pass for open, deep columns (2026-11-24): drop
    // sand/gravel in from the top — each block falls to the
    // bottom of the air column, so depth stops mattering.
    // placeBlockAt cannot confirm a fallen block (the top cell
    // is air again by the time it checks), so progress is
    // measured by re-scanning the column's air cells.
    {
      const countAir = () => { let n = 0; for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && b.boundingBox === 'empty' && b.name !== 'water') n++; } return n; };
      const topB = bot.blockAt(new Vec3(col.x, col.yTop, col.z));
      let lowest = null;
      for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && b.boundingBox === 'empty' && b.name !== 'water') { lowest = y; break; } }
      if (topB && topB.boundingBox === 'empty' && lowest !== null && col.yTop - lowest >= 4 && await stockGravity()) {
        console.log(`[hole] gravity fill for column ${col.x},${col.z} (depth ${col.yTop - lowest})`);
        const airStart = countAir();
        for (let g = 0; g < 40; g++) {
          if (!S.holeMode || S.soloAbort) break;
          const gb = ctx.countItem('sand') > 0 ? 'sand' : (ctx.countItem('gravel') > 0 ? 'gravel' : null);
          if (!gb) break;
          // Travel first: blockAt scans from far away read an
          // unloaded chunk as all-air and the pass died on the
          // spot after the lake run (2026-11-24, three runs).
          await rimGoto('hole gravity rim');
          const airBefore = countAir();
          if (airBefore === 0) break;
          await ctx.placeBlockAt(col.x, col.yTop, col.z, gb).catch(() => false);
          await wait(700);
          const airAfter = countAir();
          if (airAfter < airBefore) { if (airAfter === 0) break; continue; }
          break;
        }
        // Count from the start/end scans: per-drop deltas in a
        // laggy view inflated the total (9 reported for 5 real).
        placed += Math.max(0, airStart - countAir());
      }
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      if (!S.holeMode || S.soloAbort) break;
      const airs = [];
      for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava') airs.push(y); }
      if (!airs.length) {
        // An empty scan from far away means "chunk not loaded",
        // not "column full" — travel to the rim and scan again.
        const dcol = Math.hypot(bot.entity.position.x - col.x, bot.entity.position.z - col.z);
        if (dcol > 16 && !col._rescanned) { col._rescanned = true; await rimGoto('hole rescan travel'); continue; }
        break;
      }
      if (attempt === 0) {
        const topCell = bot.blockAt(new Vec3(col.x, col.yTop, col.z));
        const nearTopAir = airs.some((y) => y >= col.yTop - 6);
        if (!nearTopAir && topCell && topCell.boundingBox === 'block') { console.log(`[hole] column ${col.x},${col.z}: sealed deep pocket — skipping`); break; }
      }
      // Deep open column the gravity pass could not finish:
      // descend beside it and fill while climbing out.
      if (attempt === 0 && airs.length >= 4) {
        const doneDeep = await descendFill().catch(() => false);
        if (doneDeep) break;
        // Re-scan after a partial descend before the rim loop.
        const left = [];
        for (let y = col.yBot; y <= col.yTop; y++) { const b = bot.blockAt(new Vec3(col.x, y, col.z)); if (b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava') left.push(y); }
        if (!left.length) break;
      }
      // Capped column: solid lid with air below — dig the lid
      // cell open first, then the fill can proceed. Only before
      // we place anything (never dig our own plug back up) and
      // at most twice per column.
      {
        const topCell = bot.blockAt(new Vec3(col.x, col.yTop, col.z));
        if (placed === 0 && (col._capTries = (col._capTries || 0)) < 2 && topCell && topCell.boundingBox === 'block' && airs.length && !airs.includes(col.yTop)) {
          col._capTries++;
          try { await ctx.gotoWatched(new goals.GoalNear(col.x, col.yTop, col.z, 2), 20000, 'hole cap'); await ctx.withTimeout(bot.dig(topCell), 20000, 'hole cap dig'); await wait(400); } catch {}
          continue;
        }
      }
      let target = null;
      for (const y of airs) {
        const below = bot.blockAt(new Vec3(col.x, y - 1, col.z));
        const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = bot.blockAt(new Vec3(col.x + dx, y, col.z + dz)); return n && n.boundingBox === 'block'; });
        if ((below && below.boundingBox === 'block') || side) { target = y; break; }
      }
      if (target === null) target = airs[airs.length - 1];
      if (ctx.countItem('dirt') === 0 && !await stockDirt()) { console.log('[hole] out of dirt'); break; }
      // Work from the rim (see rimGoto): the old GoalNear on
      // the target cell put the bot inside the shaft, where
      // placements into its feet cell are refused.
      await rimGoto('hole approach');
      const ok = await ctx.placeBlockAt(col.x, target, col.z, 'dirt').catch(() => false);
      if (ok) { placed++; col._fails = 0; continue; }
      const topAir = airs[airs.length - 1];
      if (topAir !== target) {
        await rimGoto('hole plug rim');
        const ok2 = await ctx.placeBlockAt(col.x, topAir, col.z, 'dirt').catch(() => false);
        if (ok2) { placed++; col._fails = 0; continue; }
      }
      // One bad attempt no longer ends the column (a lag spike
      // used to abandon it half-filled); three in a row does.
      col._fails = (col._fails || 0) + 1;
      if (col._fails >= 3) { console.log(`[hole] column ${col.x},${col.z}: giving up after ${col._fails} failed attempts`); break; }
      await wait(1500);
    }
    return placed;
  };
  let totalPlaced = 0, colsDone = 0;
  let lastProgressAt = Date.now();
  let lastPos = bot.entity.position.clone();
  try {
    for (let idx = 0; idx < job.cols.length; idx++) {
      if (!S.holeMode || S.soloAbort) break;
      // Watchdog (2026-11-24): a body wedged in a pit once sat
      // "in mission" for minutes making no progress at all.
      // Abort if nothing has been placed and the body has not
      // moved for 4 minutes.
      if (Date.now() - lastProgressAt > 240000) { console.log('[hole] no progress for 4 min — aborting (watchdog)'); ctx.say('進まなくなっちゃったから一旦やめるね'); break; }
      if (bot.time && bot.time.timeOfDay > 11000) { console.log('[hole] dusk — stopping'); break; }
      if (job.claimed[idx]) continue;
      job.claimed[idx] = bot.username;
      const placed = await fillColumn(job.cols[idx]);
      job.done[idx] = placed;
      totalPlaced += placed; colsDone++;
      { const p2 = bot.entity.position; if (placed > 0 || p2.distanceTo(lastPos) > 4) { lastProgressAt = Date.now(); lastPos = p2.clone(); } }
      console.log(`[hole] column ${job.cols[idx].x},${job.cols[idx].z}: placed ${placed} (total ${totalPlaced})`);
    }
  } catch (e) { console.log('[hole] failed:', e.message); }
  try { await ctx.goHome(); } catch {}
  try { await ctx.depositToChest(); } catch {}
  S.holeMode = false;
  if (S.desiredState === 'busy') S.desiredState = 'idle';
  S.activityLabel = '';
  console.log(`[hole] done (${bot.username}): ${totalPlaced} blocks over ${colsDone} columns`);
  ctx.say(`穴埋め終わったよ（${totalPlaced}マス埋めた）`);
  return true;
};

ctx.makePond = async function () {
  if (S.pondMode) return;
  S.pondMode = true; S.fishingMode = false; S.desiredState = 'busy';
  const { Vec3 } = require('vec3');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    S.returningHome = false;
    try { bot.pathfinder.setGoal(null); } catch {}
    try { bot.clearControlStates(); } catch {}
    await wait(1500);
    ctx.say('陸に釣り池を掘って、水を運び入れるね');
    try { await ctx.prepareForMission(); } catch {}
    // A remembered site means a pond is already half-built: finish
    // it. (A far search once found natural open water ~190 blocks
    // away at (168,62,-7) and aborted the build — but bucket trips
    // need the NEAR river, and the pond's whole point is open water
    // close to home.) Walk to the site first, then find the nearest
    // water from there.
    const hasSite = !!(memory.spots && memory.spots.pond);
    let river = null;
    if (hasSite) {
      const s0 = memory.spots.pond;
      try { await ctx.gotoWatched(new goals.GoalNear(s0.ox + 2, s0.floorY + 3, s0.oz + 2, 4), 60000, 'pond to site'); } catch {}
      outer: for (let r = 0; r <= 24 && !river; r++) for (let dx = -r; dx <= r && !river; dx++) for (let dz = -r; dz <= r && !river; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let y = s0.floorY + 6; y >= s0.floorY - 4; y--) {
          const b = bot.blockAt(new Vec3(s0.ox + 2 + dx, y, s0.oz + 2 + dz));
          if (b && b.name === 'water') { river = { x: s0.ox + 2 + dx, y, z: s0.oz + 2 + dz }; break outer; }
        }
      }
      if (!river) {
        const near = await ctx.findFishingSpot({ searchFar: false });
        if (near && near.water) river = near.water;
      }
      if (!river && memory.spots && memory.spots.lake) {
        // The near stream dried up (its lone spring was scooped
        // during an early fill attempt — flow with no source decays
        // away). The remembered lake is the reference now; the fill
        // logic only needs a reference point, the well supplies the
        // actual water.
        const lk = memory.spots.lake;
        river = { x: lk.x, y: lk.y, z: lk.z };
        console.log('[pond] river reference: remembered lake');
      }
      if (!river) {
        const far = await ctx.findFishingSpot({ searchFar: true });
        if (far && far.water) river = far.water;
      }
      if (!river) { ctx.say('池の近くの川を見失った'); return; }
    } else {
      const base = await ctx.findFishingSpot({ searchFar: true });
      if (!base) { ctx.say('水場自体が見つからない'); return; }
      if (base.open) { ctx.say('もう開けた水域があるよ'); return; }
      river = base.water;
    }
    console.log(`[pond] river reference at ${river.x}, ${river.y}, ${river.z}`);
    // --- site: remembered pond, or a fresh flat 5x5 near the river ---
    let site = memory.spots && memory.spots.pond ? memory.spots.pond : null;
    if (!site) {
      const DIGGABLE = new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'coarse_dirt', 'podzol']);
      let best = null;
      for (let ox = river.x - 16; ox <= river.x + 16 && !best; ox++) for (let oz = river.z - 16; oz <= river.z + 16 && !best; oz++) {
        if (settings.home && Math.hypot(ox + 2 - settings.home.x, oz + 2 - settings.home.z) < 16) continue;
        const gys = [];
        let ok = true;
        for (let dx = 0; dx < 5 && ok; dx++) for (let dz = 0; dz < 5 && ok; dz++) {
          const gy = ctx.groundYAt(ox + dx, oz + dz, river.y + 2);
          if (gy < 0) { ok = false; break; }
          const top = bot.blockAt(new Vec3(ox + dx, gy, oz + dz));
          if (!top || !DIGGABLE.has(top.name)) { ok = false; break; }
          gys.push(gy);
        }
        if (!ok) continue;
        const mn = Math.min(...gys), mx = Math.max(...gys);
        if (mx - mn > 1) continue;
        best = { ox, oz, floorY: mn - 3 };
      }
      if (!best) { ctx.say('池にできそうな平らな場所が川の近くにない'); return; }
      site = best;
      memory.spots = memory.spots || {};
      memory.spots.pond = site;
      ctx.saveMemory();
      console.log(`[pond] site at (${site.ox}, ${site.oz}) floorY=${site.floorY}`);
    }
    const { ox, oz, floorY } = site;
    // --- dig the pit, in passes: sand/gravel columns collapse as
    // they are dug, dropping blocks BELOW the scan line of the pass
    // that dug them (the first live pit ended half-dug this way).
    // Re-scan the whole box each pass until it reads clean. ---
    const tool = bot.inventory.items().find(i => i.name.endsWith('_shovel')) || bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
    if (tool) { try { await bot.equip(tool, 'hand'); } catch {} }
    const solidInBox = () => {
      let n = 0;
      for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) for (let y = floorY + 1; y <= floorY + 3; y++) {
        const b = bot.blockAt(new Vec3(ox + dx, y, oz + dz));
        if (b && b.boundingBox === 'block' && b.name !== 'water') n++;
      }
      return n;
    };
    let dugTotal = 0;
    for (let pass = 0; pass < 4; pass++) {
      let dug = 0;
      for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
        const x = ox + dx, z = oz + dz;
        for (let y = floorY + 5; y > floorY; y--) {
          if (bot.time && bot.time.timeOfDay > 10500) { ctx.say('夕方だから池の工事は中断するね（続きはまた呼んで）'); console.log('[pond] dusk abort during dig'); return; }
          const b0 = bot.blockAt(new Vec3(x, y, z));
          if (!b0 || b0.boundingBox !== 'block' || b0.name === 'water') continue;
          try { await ctx.gotoWatched(new goals.GoalNear(x, y, z, 2), 20000, 'pond dig approach'); } catch {}
          const bb = bot.blockAt(new Vec3(x, y, z));
          if (!bb || bb.boundingBox !== 'block') continue;
          try { await ctx.withTimeout(bot.dig(bb), 30000, 'pond dig'); dug++; } catch (e) { console.log('[pond] dig failed:', e.message); }
        }
      }
      dugTotal += dug;
      await wait(2500); // let gravity blocks settle before the rescan
      const left = solidInBox();
      console.log(`[pond] dig pass ${pass + 1}: dug ${dug}, ${left} solid cells remain in the box`);
      if (left === 0) break;
      if (dug === 0 && pass >= 1) break; // no progress — the rest is unreachable from here
    }
    console.log(`[pond] pit dug: ${dugTotal} blocks total`);
    if (solidInBox() > 0) { ctx.say('池の穴が掘りきれなかった'); return; }
    // --- bucket ---
    if (!await ctx.ensureBucket()) { ctx.say('バケツが用意できなかった（鉄が足りない）'); return; }
    // --- fill: two layers of sources, carried one bucket at a time ---
    // Buckets only scoop SOURCE water (level 0, strict). The nearby
    // "river" turned out to be a mountain stream: all flow, fed by a
    // single source block on a ledge at (207,68,-154) — scooping it
    // would kill the stream and still fill nothing. So: if a real
    // water body is near, scoop there; otherwise build a 2x2
    // infinite well beside the pit, seeded with two sources fetched
    // from the far lake (one long trip, then short trips forever).
    const isSourceCell = (x, y, z) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b || b.name !== 'water') return false;
      try { const pr = b.getProperties(); return !!pr && (pr.level === 0 || pr.level === '0'); } catch { return false; }
    };
    const findSource = (c, rMax) => {
      for (let r = 0; r <= rMax; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, 2, -1, -2]) if (isSourceCell(c.x + dx, c.y + dy, c.z + dz)) return { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      }
      return null;
    };
    const countSourcesAround = (c) => {
      let n = 0;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) if (isSourceCell(c.x + dx, c.y + dy, c.z + dz)) n++;
      return n;
    };
    const scoopAt = async (target) => {
      // Approach the BANK beside the source, not the water cell
      // itself: a goal in the water makes gotoWatched give up in
      // under a second (the first fill run scooped from 25 blocks
      // away, far out of reach).
      let bank = null;
      for (const [bx, bz] of [[target.x + 1, target.z], [target.x - 1, target.z], [target.x, target.z + 1], [target.x, target.z - 1], [target.x + 1, target.z + 1], [target.x + 1, target.z - 1], [target.x - 1, target.z + 1], [target.x - 1, target.z - 1]]) {
        for (let by = target.y + 2; by >= target.y - 1 && !bank; by--) {
          const g = bot.blockAt(new Vec3(bx, by, bz));
          const above = bot.blockAt(new Vec3(bx, by + 1, bz));
          if (g && g.boundingBox === 'block' && g.name !== 'water' && (!above || above.boundingBox === 'empty')) bank = { x: bx, y: by, z: bz };
        }
        if (bank) break;
      }
      const dest = bank || target;
      try { await ctx.gotoWatched(new goals.GoalNear(dest.x, dest.y, dest.z, bank ? 1 : 2), 45000, 'pond to source'); }
      catch (e) { console.log('[pond] fill approach failed:', e.message, 'at', JSON.stringify(bot.entity.position)); }
      const dp = bot.entity.position;
      if (Math.hypot(dp.x - (target.x + 0.5), dp.z - (target.z + 0.5)) > 5) { console.log(`[pond] fill: still ${(Math.hypot(dp.x - target.x, dp.z - target.z)).toFixed(1)} blocks from the source — scoop skipped`); return false; }
      const before = ctx.countItem('water_bucket');
      const bucket = bot.inventory.items().find(i => i.name === 'bucket');
      if (!bucket) return false;
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
      try { await bot.equip(bucket, 'hand'); } catch {}
      try { await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.4, target.z + 0.5), true); } catch {}
      await wait(300);
      try { bot.activateItem(); } catch {}
      // The scoop's result can take many seconds to appear in the
      // client inventory on this laggy server (one live scoop was
      // written off as failed while the server already held the
      // water bucket — the re-read minutes later showed it). Poll
      // before concluding anything.
      for (let i = 0; i < 10 && ctx.countItem('water_bucket') === before; i++) await wait(500);
      if (ctx.countItem('water_bucket') === before) { const wb = bot.blockAt(new Vec3(target.x, target.y, target.z)); if (wb) { try { await bot.activateBlock(wb); } catch {} for (let i = 0; i < 6 && ctx.countItem('water_bucket') === before; i++) await wait(500); } }
      const ok = ctx.countItem('water_bucket') > before;
      if (ok) console.log(`[pond] bucket filled at ${target.x}, ${target.y}, ${target.z}`);
      return ok;
    };
    const placeSourceAt = async (x, y, z) => {
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur && cur.name === 'water') return true;
      try { await ctx.gotoWatched(new goals.GoalNear(x, y, z, 3), 30000, 'pond place approach'); } catch (e) { console.log('[pond] place approach failed:', e.message); }
      const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
      if (!wb) { console.log('[pond] place: no water_bucket in view'); return false; }
      try { await bot.equip(wb, 'hand'); } catch {}
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
      // Primary: aim at a solid neighbour's face and USE the bucket
      // (the vanilla pour — the mirror image of the scoop, which
      // works). The floor aim covers the bottom layer; the top layer
      // has water below, so there the pit WALL's face is the aim.
      // placeBlock() is only the fallback — the server silently
      // refused it for cell after cell ("the block is still air").
      const pourRefs = [new Vec3(x, y - 1, z), new Vec3(x + 1, y, z), new Vec3(x - 1, y, z), new Vec3(x, y, z + 1), new Vec3(x, y, z - 1)];
      for (const rp of pourRefs) {
        const rb = bot.blockAt(rp);
        if (!rb || rb.boundingBox !== 'block') continue;
        const aim = new Vec3((rp.x + x) / 2 + 0.5, (rp.y + y) / 2 + 0.4, (rp.z + z) / 2 + 0.5);
        try { await bot.lookAt(aim, true); } catch {}
        await wait(250);
        try { bot.activateItem(); } catch {}
        await wait(900);
        const after = bot.blockAt(new Vec3(x, y, z));
        if (after && after.name === 'water') return true;
      }
      { const after = bot.blockAt(new Vec3(x, y, z)); console.log(`[pond] pour at ${x},${y},${z} did not take (cell=${after && after.name}, held=${bot.heldItem && bot.heldItem.name}, pos=${JSON.stringify(bot.entity.position)})`); }
      const refs = [new Vec3(x, y - 1, z), new Vec3(x + 1, y, z), new Vec3(x - 1, y, z), new Vec3(x, y, z + 1), new Vec3(x, y, z - 1)];
      for (const rp of refs) {
        const rb = bot.blockAt(rp);
        if (!rb || rb.boundingBox !== 'block') continue;
        // NEVER placeBlock while holding anything but the water
        // bucket: with a desynced equip the hand can hold dug dirt,
        // and placeBlock then puts a DIRT block into the pond (this
        // actually happened, 2026-11-24 — five cells filled with
        // dirt during a fill run).
        if (!bot.heldItem || bot.heldItem.name !== 'water_bucket') { console.log('[pond] placeBlock skipped — not holding the water bucket'); break; }
        const face = new Vec3(x - rp.x, y - rp.y, z - rp.z);
        try { await ctx.withTimeout(bot.placeBlock(rb, face), 10000, 'place source'); } catch (e) { console.log('[pond] placeBlock failed:', e.message); continue; }
        await wait(600);
        const after = bot.blockAt(new Vec3(x, y, z));
        if (after && after.name === 'water') return true;
      }
      return false;
    };
    const buildWell = async () => {
      if (memory.spots && memory.spots.well && isSourceCell(memory.spots.well.x, memory.spots.well.y, memory.spots.well.z)) return memory.spots.well;
      if (bot.time && bot.time.timeOfDay > 9500) { console.log('[pond] well: too late in the day for the lake trip'); return null; }
      // Two buckets halve the lake trips; the partner carries one.
      if (ctx.countItem('bucket') + ctx.countItem('water_bucket') < 2) {
        try { await ctx.askPartnerFor('bucket', 1); } catch (e) { console.log('[pond] well: partner bucket failed:', e.message); }
      }
      const carried = Math.max(1, ctx.countItem('bucket') + ctx.countItem('water_bucket'));
      console.log(`[pond] well: building with ${carried} bucket(s)`);
      // Pick a flat 2x2 patch beside the pit and dig it 1 deep.
      const DIGGABLE = new Set(['dirt', 'grass_block', 'sand', 'gravel', 'stone', 'coarse_dirt', 'podzol']);
      let well = null;
      for (const [dxo, dzo] of [[-5, 0], [-5, 3], [2, 6], [6, 1], [-5, -3], [1, -5]]) {
        const wx = ox + dxo, wz = oz + dzo;
        const gys = [0, 1, 2, 3].map(i => ctx.groundYAt(wx + (i % 2), wz + Math.floor(i / 2), floorY + 4));
        if (gys.some(g => g < 0) || Math.max(...gys) !== Math.min(...gys)) continue;
        const tops = [0, 1, 2, 3].map(i => bot.blockAt(new Vec3(wx + (i % 2), gys[i], wz + Math.floor(i / 2))));
        if (tops.some(t => !t || !DIGGABLE.has(t.name))) continue;
        well = { x: wx, y: gys[0], z: wz };
        break;
      }
      if (!well) { console.log('[pond] well: no flat 2x2 patch near the pit'); return null; }
      for (let i = 0; i < 4; i++) {
        const cxp = well.x + (i % 2), czp = well.z + Math.floor(i / 2);
        try { await ctx.gotoWatched(new goals.GoalNear(cxp, well.y, czp, 2), 25000, 'well dig approach'); } catch {}
        const bb = bot.blockAt(new Vec3(cxp, well.y, czp));
        if (bb && bb.boundingBox === 'block') { try { await ctx.withTimeout(bot.dig(bb), 30000, 'well dig'); } catch (e) { console.log('[pond] well dig failed:', e.message); } }
      }
      console.log(`[pond] well dug at (${well.x}, ${well.y}, ${well.z})`);
      // Seed it: two sources on a diagonal, fetched from the far
      // lake. findFishingSpot alone is not enough here — it happily
      // returns the near stream as a fallback, whose only source is
      // the lone spring (scooping that kills the stream and seeds
      // nothing). Prefer the remembered lake; accept a searched spot
      // only if it is open water or clearly source-rich.
      let lakeSrc = null;
      if (memory.spots && memory.spots.lake) {
        const lk = memory.spots.lake;
        try { await ctx.gotoWatched(new goals.GoalNear(lk.x, lk.y, lk.z, 6), 90000, 'well to lake'); } catch {}
        await wait(1500);
        lakeSrc = findSource(lk, 12);
        if (lakeSrc) console.log(`[pond] well: remembered lake source at ${lakeSrc.x}, ${lakeSrc.y}, ${lakeSrc.z}`);
      }
      if (!lakeSrc) {
        const lake = await ctx.findFishingSpot({ searchFar: true });
        if (lake && lake.water) {
          const cand = findSource(lake.water, 8);
          if (cand && (lake.open || countSourcesAround(cand) >= 3)) lakeSrc = cand;
        }
        if (lakeSrc) console.log(`[pond] well: lake source at ${lakeSrc.x}, ${lakeSrc.y}, ${lakeSrc.z}`);
      }
      if (!lakeSrc) { console.log('[pond] well: no usable lake source'); return null; }
      const corners = [[well.x, well.z], [well.x + 1, well.z + 1]];
      let placedCorners = 0;
      // A water bucket already in hand IS seed source #1 — place it
      // before any lake trip. (The first version scooped first and
      // deadlocked whenever the only bucket was already full.)
      if (ctx.countItem('water_bucket') > 0) {
        const [cxp, czp] = corners[0];
        if (await placeSourceAt(cxp, well.y, czp)) placedCorners = 1;
      }
      for (let trip = 0; trip < 3 && placedCorners < 2; trip++) {
        let filled = 0;
        for (let s = 0; s < carried; s++) { if (await scoopAt(lakeSrc)) filled++; else break; }
        if (filled === 0) { console.log('[pond] well: could not scoop at the lake'); return null; }
        for (let s = 0; s < filled && placedCorners < 2; s++) {
          const [cxp, czp] = corners[placedCorners];
          if (await placeSourceAt(cxp, well.y, czp)) placedCorners++;
          else { console.log('[pond] well: corner placement failed'); return null; }
        }
      }
      if (placedCorners < 2) return null;
      await wait(2000); // let the other two cells regenerate into sources
      memory.spots = memory.spots || {};
      memory.spots.well = well;
      ctx.saveMemory();
      console.log(`[pond] well ready at (${well.x}, ${well.y}, ${well.z})`);
      return well;
    };
    let fillSrc = null;
    const fillBucket = async () => {
      if (ctx.countItem('water_bucket') > 0) return true;
      if (ctx.countItem('bucket') === 0) return false;
      if (!fillSrc) {
        const near = findSource(river, 20);
        // Distance guard: on this server the client's world view
        // keeps STALE chunk data from places visited long ago, so a
        // "source" can be found 115 blocks away in a chunk that is
        // not even loaded. Only trust a source she is actually near
        // (one run set the far lake as fillSrc from stale data and
        // every scoop was skipped as out of reach).
        const dp0 = bot.entity.position;
        const nearDist = near ? Math.hypot(dp0.x - near.x, dp0.z - near.z) : 1e9;
        if (near && nearDist <= 48 && countSourcesAround(near) >= 3) { fillSrc = near; console.log(`[pond] fill source: nearby water body at ${near.x}, ${near.y}, ${near.z}`); }
        else {
          fillSrc = await buildWell();
          if (!fillSrc) { ctx.say('水を運ぶ元が作れなかった'); return false; }
        }
      }
      return await scoopAt(fillSrc);
    };
    const placeWater = async (x, y, z) => {
      const cur = bot.blockAt(new Vec3(x, y, z));
      if (cur && cur.name === 'water') return true;
      if (!await fillBucket()) { console.log('[pond] bucket fill failed'); return false; }
      return await placeSourceAt(x, y, z);
    };
    const bottomCells = [], topCells = [];
    for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
      if ((dx + dz) % 2 === 0) bottomCells.push([ox + dx, floorY + 1, oz + dz]);
      if (dx === 0 || dx === 2 || dx === 4) topCells.push([ox + dx, floorY + 2, oz + dz]);
    }
    // Cooperative fill (user request 2026-11-24): build/verify the
    // infinite well beside the pit, publish the dry cells as a
    // shared job, and haul water with BOTH bodies — the partner
    // pulls cells from the same queue instead of idling.
    const dryCells = [...bottomCells, ...topCells].filter(([x, y, z]) => { const c = bot.blockAt(new Vec3(x, y, z)); return !c || c.name !== 'water'; });
    const well = dryCells.length ? await ctx.ensureWellAtPond(ox, oz, floorY) : null;
    if (well && dryCells.length) {
      const job = { cells: dryCells, next: 0, src: well, pit: { ox, oz, floorY }, by: bot.username, at: Date.now() };
      shared.pondJob = job;
      console.log(`[pond] pair fill: ${dryCells.length} dry cells, well at ${well.x}, ${well.y}, ${well.z}`);
      ctx.say('井戸から二人で水を運んで池を埋めるね');
      await ctx.fillPondCells(job);
      if (shared.pondJob === job) shared.pondJob = null;
      const left = dryCells.filter(([x, y, z]) => { const c = bot.blockAt(new Vec3(x, y, z)); return !c || c.name !== 'water'; }).length;
      console.log(`[pond] pair fill done: ${dryCells.length - left}/${dryCells.length} cells now water`);
    } else {
      let placedW = 0, failedW = 0;
      for (const [x, y, z] of [...bottomCells, ...topCells]) {
        if (bot.time && bot.time.timeOfDay > 10500) { ctx.say('夕方だから池の工事は中断するね（続きはまた呼んで）'); console.log('[pond] dusk abort during fill'); return; }
        if (await placeWater(x, y, z)) placedW++; else failedW++;
      }
      console.log(`[pond] water placed: ${placedW} sources, ${failedW} failed`);
    }
    await wait(4000); // let the water settle
    memory.spots.water = { x: ox + 2, y: floorY + 2, z: oz + 2, at: Date.now() };
    ctx.saveMemory();
    const check = await ctx.findFishingSpot({ searchFar: false });
    if (check && check.open) ctx.say('釣り池ができたよ。レアも釣れるはず');
    else ctx.say('池は掘ったけど、開けた水域の条件にはまだ届いてないみたい');
  } catch (e) { console.log('[pond] error:', e.message); }
  finally { S.pondMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}

// ---- sleep ----
ctx.goSleep = async function () {
  const bedNames = Object.keys(bot.registry.blocksByName).filter(n => n.endsWith('_bed'));
  const pos = ctx.findBlocks(bedNames, 32, 1);
  if (!pos.length) { ctx.say('近くにベッドが見つからない'); return; }
  const bed = bot.blockAt(pos[0]);
  try { S.desiredState = 'busy'; await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)); await bot.sleep(bed); ctx.say('寝たよ。おやすみ'); }
  catch (e) { ctx.fail('寝れなかった', e); } finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}

// ---- solo survival ----
ctx.soloSurvival = async function () {
  if (S.soloMode) { ctx.say('もうソロで動いてるよ'); return; }
  S.soloMode = true; S.soloAbort = false; S.nightMode = false;
  await ctx.prepareForMission().catch(() => {});
  const started = Date.now(); const LIMIT = 8 * 60 * 1000;
  const step = async (label, fn) => {
    if (S.soloAbort) throw new Error('stopped');
    if (Date.now() - started > LIMIT) throw new Error('timeout');
    ctx.say(label); console.log(`[solo] ${label}`);
    try { await fn(); console.log(`[solo] OK: ${label}`); return true; } catch (e) { console.log(`[solo] FAIL: ${label}: ${e.message}`); ctx.say(`スキップ: ${label}（${e.message.slice(0,60)}）`); return false; }
  };
  try {
    ctx.say('一人でサバイバルをはじめるよ');
    await step('木を探して原木を掘る', async () => {
      const countLogs = () => bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((a,i)=>a+i.count,0);
      await ctx.collectByNames(LOG_TYPES, 3, '原木');
      // Spawn surroundings vary per run; if no tree was reachable, relocate and retry.
      for (const [dx, dz] of [[20,0],[-20,10],[10,-20],[-15,-15]]) {
        if (countLogs() > 0 || S.soloAbort) break;
        console.log(`[solo] no logs yet, relocating by (${dx},${dz}) and retrying`);
        try { const p = bot.entity.position; await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)), 45000, 'relocate'); } catch (e) { console.log('[solo] relocate:', e.message); }
        await ctx.collectByNames(LOG_TYPES, 3, '原木');
      }
      if (!countLogs()) throw new Error('原木が1個も集まらなかった');
      console.log(`[solo] logs in inventory: ${countLogs()}`);
    });
    await step('原木を板材にする', async () => {
      const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
      if (!log) throw new Error('原木がない'); const plank = PLANK_OF[log.name];
      // Craft planks ONE log at a time: a multi-craft under lag desynced the grid and
      // produced a birch_button from a lone plank in testing. 1 craft = 1 log -> 4 planks.
      const nLogs = ctx.countItem(log.name);
      for (let i = 0; i < nLogs; i++) { if (!await ctx.craftItem(plank, 1)) { if (ctx.countItem(plank) >= 4) break; throw new Error('板材クラフト失敗'); } }
    });
    // Crafting table BEFORE sticks: recipesFor(crafting_table) rejected the recipe when planks
    // were split into uneven stacks after the stick craft (10 planks in 3 stacks, run9).
    await step('作業台を作る', async () => { if (ctx.countItem('crafting_table') === 0 && !await ctx.craftItem('crafting_table', 1)) throw new Error('作業台クラフト失敗'); });
    await step('棒を作る', async () => { if (!await ctx.craftItem('stick', 1)) throw new Error('棒クラフト失敗'); });
    await step('作業台を置く', async () => {
      // A table placed earlier may already stand nearby; check before demanding one in inventory.
      if (ctx.findCraftingTable()) return;
      // inventory sync can lag right after crafting; re-check a few times
      for (let i = 0; i < 3 && !bot.inventory.items().some(it => it.name === 'crafting_table'); i++) await new Promise(r => setTimeout(r, 1000));
      if (!bot.inventory.items().some(i => i.name === 'crafting_table')) throw new Error('作業台がない');
      if (ctx.findCraftingTable()) return;
      await ctx.placeItemOnGround('crafting_table');
    });
    await step('木のツルハシを作る', async () => { if (ctx.countItem('wooden_pickaxe') === 0 && !await ctx.craftItem('wooden_pickaxe', 1)) throw new Error('木ピッケル失敗'); });
    await step('石を掘る', async () => {
      const pick = bot.inventory.items().find(i => i.name.endsWith('_pickaxe')); if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      // Manual mining only (see mineStoneManual: collectblock vein-fill OOMs on stone).
      ctx.say('石を手掘りするね（露出した石を1個ずつ）');
      await ctx.mineStoneManual(3);
      if (ctx.countItem('cobblestone') < 3) throw new Error(`丸石が${ctx.countItem('cobblestone')}個しか集まらなかった`);
    });
    await step('石のツルハシを作る', async () => { if (ctx.countItem('stone_pickaxe') === 0 && !await ctx.craftItem('stone_pickaxe', 1)) throw new Error('石ピッケル失敗（丸石が足りない等）'); });
  } catch (e) { console.log('[solo] aborted:', e.message); ctx.say(`ソロ中断: ${e.message}`); }
  finally {
    S.soloMode = false;
    const inv = ctx.invList().join(', ') || 'なし';
    console.log(`[solo] finished inventory: ${inv}`); ctx.say(`ソロ終了。今の持ち物: ${inv.slice(0, 180)}`);
  }
}

// ---- wooden pickaxe mission (solo's opening chain, stops at the pickaxe) ----
ctx.pickaxeMission = async function () {
  if (S.pickaxeMode) { ctx.say('もうツルハシを作ってる途中だよ'); return; }
  if (ctx.countItem('wooden_pickaxe') > 0) { ctx.say('木のツルハシはもう持ってるよ'); const p = bot.inventory.items().find(i => i.name === 'wooden_pickaxe'); try { await bot.equip(p, 'hand'); } catch {} return; }
  S.pickaxeMode = true; S.soloAbort = false; S.nightMode = false;
  await ctx.prepareForMission().catch(() => {});
  const started = Date.now(); const LIMIT = 6 * 60 * 1000;
  const step = async (label, fn) => {
    if (S.soloAbort) throw new Error('stopped');
    if (Date.now() - started > LIMIT) throw new Error('timeout');
    ctx.say(label); console.log(`[pickaxe] ${label}`);
    await fn(); console.log(`[pickaxe] OK: ${label}`);
  };
  try {
    ctx.say('木のツルハシを作るね');
    await step('木を探して原木を掘る', async () => {
      const countLogs = () => bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((a, i) => a + i.count, 0);
      // 5 logs, not 3: on this slow CT a lagged craft can double-craft the table
      // (observed live: 2 tables ate 8 planks and the pickaxe starved at 2 planks).
      // Settle first: right after a (re)spawn the surrounding chunks are still
      // loading and findBlocks sees nothing (live 2026-11-23: 0 logs in 4 tries).
      await new Promise(r => setTimeout(r, 5000));
      await ctx.collectByNames(LOG_TYPES, 5, '原木');
      for (const [dx, dz] of [[20, 0], [-20, 10], [10, -20], [-15, -15], [45, 0], [-45, 20], [0, 45], [0, -45]]) {
        if (countLogs() > 0 || S.soloAbort) break;
        console.log(`[pickaxe] no logs yet, relocating by (${dx},${dz}) and retrying`);
        try { const p = bot.entity.position; await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)), 45000, 'relocate'); } catch (e) { console.log('[pickaxe] relocate:', e.message); }
        await ctx.collectByNames(LOG_TYPES, 5, '原木');
      }
      if (!countLogs()) throw new Error('原木が1個も集まらなかった');
    });
    await step('原木を板材にする', async () => {
      const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
      if (!log) throw new Error('原木がない'); const plank = PLANK_OF[log.name];
      const nLogs = ctx.countItem(log.name);
      for (let i = 0; i < nLogs; i++) { if (!await ctx.craftItem(plank, 1)) { if (ctx.countItem(plank) >= 4) break; throw new Error('板材クラフト失敗'); } }
    });
    await step('作業台を作る', async () => { if (ctx.countItem('crafting_table') === 0 && !ctx.findCraftingTable() && !await ctx.craftItem('crafting_table', 1)) throw new Error('作業台クラフト失敗'); });
    await step('棒を作る', async () => { if (ctx.countItem('stick') < 2 && !await ctx.craftItem('stick', 1)) throw new Error('棒クラフト失敗'); });
    await step('作業台を置く', async () => {
      // A table placed by an earlier run may already stand nearby; check that
      // BEFORE demanding a carried one (the inventory guard used to throw first).
      if (ctx.findCraftingTable()) return;
      for (let i = 0; i < 3 && !bot.inventory.items().some(it => it.name === 'crafting_table'); i++) await new Promise(r => setTimeout(r, 1000));
      if (!bot.inventory.items().some(i => i.name === 'crafting_table')) throw new Error('作業台がない');
      if (ctx.findCraftingTable()) return;
      // placeBlock can be refused on a marginal cell and placeItemOnGround gives
      // up on the first refusal; retry from slightly different stances.
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await ctx.placeItemOnGround('crafting_table'); } catch (e) { lastErr = e; console.log(`[pickaxe] place attempt ${attempt + 1} failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 800));
        if (ctx.findCraftingTable()) return;
        try { const p = bot.entity.position; await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + 2 - attempt, p.y, p.z + 1 + attempt, 1)), 20000, 'place shuffle'); } catch {}
      }
      if (lastErr) throw lastErr;
      throw new Error('作業台を置けなかった');
    });
    await step('木のツルハシを作る', async () => {
      if (ctx.countItem('wooden_pickaxe') > 0) return;
      // Top planks back up to >=3 before the pickaxe craft: convert leftover logs,
      // or go gather 2 more logs (the table double-craft can starve this step).
      const countPlanks = () => bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
      for (let round = 0; round < 2 && countPlanks() < 3; round++) {
        const lg = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
        if (lg) { await ctx.craftItem(PLANK_OF[lg.name], 1); }
        else {
          await ctx.collectByNames(LOG_TYPES, 2, '原木');
          const lg2 = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
          if (lg2) await ctx.craftItem(PLANK_OF[lg2.name], 1);
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
          try { const t = ctx.findCraftingTable(); if (t) await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(t.position.x, t.position.y, t.position.z, 1)), 20000, 'back to table'); } catch {}
        }
        crafted = await ctx.craftItem('wooden_pickaxe', 1);
      }
      if (!crafted) throw new Error('木ピッケル失敗');
    });
    const pick = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
    if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
    ctx.say('木のツルハシ、完成！');
    console.log('[pickaxe] MISSION COMPLETE');
  } catch (e) { console.log('[pickaxe] aborted:', e.message); ctx.say(`ツルハシ作り中断: ${e.message}`); }
  finally {
    S.pickaxeMode = false;
    const inv = ctx.invList().join(', ') || 'なし';
    console.log(`[pickaxe] finished inventory: ${inv}`); ctx.say(`今の持ち物: ${inv.slice(0, 170)}`);
  }
}

// ---- iron sword mission (think-and-do: full chain from empty inventory) ----
// Chain: logs -> planks/table/sticks -> wooden pick -> cobble x11 -> stone pick +
// furnace -> dig down scanning for iron ore -> mine raw iron -> smelt -> iron sword.
// Death aborts a run (S.soloAbort); the mission retries from the current inventory
// state a few times, since every step checks counts before acting.
ctx.digDownScanIron = async function (maxDepth = 44) {
  // Dig straight down (block below, like the proven solo stone method) and rescan
  // for iron ore at each level. findBlocks reads loaded chunk data, so buried ore
  // shows up within range before we reach it.
  for (let d = 0; d < maxDepth; d++) {
    if (S.soloAbort) return false;
    if (ctx.findBlocks(['iron_ore', 'deepslate_iron_ore'], 32, 3).length) return true;
    const y = Math.floor(bot.entity.position.y);
    if (y <= 14) break;
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.name === 'air' || below.name === 'bedrock') break;
    if (below.name === 'water' || below.name === 'lava') break;
    try {
      const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand');
      await ctx.withTimeout(bot.dig(below), 30000, 'dig down');
      await new Promise(r => setTimeout(r, 600));
    } catch (e) { console.log('[sword] dig down:', e.message); break; }
  }
  return ctx.findBlocks(['iron_ore', 'deepslate_iron_ore'], 32, 3).length > 0;
}
// Manual iron mining. Do NOT use collectblock for buried ore: reaching it makes
// collectblock flood-fill/search huge connected stone regions and OOM-killed the
// bot live (2026-11-13 run5). Instead walk/dig to scanned ore with bounded
// pathfinder goals and dig adjacent ore blocks one by one with the stone pick.
ctx.mineIronManual = async function (need = 3) {
  for (let round = 0; round < 14 && ctx.countItem('raw_iron') < need && !S.soloAbort; round++) {
    const poses = ctx.findBlocks(['iron_ore', 'deepslate_iron_ore'], 24, 6);
    if (!poses.length) {
      // Nothing scanned nearby: sink a few levels (rescan happens each level inside)
      const found = await ctx.digDownScanIron(5);
      if (!found && Math.floor(bot.entity.position.y) <= 14) {
        // At iron depth already: tunnel horizontally a few blocks and rescan.
        const base = bot.entity.position.floored();
        let advanced = false;
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const feet = bot.blockAt(base.offset(dx, 0, dz)); const head = bot.blockAt(base.offset(dx, 1, dz)); const floorB = bot.blockAt(base.offset(dx, -1, dz));
          if (!feet || !head || !floorB || floorB.boundingBox !== 'block') continue;
          try {
            const pick = bot.inventory.items().find(it => it.name.endsWith('_pickaxe')); if (pick) await bot.equip(pick, 'hand');
            if (feet.name !== 'air') await ctx.withTimeout(bot.dig(feet), 30000, 'tunnel feet');
            const head2 = bot.blockAt(base.offset(dx, 1, dz)); if (head2 && head2.name !== 'air') await ctx.withTimeout(bot.dig(head2), 30000, 'tunnel head');
            await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(base.x + dx, base.y, base.z + dz, 0)), 20000, 'tunnel step');
            advanced = true; break;
          } catch (e) { console.log('[iron] tunnel:', e.message); }
        }
        if (!advanced) break;
      }
      continue;
    }
    const ore = bot.blockAt(poses[0]);
    if (!ore) continue;
    try { await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2)), 60000, 'iron goto'); } catch (e) { console.log('[iron] goto:', e.message); }
    // Dig every ore block now adjacent (vein), with the stone pick equipped.
    for (let k = 0; k < 8; k++) {
      const near = ctx.findBlocks(['iron_ore', 'deepslate_iron_ore'], 4, 8).map(p => bot.blockAt(p)).filter(Boolean);
      if (!near.length) break;
      const pick = bot.inventory.items().find(i => i.name === 'stone_pickaxe') || bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
      if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
      try { await ctx.withTimeout(bot.dig(near[0]), 30000, 'dig iron'); } catch (e) { console.log('[iron] dig:', e.message); break; }
      await new Promise(r => setTimeout(r, 600));
    }
    await new Promise(r => setTimeout(r, 500));
    console.log(`[iron] raw_iron so far: ${ctx.countItem('raw_iron')}`);
  }
  return ctx.countItem('raw_iron');
}
ctx.smeltRawIronImpl = async function () {
  const raw = ctx.countItem('raw_iron');
  if (!raw) throw new Error('鉄鉱石（raw_iron）がない');
  let fpos = ctx.findBlocks(['furnace'], 16, 1);
  if (!fpos.length) {
    if (ctx.countItem('furnace') === 0 && !await ctx.craftItem('furnace', 1)) throw new Error('かまどが作れない（丸石8個）');
    await ctx.placeItemOnGround('furnace');
    await new Promise(r => setTimeout(r, 600));
    fpos = ctx.findBlocks(['furnace'], 16, 1);
    if (!fpos.length) throw new Error('かまどを置けたか確認できない');
  }
  const fblock = bot.blockAt(fpos[0]);
  await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(fblock.position.x, fblock.position.y, fblock.position.z, 2)), 45000, 'furnace goto');
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
    ctx.say(`精錬中…（鉄鉱石${raw}個）`);
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      if (S.soloAbort) throw new Error('stopped');
      const out = furnace.outputItem();
      if (out && out.count >= 2) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    const out = furnace.outputItem();
    if (out) { await furnace.takeOutput(); console.log(`[sword] smelted output: ${out.name} x${out.count}`); }
  } finally { try { furnace.close(); } catch {} }
  for (let i = 0; i < 10 && ctx.countItem('iron_ingot') < 2; i++) await new Promise(r => setTimeout(r, 1000));
  if (ctx.countItem('iron_ingot') < 2) throw new Error(`鉄インゴットが${ctx.countItem('iron_ingot')}個しかない`);
}
ctx.smeltRawIron = async function () { await ctx.acquireLock('furnace'); try { return await ctx.smeltRawIronImpl(); } finally { ctx.releaseLock('furnace'); } };
ctx.swordMission = async function () {
  if (S.swordMode) { ctx.say('もう鉄の剣を作ってる途中だよ'); return; }
  S.swordMode = true; S.nightMode = false;
  const started = Date.now(); const LIMIT = 25 * 60 * 1000;
  const step = async (label, fn) => {
    if (S.soloAbort) throw new Error('stopped');
    if (Date.now() - started > LIMIT) throw new Error('timeout');
    await ctx.checkDanger().catch(() => {});
    ctx.say(label); console.log(`[sword] ${label}`);
    try { await fn(); console.log(`[sword] OK: ${label}`); return true; } catch (e) { console.log(`[sword] FAIL: ${label}: ${e.message}`); ctx.say(`スキップ: ${label}（${e.message.slice(0, 60)}）`); return false; }
  };
  try {
    ctx.say('鉄の剣を一から作るよ。考えながら進めるね');
    for (let attempt = 1; attempt <= 3 && ctx.countItem('iron_sword') === 0; attempt++) {
      if (attempt > 1) { ctx.say(`再挑戦 ${attempt}回目（死んだ場所の近くに落ちた物は諦めて集め直す）`); await new Promise(r => setTimeout(r, 3000)); }
      S.soloAbort = false;
      const countLogs = () => bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((a, i) => a + i.count, 0);
      await step('原木を集める（目標7個）', async () => {
        // Skip when downstream progress already covers the wood budget (restarts
        // used to re-collect 7 logs even with a full stack of planks in hand).
        const plankTotal = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
        if (ctx.countItem('stone_pickaxe') > 0 || ctx.countItem('wooden_pickaxe') > 0 || plankTotal + countLogs() * 4 >= 16) { console.log(`[sword] wood already sufficient (planks ${plankTotal}, logs ${countLogs()})`); return; }
        if (countLogs() >= 7) return;
        await ctx.collectByNames(LOG_TYPES, 7 - countLogs(), '原木');
        for (const [dx, dz] of [[20, 0], [-20, 10], [10, -20]]) {
          if (countLogs() >= 4 || S.soloAbort) break;
          try { const p = bot.entity.position; await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)), 45000, 'relocate'); } catch {}
          await ctx.collectByNames(LOG_TYPES, 7 - countLogs(), '原木');
        }
        if (!countLogs()) throw new Error('原木が集まらなかった');
      });
      await step('板材にする', async () => {
        const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
        if (ctx.countItem('crafting_table') > 0 || bot.inventory.items().some(i => i.name.endsWith('_planks') && i.count >= 9)) return;
        if (!log) { if (bot.inventory.items().some(i => i.name.endsWith('_planks'))) return; throw new Error('原木も板材もない'); }
        const plank = PLANK_OF[log.name]; const n = ctx.countItem(log.name);
        for (let i = 0; i < n; i++) { if (!await ctx.craftItem(plank, 1) && i >= 2) break; }
        if (ctx.countItem(plank) < 4) throw new Error('板材が足りない');
      });
      await step('作業台を作って置く', async () => {
        if (ctx.countItem('crafting_table') === 0 && !ctx.findCraftingTable()) { if (!await ctx.craftItem('crafting_table', 1)) throw new Error('作業台クラフト失敗'); }
        if (!ctx.findCraftingTable() && ctx.countItem('crafting_table') > 0) await ctx.placeItemOnGround('crafting_table');
      });
      await step('棒を作る', async () => { if (ctx.countItem('stick') < 2 && !await ctx.craftItem('stick', 1)) throw new Error('棒クラフト失敗'); });
      await step('木のツルハシを作る', async () => { if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe')) && !await ctx.craftItem('wooden_pickaxe', 1)) throw new Error('木のツルハシ失敗'); });
      await step('丸石を11個集める', async () => {
        for (let r = 0; r < 4 && ctx.countItem('cobblestone') < 11 && !S.soloAbort; r++) await ctx.mineStoneManual(11 - ctx.countItem('cobblestone'));
        if (ctx.countItem('cobblestone') < 11) throw new Error(`丸石${ctx.countItem('cobblestone')}個どまり`);
      });
      await step('石のツルハシを作る', async () => { if (ctx.countItem('stone_pickaxe') === 0 && !await ctx.craftItem('stone_pickaxe', 1)) throw new Error('石のツルハシ失敗'); });
      await step('かまどを作る', async () => { if (ctx.countItem('furnace') === 0 && !ctx.findBlocks(['furnace'], 16, 1).length && !await ctx.craftItem('furnace', 1)) throw new Error('かまど失敗（丸石8個）'); });
      await step('鉄鉱石を探して掘る', async () => {
        if (ctx.countItem('raw_iron') >= 2 || ctx.countItem('iron_ingot') >= 2) return;
        // Hard gate: iron ore drops nothing with a wooden pick. If the stone pick
        // step failed earlier, redo cobble + stone pick right here instead of
        // wasting the run digging ore that cannot drop.
        if (ctx.countItem('stone_pickaxe') === 0) {
          ctx.say('石のツルハシがないので、先に作り直すね');
          for (let r = 0; r < 3 && ctx.countItem('cobblestone') < 3 && !S.soloAbort; r++) await ctx.mineStoneManual(3 - ctx.countItem('cobblestone'));
          if (ctx.countItem('stick') < 2) await ctx.craftItem('stick', 1);
          if (!await ctx.craftItem('stone_pickaxe', 1)) throw new Error('石のツルハシが作れず、鉄掘りに入れない');
        }
        const pick = bot.inventory.items().find(i => i.name === 'stone_pickaxe');
        if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
        await ctx.mineIronManual(3);
        if (ctx.countItem('raw_iron') < 2) throw new Error(`鉄鉱石が${ctx.countItem('raw_iron')}個しか見つからなかった`);
      });
      await step('鉄を精錬する', async () => { if (ctx.countItem('iron_ingot') < 2) await ctx.smeltRawIron(); });
      await step('鉄の剣を作る', async () => {
        if (ctx.countItem('stick') < 1) await ctx.craftItem('stick', 1);
        if (!await ctx.craftItem('iron_sword', 1)) throw new Error('鉄の剣クラフト失敗');
      });
      if (S.soloAbort) console.log(`[sword] attempt ${attempt} died/aborted`);
    }
    if (ctx.countItem('iron_sword') > 0) {
      const sw = bot.inventory.items().find(i => i.name === 'iron_sword');
      try { await bot.equip(sw, 'hand'); } catch {}
      ctx.say('鉄の剣、完成！ 手に持ったよ');
      console.log('[sword] MISSION COMPLETE: iron_sword');
    } else {
      ctx.say('鉄の剣まで届かなかった…。今の到達点はログに残したよ');
      console.log('[sword] MISSION INCOMPLETE');
    }
  } catch (e) { console.log('[sword] aborted:', e.message); ctx.say(`鉄の剣ミッション中断: ${e.message}`); }
  finally {
    S.swordMode = false;
    const inv = ctx.invList().join(', ') || 'なし';
    console.log(`[sword] finished inventory: ${inv}`); ctx.say(`今の持ち物: ${inv.slice(0, 170)}`);
  }
}

ctx.armorMission = async function () {
  if (S.armorMode || S.swordMode) { ctx.say('別のミッション中だよ'); return; }
  S.armorMode = true; S.nightMode = false;
  const started = Date.now(); const LIMIT = 60 * 60 * 1000;
  const missing = () => ARMOR_PLAN.filter(([name]) => ctx.countItem(name) === 0);
  const ingotsNeeded = () => missing().reduce((a, [, cost]) => a + cost, 0);
  try {
    ctx.say('次のミッションは鉄装備一式＋鉄のツルハシにするね。掘って・精錬して・作るを繰り返すよ');
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!missing().length) break;
      if (Date.now() - started > LIMIT) { ctx.say('時間切れで中断'); break; }
      S.soloAbort = false;
      // Ensure a stone pickaxe exists as the mining tool until the iron one is ready.
      if (ctx.countItem('stone_pickaxe') === 0 && ctx.countItem('iron_pickaxe') === 0) {
        for (let r = 0; r < 3 && ctx.countItem('cobblestone') < 3 && !S.soloAbort; r++) await ctx.mineStoneManual(3 - ctx.countItem('cobblestone'));
        if (ctx.countItem('stick') < 2) await ctx.craftItem('stick', 1);
        await ctx.craftItem('stone_pickaxe', 1);
      }
      for (let cycle = 0; cycle < 8 && missing().length && !S.soloAbort; cycle++) {
        if (Date.now() - started > LIMIT) break;
        await ctx.checkDanger().catch(() => {});
        const have = ctx.countItem('iron_ingot') + ctx.countItem('raw_iron');
        const need = ingotsNeeded() - have;
        console.log(`[armor] cycle ${cycle}: missing=${missing().map(m => m[0]).join(',')} ingots=${ctx.countItem('iron_ingot')} raw=${ctx.countItem('raw_iron')} need=${need}`);
        if (need > 0) {
          ctx.say(`鉄あと${need}個分を掘りに行くね`);
          const target = ctx.countItem('raw_iron') + Math.min(need, 12);
          for (let t = 0; t < 3 && ctx.countItem('raw_iron') < target && !S.soloAbort; t++) await ctx.mineIronManual(target);
        }
        if (ctx.countItem('raw_iron') > 0) { ctx.say('精錬するね'); try { await ctx.smeltRawIron(); } catch (e) { console.log('[armor] smelt:', e.message); ctx.say(`精錬で詰まった: ${e.message.slice(0, 60)}`); } }
        // Craft in plan order with whatever ingots are on hand.
        for (const [name, cost] of ARMOR_PLAN) {
          if (ctx.countItem(name) > 0) continue;
          if (ctx.countItem('iron_ingot') < cost) continue;
          if (name === 'iron_pickaxe' && ctx.countItem('stick') < 1) await ctx.craftItem('stick', 1);
          ctx.say(`${name}を作るね`);
          await ctx.craftItem(name, 1);
        }
        if (S.soloAbort) break;
      }
      if (S.soloAbort) console.log(`[armor] attempt ${attempt} died/aborted`);
    }
    const done = ARMOR_PLAN.filter(([n]) => ctx.countItem(n) > 0).map(([n]) => n);
    const left = missing().map(([n]) => n);
    try { if (bot.armorManager?.equipAll) await bot.armorManager.equipAll(); } catch {}
    if (ctx.countItem('iron_pickaxe') > 0) { const p = bot.inventory.items().find(i => i.name === 'iron_pickaxe'); try { await bot.equip(p, 'hand'); } catch {} }
    if (!left.length) { ctx.say('鉄装備一式＋鉄のツルハシ、完成！'); console.log('[armor] MISSION COMPLETE'); }
    else { ctx.say(`到達点: ${done.join(', ') || 'なし'}／残り: ${left.join(', ')}`); console.log(`[armor] MISSION INCOMPLETE: done=${done} left=${left}`); }
  } catch (e) { console.log('[armor] aborted:', e.message); ctx.say(`鉄装備ミッション中断: ${e.message}`); }
  finally {
    S.armorMode = false;
    const inv = ctx.invList().join(', ') || 'なし';
    console.log(`[armor] finished inventory: ${inv}`); ctx.say(`今の持ち物: ${inv.slice(0, 170)}`);
  }
}

};
