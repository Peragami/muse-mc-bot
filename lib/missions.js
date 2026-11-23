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
      if (bank) { memory.spots.water = { x: op.x, y: op.y, z: op.z, at: Date.now() }; ctx.saveMemory(); console.log(`[fish] open-water spot at ${op} (treasure possible)`); return { water: op, bank, open: true }; }
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
        try { await ctx.goHome(); } catch (e) { console.log('[fish] goHome after session:', e.message); }
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
ctx.smeltRawIron = async function () {
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
