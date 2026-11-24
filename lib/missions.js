module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { LOG_TYPES, PLANK_OF, ARMOR_PLAN } = ctx.C;
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
      // Primary: aim at the floor block and USE the bucket (the
      // vanilla pour — the mirror image of the scoop, which works).
      // placeBlock() failed silently for all 28 cells of one run;
      // keep it only as the fallback.
      const floor = bot.blockAt(new Vec3(x, y - 1, z));
      if (floor && floor.boundingBox === 'block') {
        try { await bot.lookAt(new Vec3(x + 0.5, y - 0.6, z + 0.5), true); } catch {}
        await wait(250);
        try { bot.activateItem(); } catch {}
        await wait(900);
        const after = bot.blockAt(new Vec3(x, y, z));
        if (after && after.name === 'water') return true;
        console.log(`[pond] pour at ${x},${y},${z} did not take (cell=${after && after.name}, held=${bot.heldItem && bot.heldItem.name}, pos=${JSON.stringify(bot.entity.position)})`);
      }
      const refs = [new Vec3(x, y - 1, z), new Vec3(x + 1, y, z), new Vec3(x - 1, y, z), new Vec3(x, y, z + 1), new Vec3(x, y, z - 1)];
      for (const rp of refs) {
        const rb = bot.blockAt(rp);
        if (!rb || rb.boundingBox !== 'block') continue;
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
        if (near && countSourcesAround(near) >= 3) { fillSrc = near; console.log(`[pond] fill source: nearby water body at ${near.x}, ${near.y}, ${near.z}`); }
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
    let placedW = 0, failedW = 0;
    const bottomCells = [], topCells = [];
    for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
      if ((dx + dz) % 2 === 0) bottomCells.push([ox + dx, floorY + 1, oz + dz]);
      if (dx === 0 || dx === 2 || dx === 4) topCells.push([ox + dx, floorY + 2, oz + dz]);
    }
    for (const [x, y, z] of [...bottomCells, ...topCells]) {
      if (bot.time && bot.time.timeOfDay > 10500) { ctx.say('夕方だから池の工事は中断するね（続きはまた呼んで）'); console.log('[pond] dusk abort during fill'); return; }
      if (await placeWater(x, y, z)) placedW++; else failedW++;
    }
    console.log(`[pond] water placed: ${placedW} sources, ${failedW} failed`);
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
