const shared = require('./shared');
module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { REPLACEABLE_CELLS, JP_ITEMS, DEPOSIT_KEEP, LOG_TYPES, PLANK_OF } = ctx.C;
// Place one block of itemName at the exact cell (x,y,z), using any solid
// neighbour as the reference. Moves closer first when out of reach.
ctx.placeBlockAt = async function (x, y, z, itemName) {
  const { Vec3 } = require('vec3');
  const target = new Vec3(x, y, z);
  const cell = bot.blockAt(target);
  if (cell && cell.name === itemName) return true;
  if (cell && !REPLACEABLE_CELLS.has(cell.name)) return false;
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error(`${itemName}不足`);
  const refs = [
    { b: bot.blockAt(target.offset(0, -1, 0)), f: new Vec3(0, 1, 0) },
    { b: bot.blockAt(target.offset(1, 0, 0)), f: new Vec3(-1, 0, 0) },
    { b: bot.blockAt(target.offset(-1, 0, 0)), f: new Vec3(1, 0, 0) },
    { b: bot.blockAt(target.offset(0, 0, 1)), f: new Vec3(0, 0, -1) },
    { b: bot.blockAt(target.offset(0, 0, -1)), f: new Vec3(0, 0, 1) },
    { b: bot.blockAt(target.offset(0, 1, 0)), f: new Vec3(0, -1, 0) },
  ].filter(r => r.b && r.b.boundingBox === 'block');
  if (!refs.length) { console.log(`[build] no reference block for ${itemName} at ${x},${y},${z}`); return false; }
  // Try EVERY solid neighbour, not just the first (2026-11-24):
  // interactive blocks (chest/furnace/table/bed) swallow the click by
  // opening a window instead of placing, and some faces are refused
  // from some positions — both silently killed placements all night.
  // Interactive refs go last, and any stray window is closed first.
  const interactive = (n) => n === 'chest' || n === 'furnace' || n === 'crafting_table' || n.endsWith('_bed');
  refs.sort((a, b) => (interactive(a.b.name) ? 1 : 0) - (interactive(b.b.name) ? 1 : 0));
  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4) {
    try { await ctx.gotoWatched(new goals.GoalNear(x, y, z, 3), 15000, 'build move'); } catch {}
  }
  // The equip can silently miss when the inventory view is a
  // phantom (the item looks present but the server disagrees),
  // and every placement then dies on "must be holding an item".
  // Verify the held item and re-equip from a fresh read instead
  // of trusting one equip call (2026-11-24).
  const ensureHeld = async () => {
    for (let t = 0; t < 3; t++) {
      if (bot.heldItem && bot.heldItem.name === itemName) return true;
      const it = bot.inventory.items().find(i => i.name === itemName);
      if (!it) return false;
      try { await bot.equip(it, 'hand'); } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    return !!(bot.heldItem && bot.heldItem.name === itemName);
  };
  // Act on a failed verification (audit 2026-11-25): if the item
  // cannot be confirmed in hand, placing is guaranteed to fail —
  // abort so the caller can resync instead of burning both rounds.
  if (!await ensureHeld()) { console.log(`[build] cannot hold ${itemName} at ${x},${y},${z} — aborting placement`); return false; }
  for (let round = 0; round < 2; round++) {
    if (round > 0) await ensureHeld();
    for (const ref of refs) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
      try { await ctx.withTimeout(bot.placeBlock(ref.b, ref.f), 10000, 'placeBlock'); } catch (e) { console.log(`[build] place ${itemName} at ${x},${y},${z} via ${ref.b.name}: ${e.message}`); continue; }
      await new Promise(r => setTimeout(r, 350));
      const after = bot.blockAt(target);
      if (after && after.name === itemName) return true;
    }
    // Every face failed — out of reach is the usual cause (Paper
    // silently drops the interaction, no block update at all; the
    // perimeter torches died this way). Step right up to the target
    // and try the faces once more.
    try { await ctx.gotoWatched(new goals.GoalNear(x, y, z, 1), 15000, 'build step closer'); } catch {}
  }
  return false;
}
// ---- expand the home chest into a double chest ----
// (user improvement 2026-11-24: the single chest is full.)
// The bot itself places the second chest beside the first —
// an operator setblock did NOT pair them (2026-11-24), but a
// real placement does when the facing matches: the existing
// chest faces south, so the bot stands south of the target
// cell (inside the hut) and places onto the floor, which makes
// the new chest face south too. Pairing is verified from the
// block props (type left/right) and the opened window size.
ctx.expandChest = async function () {
  const { Vec3 } = require('vec3');
  if (S.chestExpandMode) return;
  S.chestExpandMode = true; S.desiredState = 'busy';
  // Serialize against the partner's deposits/withdrawals on the
  // same chest (audit 2026-11-25). The lock is re-entrant per body,
  // so this flow's own withdrawFromChest calls stay safe.
  await ctx.acquireLock('chest');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    const home = settings.home;
    if (!home) { ctx.say('拠点が分からない'); return; }
    const cp = memory.chest || { x: home.x, y: home.y, z: home.z - 1 };
    const tx = cp.x + 1, ty = cp.y, tz = cp.z;
    const existing = bot.blockAt(new Vec3(cp.x, cp.y, cp.z));
    if (!existing || existing.name !== 'chest') { ctx.say('チェストが見つからない'); return; }
    if (existing.properties && existing.properties.type && existing.properties.type !== 'single') { ctx.say('もう二重になってるよ'); return; }
    const targetCell = bot.blockAt(new Vec3(tx, ty, tz));
    if (targetCell && targetCell.name === 'chest') { ctx.say('2個目はもう置いてある'); return; }
    if (targetCell && targetCell.boundingBox === 'block') { ctx.say('置く場所が空いてない'); return; }
    ctx.say('チェストを二重にするね');
    // 1) a chest item: withdraw one, else craft from planks.
    if (!bot.inventory.items().some(i => i.name === 'chest')) { try { await ctx.withdrawFromChest('chest', 1); } catch {} }
    if (!bot.inventory.items().some(i => i.name === 'chest')) {
      if (ctx.countItem('oak_planks') < 8) { try { await ctx.withdrawFromChest('oak_planks', 16); } catch {} }
      if (ctx.countItem('oak_planks') < 8 && ctx.countItem('oak_log') > 0) { try { await ctx.craftItem('oak_planks', 2); } catch {} }
      try { await ctx.craftItem('chest', 1); } catch (e) { console.log('[chest] craft:', e.message); }
    }
    if (!bot.inventory.items().some(i => i.name === 'chest')) { ctx.say('チェストが用意できなかった'); return; }
    S.desiredState = 'busy';
    // 2) stand south of the target cell, inside the hut.
    try { await ctx.gotoWatched(new goals.GoalNear(tx, ty, tz + 2, 1), 30000, 'chest expand position'); } catch {}
    // 3) place it (floor ref first — see placeBlockAt ordering).
    let ok = await ctx.placeBlockAt(tx, ty, tz, 'chest').catch(() => false);
    let placed = bot.blockAt(new Vec3(tx, ty, tz));
    if (!ok || !placed || placed.name !== 'chest') { ctx.say('チェストを置けなかった'); return; }
    let type = placed.properties && placed.properties.type;
    console.log(`[chest] placed second chest, type=${type}`);
    if (type === 'single') {
      // Facing did not match — dig it up and retry by clicking
      // the existing chest's east face directly.
      console.log('[chest] not paired — retrying against the existing chest face');
      try { await ctx.withTimeout(bot.dig(placed), 20000, 'chest expand undig'); await wait(600); } catch {}
      if (!bot.inventory.items().some(i => i.name === 'chest')) { try { await ctx.withdrawFromChest('chest', 1); } catch {} }
      const item = bot.inventory.items().find(i => i.name === 'chest');
      if (item) {
        try { await bot.equip(item, 'hand'); } catch {}
        const refB = bot.blockAt(new Vec3(cp.x, cp.y, cp.z));
        try { await ctx.gotoWatched(new goals.GoalNear(tx, ty, tz + 2, 1), 20000, 'chest expand position 2'); } catch {}
        try { await bot.lookAt(new Vec3(tx + 0.5, ty + 0.5, tz - 2)); } catch {}
        try { await ctx.withTimeout(bot.placeBlock(refB, new Vec3(1, 0, 0)), 10000, 'chest expand place 2'); } catch (e) { console.log('[chest] place 2:', e.message); }
        await wait(500);
        placed = bot.blockAt(new Vec3(tx, ty, tz));
        type = placed && placed.properties && placed.properties.type;
        console.log(`[chest] second try: name=${placed && placed.name} type=${type}`);
      }
    }
    // 4) final proof: open it — a double chest shows 54 slots.
    let slots = 0;
    try {
      const win = await ctx.withTimeout(bot.openChest(bot.blockAt(new Vec3(cp.x, cp.y, cp.z))), 15000, 'chest expand verify');
      slots = win.slots ? win.slots.length : 0;
      try { bot.closeWindow(win); } catch {}
    } catch (e) { console.log('[chest] verify open:', e.message); }
    console.log(`[chest] verify: type=${type} windowSlots=${slots}`);
    if (type && type !== 'single') { ctx.say('チェストを二重にしたよ（54マス）'); return true; }
    if (slots >= 90) { ctx.say('チェストを二重にしたよ（54マス）'); return true; }
    ctx.say('2個目は置けたけど連結は確認できなかった');
    return false;
  } catch (e) { console.log('[chest] expand failed:', e.message); return false; }
  finally { S.chestExpandMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; ctx.releaseLock('chest'); }
};
ctx.groundYAt = function (x, z, refY) {
  const { Vec3 } = require('vec3');
  for (let y = refY + 14; y > refY - 16; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.boundingBox === 'block') return y; }
  return -1;
}
// Smelt logs into charcoal with a placed furnace (for torches).
ctx.buildBase = async function () {
  if (S.baseMode) { ctx.say('もう作ってるよ'); return; }
  S.baseMode = true; S.soloAbort = false; S.nightMode = false;
  ctx.say('拠点を作るね。まず材料を集めるよ');
  await ctx.prepareForMission().catch(() => {});
  // The full build takes longer than one Minecraft day on this server, and
  // working in the open at night gets the bot killed (lost a full inventory
  // that way, 2026-11-23). Pause at nightfall and survive until dawn.
  const nightPause = async () => {
    if (bot.time && !bot.time.isDay) { ctx.say('夜になったから朝までやり過ごすね'); await ctx.nightSurvival(); }
  };
  try {
    await nightPause();
    // 1) logs (keep 5 unconverted for charcoal). Gather in small batches:
    // one big collect call keeps timing out its pathfinding on this server,
    // and the inventory count lags a few seconds behind a failed collect.
    const countLogs = () => LOG_TYPES.reduce((a, t) => a + ctx.countItem(t), 0);
    for (let round = 0; round < 8 && countLogs() < 26; round++) {
      const before = countLogs();
      await ctx.collectByNames(LOG_TYPES, Math.min(5, 26 - before), '原木', 40);
      await new Promise(r => setTimeout(r, 3000));
      if (countLogs() <= before && round >= 1) {
        const p = bot.entity.position; S.desiredState = 'busy';
        // Use its memory: if it remembers a forest spot, head there instead
        // of wandering randomly.
        const fs = memory.spots.forest;
        const useFs = fs && Math.hypot(fs.x - p.x, fs.z - p.z) > 12;
        if (useFs) console.log('[base] relocating to remembered forest spot');
        try { await ctx.gotoWatched(new goals.GoalNear(useFs ? fs.x : p.x + (Math.random() * 40 - 20), p.y, useFs ? fs.z : p.z + (Math.random() * 40 - 20), 3), 30000, 'relocate for logs'); } catch {}
        if (S.desiredState === 'busy') S.desiredState = 'idle';
      }
      if (S.soloAbort) return;
      await nightPause();
    }
    await new Promise(r => setTimeout(r, 2000));
    if (countLogs() < 22) { ctx.say('原木が足りなくて拠点は無理だった'); return; }
    // 2) wooden pickaxe (for cobblestone)
    if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) { await ctx.pickaxeMission(); }
    if (S.soloAbort) return;
    await nightPause();
    // 3) cobblestone for a furnace (one retry at a different spot: the soil
    // can be deeper than the excavator's 7-block probe)
    if (ctx.countItem('cobblestone') < 8) {
      await ctx.mineStoneManual(8 - ctx.countItem('cobblestone'));
      if (ctx.countItem('cobblestone') < 8 && !S.soloAbort) {
        const p = bot.entity.position; S.desiredState = 'busy';
        try { await ctx.gotoWatched(new goals.GoalNear(p.x + 14, p.y, p.z - 8, 3), 30000, 'relocate for stone'); } catch {}
        if (S.desiredState === 'busy') S.desiredState = 'idle';
        await ctx.mineStoneManual(8 - ctx.countItem('cobblestone'));
      }
    }
    if (S.soloAbort) return;
    await nightPause();
    // 4) mass-convert logs to planks (keep 4 logs for charcoal). Loop by
    // target count, not by live log counts: right after a craft the
    // inventory can momentarily read 0 logs (sync lag) and a count-driven
    // loop exits after a single craft (seen live 2026-11-23).
    const toConvert = Math.max(0, countLogs() - 4);
    let converted = 0, noProgress = 0;
    while (converted < toConvert && noProgress < 3) {
      const lt = LOG_TYPES.map(t => ({ t, c: ctx.countItem(t) })).sort((a, b) => b.c - a.c)[0];
      if (!lt || lt.c <= 0) { await new Promise(r => setTimeout(r, 2000)); noProgress++; continue; }
      const beforeLogs = countLogs();
      const ok = await ctx.craftItem(PLANK_OF[lt.t], 1);
      await new Promise(r => setTimeout(r, 1500));
      if (ok || countLogs() < beforeLogs) { converted++; noProgress = 0; } else noProgress++;
      if (S.soloAbort) return;
    }
    const plankType = Object.values(PLANK_OF).map(pn => ({ pn, c: ctx.countItem(pn) })).sort((a, b) => b.c - a.c)[0];
    if (!plankType || plankType.c < 55) { ctx.say(`板材が足りない（${plankType ? plankType.c : 0}枚）ので中止するね`); return; }
    const planks = plankType.pn;
    console.log(`[base] building with ${planks} x${plankType.c}`);
    // 5) crafts: furnace, sticks+charcoal+torches, door, chest, table, bed?
    if (ctx.countItem('crafting_table') === 0 && !ctx.findCraftingTable()) await ctx.craftItem('crafting_table', 1);
    if (ctx.countItem('furnace') === 0) await ctx.craftItem('furnace', 1);
    if (ctx.countItem('stick') < 4) await ctx.craftItem('stick', 1);
    if (ctx.countItem('furnace') > 0) {
      try { await ctx.placeItemOnGround('furnace'); await new Promise(r => setTimeout(r, 600)); if (ctx.countItem('charcoal') < 4) await ctx.smeltCharcoal(4); } catch (e) { console.log('[base] charcoal failed:', e.message); }
    }
    if (ctx.countItem('charcoal') >= 1 && ctx.countItem('stick') >= 1 && ctx.countItem('torch') < 4) await ctx.craftItem('torch', 1);
    const doorName = planks.replace('_planks', '_door');
    if (ctx.countItem(doorName) === 0) await ctx.craftItem(doorName, 1);
    if (ctx.countItem('chest') === 0) await ctx.craftItem('chest', 1);
    let bedName = null;
    if (ctx.countItem('white_wool') >= 3) { if (await ctx.craftItem('white_bed', 1)) bedName = 'white_bed'; }
    if (S.soloAbort) return;
    // 6) pick a flat 5x5 site near here
    const bp = bot.entity.position;
    let site = null;
    for (const [ox, oz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [10, 10], [-10, -10], [12, -6], [-12, 6]]) {
      const cx = Math.floor(bp.x) + ox, cz = Math.floor(bp.z) + oz;
      const ys = [];
      for (let x = cx; x < cx + 5; x++) for (let z = cz; z < cz + 5; z++) ys.push(ctx.groundYAt(x, z, Math.floor(bp.y)));
      if (ys.some(y => y < 0)) continue;
      const mn = Math.min(...ys), mx = Math.max(...ys);
      if (mx - mn <= 1) { site = { ox: cx, oz: cz, baseY: mx }; break; }
    }
    if (!site) { ctx.say('平らな場所が見つからなくて建てられなかった'); return; }
    const { ox, oz, baseY } = site;
    console.log(`[base] site at ${ox},${baseY},${oz}`);
    ctx.say(`場所が決まった（${ox}, ${baseY}, ${oz}）。建てるね`);
    S.desiredState = 'busy';
    // 7) foundation fill + walls (door gap on the south side, center)
    const doorX = ox + 2, doorZ = oz + 4;
    for (let x = ox; x < ox + 5; x++) for (let z = oz; z < oz + 5; z++) {
      const isPerim = x === ox || x === ox + 4 || z === oz || z === oz + 4;
      if (!isPerim) continue;
      const gy = ctx.groundYAt(x, z, baseY);
      for (let y = gy + 1; y <= baseY; y++) await ctx.placeBlockAt(x, y, z, planks).catch(() => false);
    }
    for (let row = 1; row <= 3; row++) {
      await nightPause(); S.desiredState = 'busy'; // nightSurvival restores 'idle'
      for (let x = ox; x < ox + 5; x++) for (let z = oz; z < oz + 5; z++) {
        const isPerim = x === ox || x === ox + 4 || z === oz || z === oz + 4;
        if (!isPerim) continue;
        if (x === doorX && z === doorZ && row <= 2) continue; // doorway
        await ctx.placeBlockAt(x, baseY + row, z, planks).catch(() => false);
        if (S.soloAbort) break;
      }
      if (S.soloAbort) break;
    }
    if (S.soloAbort) return;
    // 8) step inside, then roof
    try { await ctx.gotoWatched(new goals.GoalNear(ox + 2, baseY + 1, oz + 2, 1), 30000, 'enter base'); } catch (e) { console.log('[base] enter failed:', e.message); }
    for (let x = ox; x < ox + 5; x++) for (let z = oz; z < oz + 5; z++) { await ctx.placeBlockAt(x, baseY + 4, z, planks).catch(() => false); if (S.soloAbort) break; }
    if (S.soloAbort) return;
    // 9) door, furniture, torches
    if (ctx.countItem(doorName) > 0) await ctx.placeBlockAt(doorX, baseY + 1, doorZ, doorName);
    try { if (ctx.countItem('crafting_table') > 0) await ctx.placeItemOnGround('crafting_table'); } catch {}
    try { if (ctx.countItem('chest') > 0) await ctx.placeItemOnGround('chest'); } catch {}
    if (ctx.countItem('torch') > 0) { await ctx.placeBlockAt(ox + 2, baseY + 2, oz + 3, 'torch'); }
    if (ctx.countItem('torch') > 0) { await ctx.placeBlockAt(ox + 2, baseY + 2, oz + 1, 'torch'); }
    if (bedName && ctx.countItem(bedName) > 0) { try { await ctx.placeItemOnGround(bedName); } catch {} }
    if (S.desiredState === 'busy') S.desiredState = 'idle';
    // 10) register home
    settings.home = { x: ox + 2, y: baseY + 1, z: oz + 2 };
    ctx.saveSettings();
    try { ctx.findHomeChest(); } catch {}
    console.log(`[base] done. home=${JSON.stringify(settings.home)}`);
    ctx.say(`拠点ができたよ（${settings.home.x}, ${settings.home.y}, ${settings.home.z}）。夜はここに帰るね`);
  } catch (e) { console.log('[base] failed:', e.message); ctx.say('拠点づくりに失敗しちゃった'); }
  finally { S.baseMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}
// ---- base repair helpers (shared by the lead and the assisting body) ----
const repairCellMissing = (c) => { const { Vec3 } = require('vec3'); const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); return !b || b.name === 'air' || REPLACEABLE_CELLS.has(b.name); };
// Torch supply for the repair fittings: buildAssignedCells converts
// every log into planks, leaving nothing to smelt into charcoal —
// when the whole chain (logs -> charcoal -> torch) is dry, gather
// fresh logs first. (All five torch placements failed on this in
// repair #4, 2026-11-24.)
const ensureTorch = async () => {
  if (ctx.countItem('torch') > 0) return true;
  // The chest holds the base's coal and sticks — look there before
  // gathering and smelting from scratch (2026-11-25: the repair's
  // perimeter torches failed while the chest held coal and stick
  // x64, because this only ever checked the bot's own pockets).
  const wasBusyT = S.desiredState === 'busy';
  try { await ctx.withdrawFromChest('torch', 4); } catch {}
  if (ctx.countItem('torch') > 0) { if (wasBusyT && S.desiredState !== 'busy') S.desiredState = 'busy'; return true; }
  if (ctx.countItem('charcoal') === 0 && ctx.countItem('coal') === 0) { try { await ctx.withdrawFromChest('coal', 2); } catch {} }
  if (ctx.countItem('stick') === 0) { try { await ctx.withdrawFromChest('stick', 4); } catch {} }
  if (wasBusyT && S.desiredState !== 'busy') S.desiredState = 'busy'; // withdraw's finally clears it
  if (ctx.countItem('charcoal') === 0 && ctx.countItem('coal') === 0) {
    const logs = LOG_TYPES.reduce((a, t) => a + ctx.countItem(t), 0);
    if (logs === 0) { try { await ctx.collectByNames(LOG_TYPES, 2, '原木', 32); } catch {} }
    for (let s = 0; s < 2 && ctx.countItem('charcoal') === 0 && ctx.countItem('coal') === 0; s++) {
      try { await ctx.smeltCharcoal(1); } catch (e) { console.log('[repair] smeltCharcoal:', e.message); }
    }
  }
  if (ctx.countItem('stick') === 0) { try { await ctx.craftItem('stick', 1); } catch {} }
  try { await ctx.craftItem('torch', 1); } catch {}
  return ctx.countItem('torch') > 0;
};
// Gather planks and place the given blueprint cells, in cycles (one
// gathering phase under-delivers on this server, so re-survey the
// assigned subset each cycle). Returns { placed, planks, aborted }.
const buildAssignedCells = async (cells, margin) => {
  const nightPause = async () => { if (bot.time && !bot.time.isDay) { ctx.say('夜になったから朝までやり過ごすね'); await ctx.nightSurvival(); } };
  const countLogs = () => LOG_TYPES.reduce((a, t) => a + ctx.countItem(t), 0);
  const plankTotal = () => bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
  let placed = 0, planks = null;
  for (let cycle = 0; cycle < 4; cycle++) {
    let todo = cells.filter(repairCellMissing);
    if (!todo.length) break;
    const plankNeed = todo.length + margin;
    for (let round = 0; round < 10 && plankTotal() + countLogs() * 4 < plankNeed; round++) {
      const before = countLogs();
      await ctx.collectByNames(LOG_TYPES, 5, '原木', 40).catch(() => {});
      await new Promise(r => setTimeout(r, 2500));
      if (countLogs() <= before && round >= 1) {
        const fs = memory.spots.forest; const p = bot.entity.position;
        if (fs && Math.hypot(fs.x - p.x, fs.z - p.z) > 12) { try { await ctx.gotoWatched(new goals.GoalNear(fs.x, p.y, fs.z, 3), 30000, 'relocate for logs'); } catch {} }
      }
      if (S.soloAbort) return { placed, planks, aborted: true };
      await nightPause();
    }
    // One craft at a time: multi-craft under-delivers under this lag.
    for (let round = 0; round < 40 && plankTotal() < plankNeed; round++) {
      const lt = LOG_TYPES.map(t => ({ t, c: ctx.countItem(t) })).sort((a, b) => b.c - a.c)[0];
      if (!lt || lt.c <= 0) break;
      try { await ctx.craftItem(PLANK_OF[lt.t], 1); } catch {}
      await new Promise(r => setTimeout(r, 800));
      if (S.soloAbort) return { placed, planks, aborted: true };
    }
    const plankType = bot.inventory.items().filter(i => i.name.endsWith('_planks')).sort((a, b) => b.count - a.count)[0];
    if (!plankType) break;
    planks = plankType.name;
    console.log(`[repair] ${bot.username} cycle ${cycle + 1}: building with ${planks} x${plankType.count}, holes ${todo.length}`);
    await ctx.goHome();
    // Up to 3 passes: cells that lacked a reference neighbour get one
    // from an earlier pass (roof interior, cratered floor).
    for (let pass = 0; pass < 3; pass++) {
      todo = cells.filter(repairCellMissing);
      if (!todo.length) break;
      let passPlaced = 0;
      for (const c of todo) {
        if (ctx.countItem(planks) <= 0) break;
        const ok = await ctx.placeBlockAt(c.x, c.y, c.z, planks).catch(() => false);
        if (ok) { placed++; passPlaced++; }
        if (S.soloAbort) return { placed, planks, aborted: true };
      }
      console.log(`[repair] ${bot.username} pass ${pass + 1}: placed ${passPlaced}`);
      if (!passPlaced && pass >= 1) break;
      await nightPause();
    }
  }
  return { placed, planks, aborted: false };
};
// The buildBase blueprint as a flat cell list (foundation+floor, walls
// with the doorway skipped, roof). One source of truth: repairBase
// rebuilds from it and the damage watcher (life.js) diffs against it.
ctx.baseLayout = function (size) {
  if (!settings.home) return null;
  const home = settings.home;
  const sz = size || memory.baseSize || 5;
  const ox = home.x - Math.floor(sz / 2), oz = home.z - Math.floor(sz / 2), baseY = home.y - 1;
  return { size: sz, ox, oz, baseY, doorX: home.x, doorZ: oz + sz - 1 };
};
ctx.blueprintCells = function (size) {
  const L = ctx.baseLayout(size);
  if (!L) return [];
  const { size: sz, ox, oz, baseY, doorX, doorZ } = L;
  const cells = [];
  for (let x = ox; x < ox + sz; x++) for (let z = oz; z < oz + sz; z++) cells.push({ x, y: baseY, z });
  for (let row = 1; row <= 3; row++) for (let x = ox; x < ox + sz; x++) for (let z = oz; z < oz + sz; z++) {
    if (!(x === ox || x === ox + sz - 1 || z === oz || z === oz + sz - 1)) continue;
    if (x === doorX && z === doorZ && row <= 2) continue;
    // Open windows on the west/east walls of the larger base
    // (v2, 7x7): row-2 cells left out of the blueprint on
    // purpose, so repair never fills them in.
    if (sz >= 7 && row === 2 && (x === ox || x === ox + sz - 1) && (z === oz + 2 || z === oz + sz - 3)) continue;
    cells.push({ x, y: baseY + row, z });
  }
  for (let x = ox; x < ox + sz; x++) for (let z = oz; z < oz + sz; z++) cells.push({ x, y: baseY + 4, z });
  return cells;
}
// Level the hut interior: terrain bumps (dirt/gravel) poke up to the
// living level inside the 3x3, leaving no two flat adjacent cells —
// which is exactly why bed placement kept failing on 2026-11-23.
// Dig out every solid non-fixture block at home.y inside the hut.
ctx.levelInterior = async function () {
  if (!settings.home) return 0;
  const { Vec3 } = require('vec3');
  const home = settings.home;
  const keep = new Set(['chest', 'furnace', 'crafting_table']);
  let dug = 0;
  const LL = ctx.baseLayout();
  for (let x = LL.ox + 1; x < LL.ox + LL.size - 1; x++) for (let z = LL.oz + 1; z < LL.oz + LL.size - 1; z++) {
    let b = bot.blockAt(new Vec3(x, home.y, z));
    if (!b || b.name === 'air' || REPLACEABLE_CELLS.has(b.name) || keep.has(b.name) || b.name.endsWith('_bed')) continue;
    try {
      await ctx.gotoWatched(new goals.GoalNear(x, home.y, z, 2), 20000, 'level move');
      b = bot.blockAt(new Vec3(x, home.y, z));
      if (b && b.boundingBox === 'block') { await ctx.withTimeout(bot.dig(b), 20000, 'dig bump'); dug++; console.log(`[repair] leveled interior bump ${b.name} at ${x},${home.y},${z}`); }
    } catch (e) { console.log('[repair] level dig:', e.message); }
    await new Promise(r => setTimeout(r, 400));
  }
  if (dug) console.log(`[repair] interior leveled: ${dug} bumps dug out`);
  return dug;
}

// ---- base repair: re-place whatever the buildBase blueprint says ----
// should exist. After the 2026-11-23 creeper damage (71 of 96 structural
// cells gone, verified server-side), the user asked for a rebuild in
// place: survey against the blueprint, gather planks, re-place every
// missing cell, then restore the fittings (table, door, torches, bed).
// The surviving chest/furnace are left to the fixture system.
ctx.repairBase = async function () {
  if (S.repairMode) { ctx.say('もう建て直してる途中だよ'); return; }
  if (!settings.home) { ctx.say('拠点がまだないよ'); return; }
  if (bot.time && !bot.time.isDay) { ctx.say('夜は危ないから、朝になってから建て直すね'); return; }
  // Pair negotiation, same fix as buildBaseV2 (2026-11-25): the
  // first body to publish shared.repairJob leads; the other stands
  // down to helper instead of running a second lead flow whose
  // assist call bounces off this body's repairMode guard.
  if (shared.repairJob && Date.now() - (shared.repairJob.at || 0) < 15 * 60000) { ctx.say('相方がリードで建て直してるから、手伝いに回るね'); return; }
  if (!ctx.cfg.primary) {
    await new Promise(r => setTimeout(r, 4000));
    if (shared.repairJob && Date.now() - (shared.repairJob.at || 0) < 15 * 60000) { ctx.say('相方がリードで建て直してるから、手伝いに回るね'); return; }
    if (S.repairMode) return;
  }
  S.repairMode = true; S.soloAbort = false;
  shared.repairJob = { helperDone: false, at: Date.now(), lead: bot.username };
  const { Vec3 } = require('vec3');
  const home = settings.home;
  const L = ctx.baseLayout();
  const { ox, oz, baseY, doorX, doorZ } = L;
  const bsize = L.size;
  const nightPause = async () => { if (bot.time && !bot.time.isDay) { ctx.say('夜になったから朝までやり過ごすね'); await ctx.nightSurvival(); } };
  // Blueprint in build order: foundation+floor, walls (doorway skipped), roof.
  const blueprint = ctx.blueprintCells();
  const cellMissing = repairCellMissing;
  try {
    ctx.say('拠点を建て直すね。まず壊れ具合を調べるよ');
    await ctx.prepareForMission().catch(() => {});
    S.desiredState = 'busy';
    await ctx.goHome();
    let missing = blueprint.filter(cellMissing);
    console.log(`[repair] ${missing.length}/${blueprint.length} structural cells missing`);
    if (missing.length) ctx.say(`${missing.length}マス壊れてる。材料を集めてくるね`);
    // Split the work with the partner when she is free (the user wants
    // tasks done as pair work): she gathers and places her half in
    // parallel; the fittings below stay lead-only (single items in a
    // cramped interior). Interleaving the split spreads both halves
    // across the whole structure.
    let placed = 0;
    let planks = null;
    let helperStarted = false;
    const partner = ctx.partnerCtx();
    if (partner && partner.ctx && missing.length >= 2 && !partner.ctx.anyMissionActive()) {
      const theirs = missing.filter((_, i) => i % 2 === 1);
      const mine = missing.filter((_, i) => i % 2 === 0);
      shared.repairJob.helperDone = false;
      helperStarted = true;
      const pcall = (partner.cfg || {}).callName || partner.name;
      ctx.say(`${pcall}と分担して建て直すね`);
      console.log(`[repair] split: ${bot.username} ${mine.length} cells, ${partner.name} ${theirs.length} cells`);
      partner.ctx.repairAssist(theirs).catch(e => { console.log('[repair] assist call:', e.message); if (shared.repairJob) shared.repairJob.helperDone = true; });
      missing = mine;
    }
    const res = await buildAssignedCells(missing, 18);
    placed = res.placed; planks = res.planks;
    if (res.aborted) return;
    if (helperStarted) {
      for (let i = 0; i < 240 && shared.repairJob && !shared.repairJob.helperDone; i++) { await new Promise(r => setTimeout(r, 2000)); if (S.soloAbort) break; }
      console.log(`[repair] helper done=${shared.repairJob && shared.repairJob.helperDone}`);
      shared.repairJob = null;
    }
    // Verification pass (2026-11-24): the bot's block view holds
    // phantom blocks on this server — it once reported 0 holes while
    // the server counted 2. Walk away to force a chunk reload, come
    // back, re-survey with the fresh view, and place the stragglers.
    try {
      try { await ctx.gotoWatched(new goals.GoalNear(home.x + 48, home.y, home.z, 3), 40000, 'verify leave'); } catch {}
      await new Promise(r => setTimeout(r, 3000));
      await ctx.goHome();
      const stragglers = blueprint.filter(cellMissing);
      if (stragglers.length) {
        console.log(`[repair] verification pass: ${stragglers.length} stragglers after chunk reload`);
        const vres = await buildAssignedCells(stragglers, 6);
        placed += vres.placed; if (vres.planks) planks = vres.planks;
        if (vres.aborted) return;
      } else console.log('[repair] verification pass: no stragglers');
    } catch (e) { console.log('[repair] verification pass:', e.message); }
    if (!planks && blueprint.filter(cellMissing).length) { ctx.say('板材が用意できなかった'); return; }
    // Level the interior floor before the fittings: terrain bumps at
    // the living level are what kept the bed from ever fitting.
    try { await ctx.levelInterior(); } catch (e) { console.log('[repair] level:', e.message); }
    // Crafting table back inside. Its old cell turned out to be a dirt
    // floor bump (terrain rises to baseY+1 there), so instead of a
    // fixed cell: scan the interior, and if no table exists, stand in
    // the hut and put one down the way buildBase did.
    try {
      const scanTable = () => {
        for (let x = ox + 1; x < ox + bsize - 1; x++) for (let z = oz + 1; z < oz + bsize - 1; z++) {
          const b = bot.blockAt(new Vec3(x, baseY + 1, z));
          if (b && b.name === 'crafting_table') return b;
        }
        return null;
      };
      if (!scanTable()) {
        if (ctx.countItem('crafting_table') === 0) await ctx.craftItem('crafting_table', 1);
        if (ctx.countItem('crafting_table') > 0) { await ctx.goHome(); await ctx.placeItemOnGround('crafting_table'); }
        await new Promise(r => setTimeout(r, 800));
        if (!scanTable() && ctx.countItem('crafting_table') > 0) {
          // placeItemOnGround dropped it somewhere unhelpful (or the
          // placement silently failed): put it on an explicit free
          // interior cell instead, and say so in the log either way.
          let cell = null;
          for (let x = ox + 1; x < ox + bsize - 1 && !cell; x++) for (let z = oz + 1; z < oz + bsize - 1 && !cell; z++) {
            const b = bot.blockAt(new Vec3(x, baseY + 1, z)); const below = bot.blockAt(new Vec3(x, baseY, z));
            if (b && (b.name === 'air' || REPLACEABLE_CELLS.has(b.name)) && below && below.boundingBox === 'block') cell = { x, z };
          }
          if (cell) { console.log(`[repair] table fallback placement at ${cell.x},${baseY + 1},${cell.z}`); await ctx.placeBlockAt(cell.x, baseY + 1, cell.z, 'crafting_table').catch(() => false); }
        }
        console.log(`[repair] table: ${scanTable() ? 'ok' : 'FAILED'}`);
      }
    } catch (e) { console.log('[repair] table:', e.message); }
    // Door in the doorway.
    try {
      const doorPlanks = planks || (bot.inventory.items().filter(i => i.name.endsWith('_planks')).sort((a, b) => b.count - a.count)[0] || {}).name;
      if (!doorPlanks) throw new Error('no planks for a door');
      const doorName = doorPlanks.replace('_planks', '_door');
      const dc = bot.blockAt(new Vec3(doorX, baseY + 1, doorZ));
      if (!dc || dc.name === 'air' || REPLACEABLE_CELLS.has(dc.name)) {
        if (ctx.countItem(doorName) === 0) await ctx.craftItem(doorName, 1);
        if (ctx.countItem(doorName) > 0) await ctx.placeBlockAt(doorX, baseY + 1, doorZ, doorName);
      }
      // Verify the door actually hangs there; retry once if not.
      await new Promise(r => setTimeout(r, 600));
      let dv = bot.blockAt(new Vec3(doorX, baseY + 1, doorZ));
      if (!dv || !dv.name.endsWith('_door')) {
        if (ctx.countItem(doorName) === 0) { try { await ctx.craftItem(doorName, 1); } catch {} }
        if (ctx.countItem(doorName) > 0) await ctx.placeBlockAt(doorX, baseY + 1, doorZ, doorName).catch(() => false);
        await new Promise(r => setTimeout(r, 600));
        dv = bot.blockAt(new Vec3(doorX, baseY + 1, doorZ));
      }
      console.log(`[repair] door: ${dv && dv.name.endsWith('_door') ? 'ok' : 'FAILED'}`);
    } catch (e) { console.log('[repair] door:', e.message); }
    // Torches on the blueprint spots (charcoal smelted in the furnace).
    // Two full attempts with per-spot verification: on 2026-11-23 the
    // second spot failed silently and only a server-side survey ever
    // noticed — now every spot reports ok/FAILED in the log.
    try {
      // Spot choice (2026-11-24): the old south spot's only solid
      // neighbour is now the bed itself (clicks try to sleep instead
      // of placing), so spot 1 hangs on the west wall instead; spot 2
      // hangs on the north wall next to the chest.
      const spots = [{ x: ox + 1, y: baseY + 2, z: oz + 3 }, { x: ox + 2, y: baseY + 2, z: oz + 1 }];
      const torchAt = (t) => { const tb = bot.blockAt(new Vec3(t.x, t.y, t.z)); return tb && (tb.name === 'torch' || tb.name === 'wall_torch'); };
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const t of spots) {
          if (torchAt(t)) continue;
          await ensureTorch();
          if (ctx.countItem('torch') > 0) await ctx.placeBlockAt(t.x, t.y, t.z, 'torch').catch(() => false);
          await new Promise(r => setTimeout(r, 600));
        }
        if (spots.every(torchAt)) break;
      }
      for (const t of spots) console.log(`[repair] torch at ${t.x},${t.y},${t.z}: ${torchAt(t) ? 'ok' : 'FAILED'}`);
    } catch (e) { console.log('[repair] torch:', e.message); }
    // Perimeter torches (2026-11-24): the damage watcher caught wall
    // cells breaking with hostiles 2-4m away and no creeper left in
    // the entity list — it had already exploded against the wall.
    // Lighting the ground outside the corners suppresses the spawns
    // that feed those approaches.
    try {
      // Mid-side spots at the hut's own level: the corner spots sat
      // downhill by the crater and the pathfinder found NO path to
      // them at all (placements were attempted 8m out of reach and
      // silently dropped). Skip anything not within 2 of the base
      // level, walk up first, and only place from real reach.
      const sides = [{ x: ox - 1, z: oz + 2 }, { x: ox + bsize, z: oz + 2 }, { x: ox + 2, z: oz - 1 }, { x: ox + 2, z: oz + bsize }];
      for (const c of sides) {
        const gy = ctx.groundYAt(c.x, c.z, baseY);
        if (gy < 0 || Math.abs(gy - baseY) > 2) { console.log(`[repair] perimeter torch at ${c.x},${c.z}: skipped (terrain gy=${gy})`); continue; }
        const tb = bot.blockAt(new Vec3(c.x, gy + 1, c.z));
        if (tb && (tb.name === 'torch' || tb.name === 'wall_torch')) { console.log(`[repair] perimeter torch at ${c.x},${gy + 1},${c.z}: ok (already)`); continue; }
        await ensureTorch();
        if (ctx.countItem('torch') === 0) { console.log(`[repair] perimeter torch at ${c.x},${gy + 1},${c.z}: FAILED (no torch)`); continue; }
        try { await ctx.gotoWatched(new goals.GoalNear(c.x, gy + 1, c.z, 2), 20000, 'perimeter move'); } catch {}
        const d = bot.entity.position.distanceTo(new Vec3(c.x + 0.5, gy + 1.5, c.z + 0.5));
        if (d > 4) { console.log(`[repair] perimeter torch at ${c.x},${gy + 1},${c.z}: FAILED (cannot get within reach, ${d.toFixed(1)}m)`); continue; }
        await ctx.placeBlockAt(c.x, gy + 1, c.z, 'torch').catch(() => false);
        const vb = bot.blockAt(new Vec3(c.x, gy + 1, c.z));
        console.log(`[repair] perimeter torch at ${c.x},${gy + 1},${c.z}: ${vb && vb.name === 'torch' ? 'ok' : 'FAILED'}`);
      }
    } catch (e) { console.log('[repair] perimeter torch:', e.message); }
    // Bed last: the bed mission hunts sheep and places it inside.
    try {
      const bb = memory.bed ? bot.blockAt(new Vec3(memory.bed.x, memory.bed.y, memory.bed.z)) : null;
      if ((!bb || !bb.name.endsWith('_bed')) && bot.time && bot.time.isDay) await ctx.bedMission();
    } catch (e) { console.log('[repair] bed:', e.message); }
    const left = blueprint.filter(cellMissing).length;
    console.log(`[repair] done: placed ${placed}, remaining holes ${left}`);
    ctx.say(left === 0 ? '拠点を建て直したよ。壁も屋根も元どおり' : `建て直し終わり（${placed}マス埋めたけど、まだ${left}マス残ってる）`);
  } catch (e) { console.log('[repair] failed:', e.message); ctx.say('建て直しに失敗しちゃった'); }
  finally { S.repairMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; if (shared.repairJob && shared.repairJob.lead === bot.username) shared.repairJob = null; }
}
// Helper half of a pair repair: the lead (repairBase) assigns this
// body a subset of the missing cells; gather, convert and place them
// in parallel, then flag completion so the lead can do the fittings.
// Perimeter torch ring maintenance (2026-11-25): repairBase lights
// the mid-side spots when it runs, but nothing replaced torches
// lost afterwards — and the damage watcher keeps blaming night
// creeper blasts at the walls for the vanishing bed. This is the
// same placement logic (mid-sides at the hut's own level, terrain
// within 2 of base level, real-reach check) extended to the four
// corners, callable on its own by the daytime watcher duty.
ctx.ensurePerimeterTorches = async function () {
  const { Vec3 } = require('vec3');
  if (!settings.home) return 0;
  const L = ctx.baseLayout();
  const { ox, oz, baseY } = L; const bsize = L.size; const mid = Math.floor(bsize / 2);
  const spots = [
    { x: ox - 1, z: oz + mid }, { x: ox + bsize, z: oz + mid },
    { x: ox + mid, z: oz - 1 }, { x: ox + mid, z: oz + bsize },
    { x: ox - 1, z: oz - 1 }, { x: ox + bsize, z: oz - 1 },
    { x: ox - 1, z: oz + bsize }, { x: ox + bsize, z: oz + bsize },
  ];
  const missing = [];
  for (const c of spots) {
    const gy = ctx.groundYAt(c.x, c.z, baseY);
    if (gy < 0 || Math.abs(gy - baseY) > 2) continue;
    const tb = bot.blockAt(new Vec3(c.x, gy + 1, c.z));
    if (tb && (tb.name === 'torch' || tb.name === 'wall_torch')) continue;
    if (tb && !REPLACEABLE_CELLS.has(tb.name)) continue;
    missing.push({ x: c.x, gy, z: c.z });
  }
  if (!missing.length) return 0;
  console.log(`[torch] perimeter: ${missing.length} spots dark`);
  if (ctx.countItem('torch') === 0) {
    try { await ctx.withdrawFromChest('torch', 4); } catch {}
    if (S.desiredState !== 'busy') S.desiredState = 'busy'; // withdraw's finally clears it
  }
  let placed = 0;
  for (const c of missing) {
    await ensureTorch();
    if (ctx.countItem('torch') === 0) { console.log('[torch] perimeter: no torch available'); break; }
    try { await ctx.gotoWatched(new goals.GoalNear(c.x, c.gy + 1, c.z, 2), 20000, 'perimeter move'); } catch {}
    const d = bot.entity.position.distanceTo(new Vec3(c.x + 0.5, c.gy + 1.5, c.z + 0.5));
    if (d > 4) { console.log(`[torch] perimeter at ${c.x},${c.z}: out of reach (${d.toFixed(1)}m)`); continue; }
    await ctx.placeBlockAt(c.x, c.gy + 1, c.z, 'torch').catch(() => false);
    const vb = bot.blockAt(new Vec3(c.x, c.gy + 1, c.z));
    if (vb && vb.name === 'torch') { placed++; console.log(`[torch] perimeter placed at ${c.x},${c.gy + 1},${c.z}`); }
    else console.log(`[torch] perimeter at ${c.x},${c.gy + 1},${c.z}: FAILED`);
  }
  return placed;
};
ctx.repairAssist = async function (cells) {
  const done = () => { if (shared.repairJob) shared.repairJob.helperDone = true; };
  if (S.repairMode || !cells || !cells.length) { done(); return; }
  S.repairMode = true; S.soloAbort = false;
  // Busy like buildV2Assist (audit 2026-11-25): without it the
  // state machine stomped this helper's build gotos — the exact
  // failure gatherCobble had in the 2026-11-24 stone test.
  const wasBusy = S.desiredState === 'busy';
  S.desiredState = 'busy';
  try {
    console.log(`[repair] ${bot.username} assisting with ${cells.length} cells`);
    ctx.say(`分担分を建てるね（${cells.length}マス）`);
    await ctx.prepareForMission().catch(() => {});
    const res = await buildAssignedCells(cells, 4);
    console.log(`[repair] ${bot.username} assist done: placed ${res.placed}`);
    ctx.say(`分担分おわり（${res.placed}マス埋めた）`);
  } catch (e) { console.log('[repair] assist failed:', e.message); }
  finally { S.repairMode = false; if (!wasBusy && S.desiredState === 'busy') S.desiredState = 'idle'; done(); }
}

// ---- base expansion to 7x7 (v2, user request 2026-11-24) ----
// The 5x5 hut is cramped, so expand it in place: the old floor
// and roof are subsets of the new layout and stay; the old walls
// become interior and are demolished; terrain sitting in the new
// cells is cleared first. Work is sliced by global cell index so
// up to three bodies build in parallel — pair lead slice 0,
// pair helper slice 1 (buildV2Assist), and the dev Muze in its
// own process slice 2 when it is told separately. Every act is
// verify-before-place/dig, and the lead ends with a straggler
// pass over everything, so a missing helper never breaks it.
const NATURAL_CELLS = new Set(['dirt', 'grass_block', 'stone', 'sand', 'gravel', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'cobblestone', 'andesite', 'diorite', 'granite', 'clay', 'coarse_dirt', 'podzol', 'mycelium', 'snow', 'grass', 'tall_grass', 'fern']);
const digCellQuiet = async (x, y, z) => {
  const { Vec3 } = require('vec3');
  try {
    await ctx.gotoWatched(new goals.GoalNear(x, y, z, 2), 25000, 'prep move');
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b || b.boundingBox !== 'block') return false;
    await ctx.withTimeout(bot.dig(b), 20000, 'prep dig');
    return true;
  } catch { return false; }
};
// prep entries carry a mode: 'demo' digs old-structure blocks
// (planks/doors/logs), 'clear' digs natural terrain out of a
// blueprint cell so a plank can take its place.
const prepCells = async (entries, demoSet) => {
  const { Vec3 } = require('vec3');
  let n = 0;
  for (const c of entries) {
    if (S.soloAbort) break;
    const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (!b) continue;
    const hit = c.mode === 'demo'
      ? (b.name.endsWith('_planks') || b.name.endsWith('_door') || b.name.endsWith('_log'))
      : NATURAL_CELLS.has(b.name);
    if (hit) { if (await digCellQuiet(c.x, c.y, c.z)) n++; await new Promise(r => setTimeout(r, 300)); }
  }
  return n;
};
const demoSetFor = () => {
  const L5 = ctx.baseLayout(5);
  const set = new Set(ctx.blueprintCells(5).filter(c => c.y > L5.baseY).map(c => `${c.x},${c.y},${c.z}`));
  set.add(`${L5.doorX},${L5.baseY + 1},${L5.doorZ}`); set.add(`${L5.doorX},${L5.baseY + 2},${L5.doorZ}`);
  return set;
};
ctx.buildV2Assist = async function (prep, cells) {
  const done = () => { if (shared.buildJob) shared.buildJob.helperDone = true; };
  if (S.repairMode || (!prep.length && !cells.length)) { done(); return; }
  S.repairMode = true; S.soloAbort = false;
  try {
    console.log(`[build] ${bot.username} assisting: prep ${prep.length}, build ${cells.length}`);
    ctx.say(`分担分を建てるね（${cells.length}マス）`);
    await ctx.prepareForMission().catch(() => {});
    S.desiredState = 'busy';
    await prepCells(prep, demoSetFor());
    const res = await buildAssignedCells(cells, 4);
    console.log(`[build] ${bot.username} assist done: placed ${res.placed}`);
    ctx.say(`分担分おわり（${res.placed}マス埋めた）`);
  } catch (e) { console.log('[build] assist failed:', e.message); }
  finally { S.repairMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; done(); }
};
ctx.buildBaseV2 = async function () {
  if (S.repairMode) { ctx.say('もう拠点作業の途中だよ'); return; }
  if (!settings.home) { ctx.say('拠点がまだないよ'); return; }
  if ((memory.baseSize || 5) >= 7) { ctx.say('拠点はもう広くなってるよ'); return; }
  if (bot.time && !bot.time.isDay) { ctx.say('夜は危ないから、朝になってから広げるね'); return; }
  // Pair negotiation (fix 2026-11-25): when both bodies were told
  // together, each used to enter as lead with slice 0 — the lead's
  // assist call bounced off the partner's repairMode guard, slice 1
  // went uncovered until the straggler pass, and both bodies did
  // the lead's work. Now the first body to publish shared.buildJob
  // leads; the other stands down to helper (the lead invokes its
  // buildV2Assist directly). A non-primary body waits briefly for
  // a lead to appear first, so a solo order to it still leads.
  if (shared.buildJob && Date.now() - shared.buildJob.at < 15 * 60000) { ctx.say('相方がリードで広げてるから、手伝いに回るね'); return; }
  if (!ctx.cfg.primary) {
    await new Promise(r => setTimeout(r, 4000));
    if (shared.buildJob && Date.now() - shared.buildJob.at < 15 * 60000) { ctx.say('相方がリードで広げてるから、手伝いに回るね'); return; }
    if (S.repairMode) return; // the lead's assist call claimed this body meanwhile
  }
  S.repairMode = true; S.soloAbort = false;
  shared.buildJob = { helperDone: false, at: Date.now(), lead: bot.username };
  const { Vec3 } = require('vec3');
  try {
    ctx.say('拠点を広く建て替えるね（7×7）。まず下調べするよ');
    await ctx.prepareForMission().catch(() => {});
    S.desiredState = 'busy';
    await ctx.goHome();
    const L7 = ctx.baseLayout(7); const L5 = ctx.baseLayout(5);
    const cells7 = ctx.blueprintCells(7);
    const cells5 = ctx.blueprintCells(5);
    const key = c => `${c.x},${c.y},${c.z}`;
    const set7 = new Set(cells7.map(key));
    const demo = cells5.filter(c => c.y > L5.baseY && !set7.has(key(c)));
    demo.push({ x: L5.doorX, y: L5.baseY + 1, z: L5.doorZ }, { x: L5.doorX, y: L5.baseY + 2, z: L5.doorZ });
    const demoSet = demoSetFor();
    const partner = ctx.partnerCtx();
    const inPair = !!(partner && partner.ctx);
    const mySlice = inPair ? 0 : 2;
    const prepAll = [...demo.map(c => ({ ...c, mode: 'demo' })), ...cells7.map(c => ({ ...c, mode: 'clear' }))];
    const myPrep = prepAll.filter((_, i) => i % 3 === mySlice);
    const myCells = cells7.filter((_, i) => i % 3 === mySlice);
    let helperStarted = false;
    if (inPair) {
      const theirPrep = prepAll.filter((_, i) => i % 3 === 1);
      const theirCells = cells7.filter((_, i) => i % 3 === 1);
      if ((theirPrep.length || theirCells.length) && !partner.ctx.anyMissionActive()) {
        helperStarted = true;
        const pcall = (partner.cfg || {}).callName || partner.name;
        ctx.say(`${pcall}と分担して広げるね`);
        partner.ctx.buildV2Assist(theirPrep, theirCells).catch(e => { console.log('[build] assist call:', e.message); if (shared.buildJob) shared.buildJob.helperDone = true; });
      }
    }
    console.log(`[build] v2: demo ${demo.length}, cells ${cells7.length}, slice ${mySlice} (prep ${myPrep.length}, build ${myCells.length}), helper=${helperStarted}`);
    const dug = await prepCells(myPrep, demoSet);
    console.log(`[build] ${bot.username} prep dug ${dug}`);
    const res = await buildAssignedCells(myCells, 18);
    if (res.aborted) return;
    if (helperStarted) {
      for (let i = 0; i < 300 && shared.buildJob && !shared.buildJob.helperDone; i++) { await new Promise(r => setTimeout(r, 2000)); if (S.soloAbort) break; }
      console.log(`[build] helper done=${shared.buildJob && shared.buildJob.helperDone}`);
      shared.buildJob = null;
    }
    // Straggler pass over everything: covers slice 2 when the
    // dev Muze did not join, and any cell the two processes'
    // block views disagreed about.
    const leftDemo = demo.filter(c => { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); return b && (b.name.endsWith('_planks') || b.name.endsWith('_door') || b.name.endsWith('_log')); });
    if (leftDemo.length) { console.log(`[build] straggler prep: ${leftDemo.length} old-wall cells`); await prepCells(leftDemo.map(c => ({ ...c, mode: 'demo' })), demoSet); }
    const leftClear = cells7.filter(c => { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); return b && NATURAL_CELLS.has(b.name); });
    if (leftClear.length) { console.log(`[build] straggler clear: ${leftClear.length} terrain cells`); await prepCells(leftClear.map(c => ({ ...c, mode: 'clear' })), demoSet); }
    const left = cells7.filter(repairCellMissing);
    if (left.length) { console.log(`[build] straggler build: ${left.length} cells`); const vres = await buildAssignedCells(left, 6); if (vres.aborted) return; }
    try { await ctx.levelInterior(); } catch (e) { console.log('[build] level:', e.message); }
    // Door at the new doorway.
    try {
      const doorPlanks = res.planks || (bot.inventory.items().filter(i => i.name.endsWith('_planks')).sort((a, b) => b.count - a.count)[0] || {}).name;
      if (doorPlanks) {
        const doorName = doorPlanks.replace('_planks', '_door');
        const dc = bot.blockAt(new Vec3(L7.doorX, L7.baseY + 1, L7.doorZ));
        if (!dc || dc.name === 'air' || REPLACEABLE_CELLS.has(dc.name)) {
          if (ctx.countItem(doorName) === 0) await ctx.craftItem(doorName, 1);
          if (ctx.countItem(doorName) > 0) await ctx.placeBlockAt(L7.doorX, L7.baseY + 1, L7.doorZ, doorName);
        }
        await new Promise(r => setTimeout(r, 600));
        const dv = bot.blockAt(new Vec3(L7.doorX, L7.baseY + 1, L7.doorZ));
        console.log(`[build] door: ${dv && dv.name.endsWith('_door') ? 'ok' : 'FAILED'}`);
      }
    } catch (e) { console.log('[build] door:', e.message); }
    // Torches against the new walls.
    try {
      const spots = [{ x: L7.ox + 1, y: L7.baseY + 2, z: L7.oz + 3 }, { x: L7.ox + 2, y: L7.baseY + 2, z: L7.oz + 1 }];
      const torchAt = (t) => { const tb = bot.blockAt(new Vec3(t.x, t.y, t.z)); return tb && (tb.name === 'torch' || tb.name === 'wall_torch'); };
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const t of spots) {
          if (torchAt(t)) continue;
          await ensureTorch();
          if (ctx.countItem('torch') > 0) await ctx.placeBlockAt(t.x, t.y, t.z, 'torch').catch(() => false);
          await new Promise(r => setTimeout(r, 600));
        }
        if (spots.every(torchAt)) break;
      }
      for (const t of spots) console.log(`[build] torch at ${t.x},${t.y},${t.z}: ${torchAt(t) ? 'ok' : 'FAILED'}`);
    } catch (e) { console.log('[build] torch:', e.message); }
    const missing = cells7.filter(repairCellMissing).length;
    if (missing === 0) { memory.baseSize = 7; ctx.saveMemory(); }
    console.log(`[build] v2 done: missing ${missing}`);
    ctx.say(missing === 0 ? '拠点が広くなったよ（7×7）。窓も開けてある' : `拡張おわり（まだ${missing}マス残ってる）`);
  } catch (e) { console.log('[build] v2 failed:', e.message); ctx.say('拠点の拡張に失敗しちゃった'); }
  finally { S.repairMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; if (shared.buildJob && shared.buildJob.lead === bot.username) shared.buildJob = null; }
};

ctx.closeDoorNear = function () {
  try {
    const doors = ctx.findBlocks(['oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'iron_door'], 6, 4);
    for (const p of doors) {
      const b = bot.blockAt(p); if (!b) continue;
      const props = b.getProperties ? b.getProperties() : {};
      if (props.open === 'true' || props.open === true) { Promise.resolve(bot.activateBlock(b)).catch(() => {}); console.log('[home] closed the door'); }
    }
  } catch {}
}
// After losing to a monster, do not walk back bare-handed: craft at least a
// wooden sword first (user request 2026-11-23). Gathers 2 logs if needed.
ctx.goHome = async function () {
  if (!settings.home || !bot.entity) return false;
  const home = settings.home;
  const { Vec3 } = require('vec3');
  try {
    await ctx.gotoWatched(new goals.GoalNear(home.x, home.y, home.z, 1), 90000, 'go home');
    ctx.closeDoorNear();
    return bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z)) < 4;
  } catch (e) { console.log('[home] goHome failed:', e.message); return false; }
}

ctx.depositToChestImpl = async function () {
  // Prefer the remembered home chest (walk home first if needed); fall back
  // to any chest nearby. Afterwards the chest contents are remembered.
  try {
    S.desiredState = 'busy';
    let chestBlock = null;
    if (settings.home && bot.entity) {
      const dHome = Math.hypot(bot.entity.position.x - settings.home.x, bot.entity.position.z - settings.home.z);
      if (dHome > 6) { try { await ctx.goHome(); } catch {} }
      chestBlock = ctx.findHomeChest();
    }
    if (!chestBlock) {
      const pos = ctx.findBlocks(['chest', 'trapped_chest'], 32, 1);
      if (!pos.length) {
        // No chest anywhere: the remembered one may have been destroyed
        // — rebuild it instead of giving up (ensureHomeFixture).
        chestBlock = await ctx.ensureHomeChest();
        if (!chestBlock) { ctx.say('近くにチェストが見つからない'); return; }
      } else {
        chestBlock = bot.blockAt(pos[0]);
        if (chestBlock) { memory.chest = { x: chestBlock.position.x, y: chestBlock.position.y, z: chestBlock.position.z }; ctx.saveMemory(); }
      }
    }
    if (!chestBlock) { ctx.say('チェストが見つからない'); return; }
    await ctx.gotoWatched(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 30000, 'to chest');
    const chest = await bot.openContainer(chestBlock);
    let n = 0;
    let keptFood = 0;
    for (const item of [...bot.inventory.items()]) {
      if (DEPOSIT_KEEP(item.name)) continue;
      if (ctx.isFood(item.name)) {
        // Keep up to 8 food on the bot; the surplus becomes the chest
        // reserve (user-approved stockpile, 2026-11-23).
        const keep = Math.max(0, 8 - keptFood);
        keptFood += Math.min(keep, item.count);
        if (item.count <= keep) continue;
        try { await chest.deposit(item.type, null, item.count - keep); n += item.count - keep; } catch (e) { console.log('[deposit]', item.name, e.message); }
        continue;
      }
      try { await chest.deposit(item.type, null, item.count); n += item.count; } catch (e) { console.log('[deposit]', item.name, e.message); }
    }
    try { ctx.snapshotChest(chest); } finally { try { chest.close(); } catch {} }
    ctx.say(n ? `素材を${n}個預けた` : '預けるものがなかった（食料とツールは手元に残す）');
  } catch (e) { ctx.fail('預けられなかった', e); } finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}
// Chest/furnace use is serialized between the two bodies (2026-11-24):
// one shared chest and furnace, and simultaneous container sessions
// corrupted both flows. Wrappers hold the lock; impls do the work.
ctx.depositToChest = async function () { await ctx.acquireLock('chest'); try { return await ctx.depositToChestImpl(); } finally { ctx.releaseLock('chest'); } };
ctx.withdrawFromChestImpl = async function (query, count = Infinity) {
  const name = JP_ITEMS[query] || query;
  if (!settings.home) { ctx.say('拠点がまだないからチェストもないよ'); return; }
  try {
    S.desiredState = 'busy';
    await ctx.goHome();
    let chestBlock = ctx.findHomeChest();
    if (!chestBlock) chestBlock = await ctx.ensureHomeChest();
    if (!chestBlock) { ctx.say('拠点のチェストが見つからない'); return; }
    await ctx.gotoWatched(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 30000, 'to chest');
    const chest = await bot.openContainer(chestBlock);
    const inChest = ctx.containerItems(chest);
    // Prefer the largest matching stack: a 1-plank leftover stack used to
    // shadow the 35-plank stack the caller actually needed.
    const matches = inChest.filter(i => i.name === name || i.name.includes(name)).sort((a, b) => b.count - a.count);
    const item = matches[0];
    if (!item) { ctx.snapshotChest(chest); try { chest.close(); } catch {} ctx.say(`${query}はチェストに入ってない`); return; }
    const cnt = Math.min(item.count, count);
    // Close the window even when withdraw throws (audit 2026-11-25:
    // a stuck-open container wedged later chest flows).
    try { await chest.withdraw(item.type, null, cnt); }
    finally { try { ctx.snapshotChest(chest); } catch {} try { chest.close(); } catch {} }
    ctx.say(`${item.name}を${cnt}個取り出した`);
  } catch (e) { ctx.fail('取り出せなかった', e); } finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}
ctx.sayMemory = function () {
  const parts = [];
  if (settings.home) parts.push(`拠点は(${settings.home.x}, ${settings.home.y}, ${settings.home.z})`);
  if (memory.chest) parts.push(`チェストには${memory.chestContents.reduce((a, i) => a + i.count, 0)}個入ってる`);
  if (memory.spots.forest) parts.push(`木は(${memory.spots.forest.x}, ${memory.spots.forest.z})の辺りで取れた`);
  if (memory.spots.stone) parts.push(`石は(${memory.spots.stone.x}, ${memory.spots.stone.z})で掘れた`);
  const d = memory.deaths[memory.deaths.length - 1];
  if (d) parts.push(`最後に死んだのは(${d.x}, ${d.z})`);
  ctx.say(parts.length ? '覚えてること: ' + parts.join('、') : 'まだ何も覚えてない');
}
ctx.giveItem = async function (username, query) {
  const name = JP_ITEMS[query] || query;
  const item = bot.inventory.items().find(i => i.name === name) || bot.inventory.items().find(i => i.name.includes(name));
  if (!item) { ctx.say(`${query}は持ってない`); return; }
  const player = bot.players[username]?.entity;
  try {
    if (player) { S.desiredState = 'busy'; await bot.pathfinder.goto(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2)); }
    await bot.tossStack(item); ctx.say(`${item.name}を渡した`);
  } catch (e) { ctx.fail('渡せなかった', e); } finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}

ctx.withdrawFromChest = async function (query, count = Infinity) { await ctx.acquireLock('chest'); try { return await ctx.withdrawFromChestImpl(query, count); } finally { ctx.releaseLock('chest'); } };

// ---- bed mission: hunt sheep -> craft a bed -> place it at the base ----
// (user request 2026-11-23: sleep in it at night to skip the night)
async function placeBedInside(bedName) {
  const { Vec3 } = require('vec3');
  const home = settings.home;
  // Terrain bumps at the living level leave no two flat adjacent
  // cells; clear them first or every candidate pair is rejected.
  try { await ctx.levelInterior(); } catch (e) { console.log('[bed] level:', e.message); }
  const cellFree = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && (b.name === 'air' || REPLACEABLE_CELLS.has(b.name)); };
  // Verify by direct blockAt scan (findBlocks is unreliable here).
  const scanBed = () => {
    for (let x = home.x - 1; x <= home.x + 1; x++) for (let z = home.z - 1; z <= home.z + 1; z++) {
      const b = bot.blockAt(new Vec3(x, home.y, z));
      if (b && b.name === bedName) return { x: b.position.x, y: b.position.y, z: b.position.z };
    }
    return null;
  };
  for (let x = home.x - 1; x <= home.x + 1; x++) for (let z = home.z - 1; z <= home.z + 1; z++) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const hx = x + dx, hz = z + dz;
      if (hx < home.x - 1 || hx > home.x + 1 || hz < home.z - 1 || hz > home.z + 1) continue;
      if (!cellFree(x, home.y, z) || !cellFree(hx, home.y, hz)) continue;
      if (!cellFree(x, home.y + 1, z) || !cellFree(hx, home.y + 1, hz)) continue;
      // Beds are two-block items: placeBlockAt's arbitrary reference face
      // makes the server refuse them. Place manually instead — equip,
      // face the head cell, and click the TOP face of the floor block
      // under the foot cell, exactly like a player would.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Stand directly BEHIND the foot cell (opposite the head), so
        // the facing quadrant — which decides where the head lands —
        // is unambiguous.
        try { await ctx.gotoWatched(new goals.GoalNear(x - dx, home.y, z - dz, 1), 20000, 'bed spot'); } catch {}
        const item = bot.inventory.items().find(i => i.name === bedName);
        if (!item) { console.log('[bed] bed item not in inventory'); return null; }
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
        // Verify the bed is actually in hand before clicking: on
        // this server equip can silently desync, and placeBlock
        // then clicks with the wrong item in hand and the server
        // refuses ("the block is still air" on every attempt,
        // 2026-11-24 night restore). Re-equip until it sticks.
        for (let eq = 0; eq < 3; eq++) {
          const it2 = bot.inventory.items().find(i => i.name === bedName);
          if (!it2) break;
          try { await bot.equip(it2, 'hand'); } catch {}
          await new Promise(r => setTimeout(r, 400));
          if (bot.heldItem && bot.heldItem.name === bedName) break;
        }
        try { await bot.lookAt(new Vec3(hx + 0.5, home.y + 0.5, hz + 0.5), true); } catch {}
        const floor = bot.blockAt(new Vec3(x, home.y - 1, z));
        if (!floor || floor.boundingBox !== 'block') break;
        try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); } catch (e) { console.log(`[bed] placeBlock bed (${x}, ${z}): ${e.message}`); }
        await new Promise(r => setTimeout(r, 1000));
        const found = scanBed();
        if (found) {
          // Verify the PAIR: a bed is two blocks, and the head follows
          // the bot's facing quadrant — it once landed inside the wall
          // (180, -105) while the foot verified fine, leaving an
          // obstructed bed that refused sleep all night. If the pair
          // is not exactly 2 cells inside the interior, dig it back up
          // and try another spot.
          const cells = [];
          for (let sx = home.x - 2; sx <= home.x + 2; sx++) for (let sz = home.z - 2; sz <= home.z + 2; sz++) { const b = bot.blockAt(new Vec3(sx, home.y, sz)); if (b && b.name === bedName) cells.push(b.position); }
          const pairInside = cells.length === 2 && cells.every(p => Math.abs(p.x - home.x) <= 1 && Math.abs(p.z - home.z) <= 1);
          if (pairInside) return found;
          console.log(`[bed] pair check failed (${cells.length} cells) — digging up and retrying elsewhere`);
          const bad = bot.blockAt(new Vec3(found.x, found.y, found.z));
          if (bad) { try { await ctx.withTimeout(bot.dig(bad), 20000, 'dig bad bed'); } catch {} }
          await new Promise(r => setTimeout(r, 800));
          try { await ctx.gotoWatched(new goals.GoalNear(found.x, found.y, found.z, 1), 15000, 'bed drop pickup'); } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      console.log(`[bed] placement at (${x}, ${z}) did not verify — trying another spot`);
    }
  }
  return null;
}
// Force an inventory-window resync through the home chest. Container
// interactions are the one thing that reliably resyncs the bot's window
// on this server; without it, equip/craft steps act on a phantom
// inventory and the server refuses placements. Shared (2026-11-23).
ctx.resyncViaChestImpl = async function () {
  if (!settings.home || !memory.chest) return;
  try {
    await ctx.goHome();
    let chestBlock = ctx.findHomeChest();
    if (!chestBlock) chestBlock = await ctx.ensureHomeChest();
    if (!chestBlock) return;
    await ctx.gotoWatched(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 20000, 'resync chest');
    const chest = await bot.openContainer(chestBlock);
    await new Promise(r => setTimeout(r, 900));
    ctx.snapshotChest(chest);
    try { chest.close(); } catch {}
    await new Promise(r => setTimeout(r, 900));
    console.log('[sync] inventory resynced via chest');
  } catch (e) { console.log('[sync] resync failed:', e.message); }
}
ctx.resyncViaChest = async function () { await ctx.acquireLock('chest'); try { return await ctx.resyncViaChestImpl(); } finally { ctx.releaseLock('chest'); } };
const RAW_FOODS = ['beef', 'mutton', 'porkchop', 'chicken', 'rabbit', 'cod', 'salmon'];
ctx.cookFoodImpl = async function (maxItems = 4) {
  const { Vec3 } = require('vec3');
  if (!settings.home) return 0;
  let fpos = memory.furnace ? new Vec3(memory.furnace.x, memory.furnace.y, memory.furnace.z) : (ctx.findBlocks(['furnace'], 24, 1)[0] || null);
  if (fpos) {
    // The remembered furnace may have been destroyed (creeper, 2026-11-23):
    // rebuild it instead of trying to open a furnace that is not there.
    const fb = bot.blockAt(fpos);
    if (!fb || fb.name !== 'furnace') { const rebuilt = await ctx.ensureHomeFixture('furnace'); fpos = rebuilt ? rebuilt.position : null; }
  }
  if (!fpos) return 0;
  let raw = bot.inventory.items().find(i => RAW_FOODS.includes(i.name));
  if (!raw) {
    // The base's raw food lives in the chest, not on the bot:
    // withdraw before giving up (live test 2026-11-24: "no raw
    // food" while the chest held raw cod and salmon).
    for (const f of RAW_FOODS) { try { await ctx.withdrawFromChest(f, maxItems); } catch {} }
    raw = bot.inventory.items().find(i => RAW_FOODS.includes(i.name));
  }
  if (!raw) { console.log('[cook] no raw food'); return 0; }
  // Same for fuel: coal usually sits in the chest too.
  if (!bot.inventory.items().some(i => i.name === 'charcoal' || i.name === 'coal' || i.name.endsWith('_planks') || ctx.C.LOG_TYPES.includes(i.name))) {
    try { await ctx.withdrawFromChest('coal', 2); } catch {}
    try { await ctx.withdrawFromChest('charcoal', 2); } catch {}
  }
  await ctx.gotoWatched(new goals.GoalNear(fpos.x, fpos.y, fpos.z, 2), 30000, 'to furnace');
  const block = bot.blockAt(fpos); if (!block) return 0;
  const furnace = await bot.openFurnace(block);
  let cooked = 0;
  try {
    // Clear leftovers from whoever used the furnace last (a partner's
    // charcoal smelt leaves logs behind and putInput then throws).
    try { await furnace.takeInput(); } catch {}
    try { await furnace.takeFuel(); } catch {}
    try { await furnace.takeOutput(); } catch {}
    const fuel = bot.inventory.items().find(i => i.name === 'charcoal' || i.name === 'coal') || bot.inventory.items().find(i => i.name.endsWith('_planks')) || bot.inventory.items().find(i => ctx.C.LOG_TYPES.includes(i.name));
    if (!fuel) { console.log('[cook] no fuel'); return 0; }
    await furnace.putFuel(fuel.type, null, 2);
    const n = Math.min(raw.count, maxItems);
    await furnace.putInput(raw.type, null, n);
    // Accumulate what each takeOutput actually removes: comparing
    // the output slot's count against a running total under-counts
    // whenever items are taken one at a time (live: cooked 2 of 4).
    for (let i = 0; i < 40 && cooked < n; i++) { await new Promise(r => setTimeout(r, 1500)); const out = furnace.outputItem(); if (out) { const seen = out.count; const taken = await furnace.takeOutput().catch(() => null); cooked += (taken && taken.count) || seen; await new Promise(r => setTimeout(r, 500)); } if (S.soloAbort) break; }
  } finally { try { if (furnace.close) furnace.close(); else bot.closeWindow(furnace.window); } catch {} }
  console.log(`[cook] cooked ${cooked} ${raw.name}`);
  if (cooked) ctx.say(`${raw.name}を${cooked}個焼いたよ`);
  return cooked;
}
ctx.cookFood = async function (maxItems = 4) { await ctx.acquireLock('furnace'); try { return await ctx.cookFoodImpl(maxItems); } finally { ctx.releaseLock('furnace'); } };
// Campfire cooking (user request 2026-11-25): one shared campfire
// outside the hut door, raw cod/salmon cooked on it (4 at a time,
// ~30s), the cooked fish collected and reported. The spot is kept
// in memory.campfire so all bodies share the same fire.
ctx.campfireCook = async function () {
  if (S.campfireMode) { ctx.say('もう焚き火で焼いてる途中だよ'); return 0; }
  if (!settings.home) { ctx.say('拠点がまだないよ'); return 0; }
  if (bot.time && !bot.time.isDay) { ctx.say('夜は危ないから、朝になってからにしよう'); return 0; }
  S.campfireMode = true; S.soloAbort = false; S.desiredState = 'busy';
  const { Vec3 } = require('vec3');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const rawNames = ['cod', 'salmon'];
  let cookedTotal = 0;
  try {
    ctx.say('焚き火で魚を焼くね');
    if (!bot.inventory.items().some(i => rawNames.includes(i.name))) {
      for (const f of rawNames) { try { await ctx.withdrawFromChest(f, 8); } catch {} }
      S.desiredState = 'busy'; // withdrawFromChest clears it (known pattern)
    }
    if (!bot.inventory.items().some(i => rawNames.includes(i.name))) { ctx.say('焼く魚がないよ。先に釣ってきて'); return 0; }
    await ctx.goHome().catch(() => {});
    S.desiredState = 'busy';
    // Reuse an existing campfire near the hut before placing one.
    let firePos = null;
    if (memory.campfire) { const b = bot.blockAt(new Vec3(memory.campfire.x, memory.campfire.y, memory.campfire.z)); if (b && b.name === 'campfire') firePos = b.position; }
    if (!firePos) { const found = ctx.findBlocks(['campfire'], 24, 1)[0]; if (found) firePos = found; }
    if (!firePos) {
      if (ctx.countItem('campfire') === 0) { try { await ctx.withdrawFromChest('campfire', 1); } catch {} S.desiredState = 'busy'; }
      if (ctx.countItem('campfire') === 0) {
        if (ctx.countItem('coal') === 0 && ctx.countItem('charcoal') === 0) { try { await ctx.withdrawFromChest('coal', 1); } catch {} try { await ctx.withdrawFromChest('charcoal', 1); } catch {} }
        if (ctx.countItem('stick') < 3) { try { await ctx.withdrawFromChest('stick', 4); } catch {} }
        if (!bot.inventory.items().some(i => ctx.C.LOG_TYPES.includes(i.name) && ctx.countItem(i.name) >= 3)) { for (const lt of ctx.C.LOG_TYPES) { try { await ctx.withdrawFromChest(lt, 3); } catch {} } }
        // Live fallbacks (2026-11-25): the chest-only version failed
        // silently with no logs in stock and the whole flow died at
        // cooked=0 with no journal trace. Gather logs directly, and
        // smelt charcoal when there is no coal/charcoal anywhere.
        const logTotal = () => ctx.C.LOG_TYPES.reduce((a, t) => a + ctx.countItem(t), 0);
        if (logTotal() < 3) {
          // collectByNames only reaches ~32 blocks and the forest is
          // ~45 from the hut — walk to the remembered forest first,
          // and take 5 logs when charcoal still has to be smelted
          // from one of them. The first version gathered in place,
          // found nothing and gave up in seconds (2026-11-25).
          const want = (ctx.countItem('coal') === 0 && ctx.countItem('charcoal') === 0) ? 5 : 3;
          console.log(`[campfire] logs short — gathering ${want}`);
          try {
            if (memory.spots && memory.spots.forest) { const f = memory.spots.forest; await ctx.gotoWatched(new goals.GoalNear(f.x, f.y, f.z, 4), 45000, 'to forest').catch(() => {}); }
            await ctx.collectByNames(ctx.C.LOG_TYPES, want, '原木', 40);
            await ctx.goHome().catch(() => {});
          } catch (e) { console.log('[campfire] gather logs:', e.message); }
          S.desiredState = 'busy';
        }
        if (ctx.countItem('coal') === 0 && ctx.countItem('charcoal') === 0 && logTotal() > 3) { console.log('[campfire] no coal/charcoal — smelting one'); try { await ctx.smeltCharcoal(1); } catch (e) { console.log('[campfire] smeltCharcoal:', e.message); } S.desiredState = 'busy'; }
        // No table nearby and none carried makes 3x3 crafts silently fail
        // (the hut table can be blast-destroyed); the chest stocks spares.
        if (!ctx.findCraftingTable() && ctx.countItem('crafting_table') === 0) { try { await ctx.withdrawFromChest('crafting_table', 1); } catch {} }
        // Window work above (withdraws, a smelt) can desync the
        // inventory view — the first live craft read stick=0 while
        // 3 were held. Resync through the chest before crafting.
        try { await ctx.resyncViaChest(); } catch {}
        S.desiredState = 'busy';
        try { await ctx.craftItem('campfire', 1); } catch (e) { console.log('[campfire] craft:', e.message); }
      }
      if (ctx.countItem('campfire') === 0) { console.log(`[campfire] no campfire craftable: logs=${ctx.C.LOG_TYPES.reduce((a, t) => a + ctx.countItem(t), 0)} coal=${ctx.countItem('coal')} charcoal=${ctx.countItem('charcoal')} stick=${ctx.countItem('stick')}`); ctx.say('焚き火が用意できなかった（材料不足かも）'); return 0; }
      // Outside the door (door at home z-3, south side); avoid the
      // perimeter torch cells (178,-101) and (174/182,-101).
      const spots = [[180, -100], [176, -100], [180, -98], [176, -98], [182, -103], [174, -103]];
      for (const [sx, sz] of spots) {
        const gy = ctx.groundYAt(sx, sz, settings.home.y + 2);
        if (gy === null || gy === undefined || Math.abs(gy - (settings.home.y - 1)) > 2) continue;
        const cell = bot.blockAt(new Vec3(sx, gy + 1, sz));
        if (cell && cell.name !== 'air' && !REPLACEABLE_CELLS.has(cell.name)) continue;
        const ok = await ctx.placeBlockAt(sx, gy + 1, sz, 'campfire').catch(() => false);
        console.log(`[campfire] place at ${sx},${gy + 1},${sz}: ${ok}`);
        if (ok) { firePos = new Vec3(sx, gy + 1, sz); memory.campfire = { x: sx, y: gy + 1, z: sz }; ctx.saveMemory(); break; }
      }
      if (!firePos) { ctx.say('焚き火を置ける場所が見つからなかった'); return 0; }
    }
    console.log(`[campfire] fire at ${firePos.x},${firePos.y},${firePos.z}`);
    for (let round = 0; round < 4 && !S.soloAbort; round++) {
      const raw = bot.inventory.items().find(i => rawNames.includes(i.name));
      if (!raw) break;
      await ctx.gotoWatched(new goals.GoalNear(firePos.x, firePos.y, firePos.z, 2), 20000, 'to campfire').catch(() => {});
      const fire = bot.blockAt(firePos);
      if (!fire || fire.name !== 'campfire') { console.log('[campfire] fire gone'); break; }
      const before = ctx.countItem('cooked_' + raw.name);
      let loaded = 0;
      for (let i = 0; i < 4 && ctx.countItem(raw.name) > 0; i++) {
        const it = bot.inventory.items().find(x => x.name === raw.name);
        if (!it) break;
        try { await bot.equip(it, 'hand'); } catch {}
        try { await bot.lookAt(firePos.offset(0.5, 0.5, 0.5), true); } catch {}
        const n0 = ctx.countItem(raw.name);
        try { await bot.activateBlock(fire); } catch (e) { console.log('[campfire] load:', e.message); break; }
        await wait(700);
        if (ctx.countItem(raw.name) < n0) loaded++; else break;
      }
      if (!loaded) break;
      console.log(`[campfire] cooking ${loaded} ${raw.name}`);
      for (let w = 0; w < 10 && !S.soloAbort; w++) await wait(4000);
      // The cooked fish pops off the fire as drops: walk the area.
      for (const d of Object.values(bot.entities).filter(e => e && e.position && e.name === 'item' && e.position.distanceTo(firePos.offset(0.5, 0.5, 0.5)) <= 5)) {
        try { await ctx.gotoWatched(new goals.GoalNear(Math.floor(d.position.x), Math.floor(d.position.y), Math.floor(d.position.z), 0), 8000, 'collect cooked'); } catch {}
        await wait(400);
      }
      try { await ctx.gotoWatched(new goals.GoalNear(firePos.x, firePos.y, firePos.z, 1), 10000, 'back to fire'); } catch {}
      await wait(1200);
      const gained = ctx.countItem('cooked_' + raw.name) - before;
      cookedTotal += Math.max(0, gained);
      console.log(`[campfire] round done: +${gained} cooked_${raw.name} (total ${cookedTotal})`);
    }
    if (cookedTotal) ctx.say(`焚き火で${cookedTotal}個焼けたよ`);
    else ctx.say('うまく焼けなかった…');
    return cookedTotal;
  } catch (e) { console.log('[campfire] failed:', e.message); ctx.say('焚き火で焼くのに失敗しちゃった'); return cookedTotal; }
  finally { S.campfireMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}
// Fish surplus deposit for the fish-cook flow: keep 5 cooked fish in
// hand; leftover raw fish and cooked fish beyond 5 go to the chest.
ctx.depositFishSurplus = async function () {
  await ctx.acquireLock('chest');
  try {
    S.desiredState = 'busy';
    if (settings.home && bot.entity) { const dHome = Math.hypot(bot.entity.position.x - settings.home.x, bot.entity.position.z - settings.home.z); if (dHome > 6) { try { await ctx.goHome(); } catch {} } }
    let chestBlock = ctx.findHomeChest();
    if (!chestBlock) { chestBlock = await ctx.ensureHomeFixture('chest'); }
    if (!chestBlock) { console.log('[fishcook] no home chest for surplus'); return; }
    await ctx.gotoWatched(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 30000, 'to chest');
    const chest = await bot.openContainer(chestBlock);
    let n = 0;
    try {
      let cookedKept = 0;
      for (const item of [...bot.inventory.items()]) {
        if (item.name === 'cod' || item.name === 'salmon') { try { await chest.deposit(item.type, null, item.count); n += item.count; } catch {} continue; }
        if (item.name === 'cooked_cod' || item.name === 'cooked_salmon') {
          const keep = Math.max(0, 5 - cookedKept);
          cookedKept += Math.min(keep, item.count);
          if (item.count > keep) { try { await chest.deposit(item.type, null, item.count - keep); n += item.count - keep; } catch {} }
        }
      }
      try { ctx.snapshotChest(chest); } catch {}
    } finally { try { chest.close(); } catch {} }
    if (n) console.log(`[fishcook] deposited ${n} surplus fish`);
  } catch (e) { console.log('[fishcook] surplus deposit:', e.message); }
  finally { ctx.releaseLock('chest'); if (S.desiredState === 'busy') S.desiredState = 'idle'; }
};
// The full flow (user spec 2026-11-25): fish until cod+salmon = 5,
// cook them on the campfire, keep 5 cooked fish in hand, deposit the
// surplus in the chest.
ctx.fishCookFlow = async function () {
  if (S.fishCookMode) { ctx.say('もう焼き魚フローの途中だよ'); return; }
  S.fishCookMode = true; S.soloAbort = false; S.desiredState = 'busy';
  try {
    const rawCount = () => ctx.countItem('cod') + ctx.countItem('salmon');
    if (rawCount() < 5) { ctx.say('焼き魚フロー：まず5匹釣ってくる'); await ctx.fishMission({ target: 5 }); }
    if (S.soloAbort) { ctx.say('焼き魚フロー中止'); return; }
    if (rawCount() === 0) { ctx.say('魚が釣れなかったから、今日はここまで'); return; }
    const cooked = await ctx.campfireCook();
    // campfireCook can bail early away from home (its first live run
    // ended at the lake after a false stuck-SOS); the surplus
    // deposit needs the home chest within reach, so walk home first.
    await ctx.goHome().catch(() => {});
    S.desiredState = 'busy';
    await ctx.depositFishSurplus();
    const kept = ctx.countItem('cooked_cod') + ctx.countItem('cooked_salmon');
    ctx.say(`焼き魚フロー完了。焼き魚を${kept}個持ってるよ`);
    console.log(`[fishcook] flow done: cooked=${cooked} kept=${kept}`);
  } catch (e) { console.log('[fishcook] flow failed:', e.message); }
  finally { S.fishCookMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
};
// Furnish the base: furnace + torches (the last unfinished base item
// from the 2026-11-23 improvements) and cook whatever raw meat is held.
ctx.furnishBase = async function () {
  if (S.furnishMode) { ctx.say('もう整えてる途中だよ'); return; }
  if (!settings.home) { ctx.say('拠点がまだないよ'); return; }
  if (bot.time && !bot.time.isDay) { ctx.say('夜は危ないから、朝になってから整えるね'); return; }
  S.furnishMode = true; S.soloAbort = false;
  try {
    ctx.say('拠点を整えるね。かまどと松明を用意するよ');
    S.desiredState = 'busy';
    await ctx.prepareForMission().catch(() => {});
    await ctx.goHome();
    const { Vec3 } = require('vec3');
    const home = settings.home;
    const scanBlock = (name) => { for (let x = home.x - 2; x <= home.x + 2; x++) for (let z = home.z - 2; z <= home.z + 2; z++) for (let y = home.y - 1; y <= home.y + 2; y++) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.name === name) return b; } return null; };
    let furnace = scanBlock('furnace');
    if (!furnace) {
      if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) { ctx.say('先にツルハシを用意するね'); await ctx.pickaxeMission().catch(() => {}); }
      if (ctx.countItem('cobblestone') < 8) { ctx.say('丸石を集めてくるね'); await ctx.gatherCobble(8); }
      if (ctx.countItem('cobblestone') >= 8) { await ctx.resyncViaChest(); await ctx.craftItem('furnace', 1); }
      if (bot.inventory.items().some(i => i.name === 'furnace')) {
        outer: for (let x = home.x - 1; x <= home.x + 1; x++) for (let z = home.z - 1; z <= home.z + 1; z++) {
          const cell = bot.blockAt(new Vec3(x, home.y, z));
          if (!cell || !(cell.name === 'air' || REPLACEABLE_CELLS.has(cell.name))) continue;
          const ok = await ctx.placeBlockAt(x, home.y, z, 'furnace').catch(() => false);
          console.log(`[furnish] place furnace (${x}, ${z}): ${ok}`);
          if (ok) break outer;
        }
        furnace = scanBlock('furnace');
      }
    }
    if (furnace) { memory.furnace = { x: furnace.position.x, y: furnace.position.y, z: furnace.position.z }; ctx.saveMemory(); console.log('[furnish] furnace at', JSON.stringify(memory.furnace)); }
    let torchPlaced = scanBlock('torch') ? 1 : 0;
    if (!torchPlaced) {
      if (ctx.countItem('coal') === 0 && ctx.countItem('charcoal') === 0) {
        if (!bot.inventory.items().some(i => ctx.C.LOG_TYPES.includes(i.name))) { await ctx.collectByNames(ctx.C.LOG_TYPES, 2, '原木', 32).catch(() => {}); }
        if (furnace) { try { await ctx.smeltCharcoal(1); } catch (e) { console.log('[furnish] charcoal:', e.message); } }
      }
      if (ctx.countItem('coal') > 0 || ctx.countItem('charcoal') > 0) {
        if (ctx.countItem('stick') === 0) { try { await ctx.craftItem('stick', 1); } catch {} }
        try { await ctx.craftItem('torch', 1); } catch {}
      }
      if (ctx.countItem('torch') > 0) {
        let placed = 0;
        for (let x = home.x - 1; x <= home.x + 1 && placed < 2; x++) for (let z = home.z - 1; z <= home.z + 1 && placed < 2; z++) {
          const cell = bot.blockAt(new Vec3(x, home.y, z));
          if (!cell || !(cell.name === 'air' || REPLACEABLE_CELLS.has(cell.name))) continue;
          const ok = await ctx.placeBlockAt(x, home.y, z, 'torch').catch(() => false);
          console.log(`[furnish] place torch (${x}, ${z}): ${ok}`);
          if (ok) placed++;
        }
        torchPlaced = placed;
      }
    }
    if (furnace) { try { await ctx.cookFood(4); } catch (e) { console.log('[furnish] cook:', e.message); } }
    ctx.say(`拠点の整備おわり（かまど${furnace ? 'あり' : '用意できず'}、松明${torchPlaced ? torchPlaced + '本' : 'なし'}）`);
  } catch (e) { console.log('[furnish] failed:', e.message); ctx.say('拠点の整備に失敗しちゃった'); }
  finally { S.furnishMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}
// Restore a missing bed from a finished bed item (held or in
// the chest). The sleep path needs this at NIGHT, when
// bedMission's sheep-hunting flow refuses to run. The hut bed
// vanished twice on 2026-11-24 with its item ending up in the
// chest; sleep must be able to heal that on the spot.
ctx.restoreBedFromChest = async function () {
  if (!settings.home || !memory.chest) return null;
  let bedItem = bot.inventory.items().find(i => i.name.endsWith('_bed'));
  if (!bedItem) {
    const cb = (memory.chestContents || []).find(e => e.name.endsWith('_bed'));
    if (!cb) return null;
    try { await ctx.withdrawFromChest(cb.name, 1); } catch (e) { console.log('[bed] restore withdraw:', e.message); }
    bedItem = bot.inventory.items().find(i => i.name.endsWith('_bed'));
  }
  if (!bedItem) return null;
  const placed = await placeBedInside(bedItem.name);
  if (placed) { memory.bed = placed; ctx.saveMemory(); console.log('[bed] restored at', JSON.stringify(placed)); }
  return placed;
};
ctx.bedMission = async function () {
  if (S.bedMode) { ctx.say('もうベッドを作ってるよ'); return; }
  // Never run at night or concurrently with the night home-wait: the
  // mission once stepped outside mid-wait and the bot was killed at the
  // door (2026-11-23). The watchdog owns the night.
  if (S.homeWaitMode || (bot.time && !bot.time.isDay)) { ctx.say('夜は危ないから、朝になってから作るね'); return; }
  const BED_NAMES = Object.keys(bot.registry.blocksByName).filter(n => n.endsWith('_bed'));
  // Already have a bed at the base? Just remember where it is.
  if (settings.home && bot.entity) {
    const dHome = Math.hypot(bot.entity.position.x - settings.home.x, bot.entity.position.z - settings.home.z);
    if (dHome > 6) { S.desiredState = 'busy'; try { await ctx.goHome(); } catch {} if (S.desiredState === 'busy') S.desiredState = 'idle'; }
    const bp = ctx.findBlocks(BED_NAMES, 16, 1)[0];
    if (bp) { const b = bot.blockAt(bp); if (b) { memory.bed = { x: b.position.x, y: b.position.y, z: b.position.z }; ctx.saveMemory(); ctx.say('ベッドはもう拠点にあるよ'); return; } }
  }
  S.bedMode = true; S.soloAbort = false;
  try {
    ctx.say('ベッドを作るね。羊を狩って羊毛を集めてくる');
    S.desiredState = 'busy';
    await ctx.prepareForMission().catch(() => {});
    const resyncViaChest = ctx.resyncViaChest;
    // Already holding a crafted bed item (e.g. an earlier run crafted it
    // but failed to place it)? Skip straight to placement.
    const heldBed = bot.inventory.items().find(i => i.name.endsWith('_bed'));
    if (heldBed && settings.home) {
      console.log(`[bed] already holding ${heldBed.name} — going straight to placement`);
      await ctx.goHome();
      await resyncViaChest();
      const placedHeld = await placeBedInside(heldBed.name);
      if (placedHeld) { memory.bed = placedHeld; ctx.saveMemory(); console.log('[bed] placed at', JSON.stringify(placedHeld)); ctx.say(`ベッドを置いたよ（${placedHeld.x}, ${placedHeld.z}）。夜は寝て朝にできるね`); return; }
      console.log('[bed] held-bed placement failed — falling through to the full flow');
    }
    // A finished bed may be sitting in the home chest (e.g. the placed
    // bed was destroyed and its drop auto-deposited). Reuse it.
    if (settings.home && memory.chest) {
      const cb = (memory.chestContents || []).find(e => e.name.endsWith('_bed'));
      if (cb) {
        console.log(`[bed] withdrawing ${cb.name} from the chest`);
        try { await ctx.withdrawFromChest(cb.name, 1); } catch (e) { console.log('[bed] bed withdraw:', e.message); }
        const bedItem = bot.inventory.items().find(i => i.name.endsWith('_bed'));
        if (bedItem) {
          await ctx.goHome();
          await resyncViaChest();
          const placedChest = await placeBedInside(bedItem.name);
          if (placedChest) { memory.bed = placedChest; ctx.saveMemory(); console.log('[bed] placed at', JSON.stringify(placedChest)); ctx.say(`ベッドを置いたよ（${placedChest.x}, ${placedChest.z}）。夜は寝て朝にできるね`); return; }
          console.log('[bed] chest-bed placement failed — falling through to the full flow');
        }
      }
    }
    const woolOf = () => { const m = {}; for (const i of bot.inventory.items()) if (i.name.endsWith('_wool')) m[i.name] = (m[i.name] || 0) + i.count; return m; };
    const bestWool = () => Object.entries(woolOf()).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    // Wool from an earlier hunt may have been auto-deposited at night.
    if (bestWool()[1] < 3 && settings.home && memory.chest) {
      const w = (memory.chestContents || []).filter(e => e.name.endsWith('_wool')).sort((a, b) => b.count - a.count)[0];
      if (w) { console.log(`[bed] withdrawing ${w.name} from the chest first`); try { await ctx.withdrawFromChest(w.name, 3); } catch (e) { console.log('[bed] wool withdraw:', e.message); } }
    }
    let relocations = 0;
    let spotMisses = 0;
    while (bestWool()[1] < 3 && relocations <= 10 && !S.soloAbort) {
      if (bot.time && !bot.time.isDay) { ctx.say('夜になったからベッド作りは中断するね'); return; }
      const sheep = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && e.name === 'sheep')
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
      if (!sheep || bot.entity.position.distanceTo(sheep.position) > 64) {
        relocations++;
        const p = bot.entity.position;
        // Pair scouting (2026-11-24): a fresh partner-reported spot
        // beats random wandering, and the hunt publishes a help
        // request the idle partner's watcher answers by scouting.
        const sSpot = shared.sheepSpot;
        if (sSpot && Date.now() - sSpot.at < 120000 && Math.hypot(sSpot.x - p.x, sSpot.z - p.z) > 20) {
          console.log(`[bed] heading to partner-reported sheep spot (${sSpot.x}, ${sSpot.z})`);
          shared.sheepSpot = null;
          try { await ctx.gotoWatched(new goals.GoalNear(sSpot.x, sSpot.y, sSpot.z, 6), 70000, 'partner sheep spot'); } catch {}
          await new Promise(r => setTimeout(r, 3500));
          continue;
        }
        if (!shared.sheepReq || Date.now() - shared.sheepReq.at > 60000) shared.sheepReq = { by: bot.username, at: Date.now() };
        const ss = memory.spots.sheep;
        // A stale spot (herd moved on) otherwise traps the hunt in a
        // bounce loop between the spot and random relocations.
        if (ss && Math.hypot(ss.x - p.x, ss.z - p.z) <= 20) { spotMisses++; if (spotMisses >= 2) { console.log('[bed] sheep spot is stale — forgetting it'); delete memory.spots.sheep; ctx.saveMemory(); } }
        if (ss && memory.spots.sheep && Math.hypot(ss.x - p.x, ss.z - p.z) > 20) {
          console.log(`[bed] heading to remembered sheep spot (${ss.x}, ${ss.z})`);
          try { await ctx.gotoWatched(new goals.GoalNear(ss.x, ss.y, ss.z, 6), 70000, 'sheep spot'); } catch {}
        } else {
          console.log('[bed] no sheep nearby — relocating');
          try { await ctx.gotoWatched(new goals.GoalNear(p.x + (Math.random() * 112 - 56), p.y, p.z + (Math.random() * 112 - 56), 3), 50000, 'find sheep'); } catch {}
        }
        // Entities stream in after arriving in fresh chunks; rescan too
        // early and the area looks empty even when sheep are there.
        await new Promise(r => setTimeout(r, 3500));
        continue;
      }
      console.log(`[bed] sheep at ${sheep.position} (${bot.entity.position.distanceTo(sheep.position).toFixed(0)}m)`);
      try { await ctx.gotoWatched(new goals.GoalNear(sheep.position.x, sheep.position.y, sheep.position.z, 2), 40000, 'to sheep'); } catch {}
      const target = bot.entities[sheep.id];
      if (target) { try { await ctx.withTimeout(bot.pvp.attack(target), 25000, 'sheep hunt'); ctx.rememberSpot('sheep'); } catch (e) { console.log('[bed] sheep fight:', e.message); } }
      await new Promise(r => setTimeout(r, 1200));
      for (const d of Object.values(bot.entities).filter(e => e && e.position && e.name === 'item' && bot.entity.position.distanceTo(e.position) <= 10)) {
        try { await ctx.gotoWatched(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 1), 15000, 'wool drop'); await new Promise(r => setTimeout(r, 500)); } catch {}
        if (S.soloAbort) break;
      }
      if (bot.food <= 14) { const f = ctx.bestFoodItem(); if (f) { try { await bot.equip(f, 'hand'); await bot.consume(); } catch {} } }
    }
    const [woolName, woolCount] = bestWool();
    if (!woolName || woolCount < 3) { ctx.say('羊毛が3つ集まらなかった'); return; }
    console.log(`[bed] wool ready: ${woolName} x${woolCount}`);
    // planks: 3 of one kind for the bed, plus 4 more for a crafting table
    // when none is findable (7 total). Night deposits move the bot's
    // planks into the home chest, so when short, go home and withdraw
    // them before trying to gather fresh logs.
    // NOTE: this server's inventory sync produces phantom reads (server
    // truth checked via console 2026-11-23: bot read birch x6 + a table,
    // server had birch x2 and no table). Critical counts are therefore
    // taken with stableCount(): poll until two reads agree.
    const stableCount = ctx.stableCount;
    const plankOf = ctx.C.PLANK_OF;
    const bestPlanks = () => Object.values(plankOf).map(pn => ({ pn, c: ctx.countItem(pn) })).sort((a, b) => b.c - a.c)[0];
    let plankName = bestPlanks();
    const plankNeed = () => ctx.findCraftingTable() ? 3 : 7;
    for (let round = 0; round < 3; round++) {
      if (plankName && await stableCount(plankName.pn) >= plankNeed()) break;
      if (!settings.home) break;
      console.log('[bed] short on planks — going home to withdraw from the chest');
      try {
        await ctx.goHome();
        // Query by exact item name (the JP alias 板材 only maps to oak).
        // Planks first; if the chest is out of planks, withdraw LOGS and
        // convert them (the chest held oak_log x4 while planks ran out).
        const richPlank = (memory.chestContents || []).filter(e => e.name.endsWith('_planks')).sort((a, b) => b.count - a.count)[0];
        if (richPlank) await ctx.withdrawFromChest(richPlank.name, 10);
        plankName = bestPlanks();
        if (plankName && await stableCount(plankName.pn) >= plankNeed()) break;
        const richLog = (memory.chestContents || []).filter(e => e.name.endsWith('_log')).sort((a, b) => b.count - a.count)[0];
        if (richLog) {
          await ctx.withdrawFromChest(richLog.name, 3);
          for (let k = 0; k < 3; k++) {
            const lg = bot.inventory.items().find(i => ctx.C.LOG_TYPES.includes(i.name));
            if (!lg) break;
            await ctx.craftItem(plankOf[lg.name], 1);
            plankName = bestPlanks();
            if (plankName && await stableCount(plankName.pn) >= plankNeed()) break;
          }
        }
      } catch (e) { console.log('[bed] plank withdraw:', e.message); }
      plankName = bestPlanks();
    }
    if (!plankName || await stableCount(plankName.pn) < 3) {
      let log = bot.inventory.items().find(i => ctx.C.LOG_TYPES.includes(i.name));
      if (!log) { await ctx.collectByNames(ctx.C.LOG_TYPES, 2, '原木', 32); log = bot.inventory.items().find(i => ctx.C.LOG_TYPES.includes(i.name)); }
      if (log) await ctx.craftItem(plankOf[log.name], 1);
      plankName = bestPlanks();
    }
    if (!plankName || await stableCount(plankName.pn) < 3) { ctx.say('板材が足りなくてベッドが作れなかった'); return; }
    console.log(`[bed] planks ready: ${plankName.pn} (stable count ${await stableCount(plankName.pn)})`);
    // A table is required for the 3x3 bed recipe. The hut interior is too
    // cramped for table placement (a self-crafted table was lost there),
    // so step outside onto open ground, set the table up there, and only
    // then craft the bed. Block reads are reliable on this server, so
    // findCraftingTable() is the success test.
    if (bot.time && !bot.time.isDay) { ctx.say('夜になったからベッド作りは中断するね'); return; }
    await resyncViaChest();
    if (!ctx.findCraftingTable()) {
      // A table may already sit in the home chest (night deposits put the
      // bot's own crafted table there) — withdraw before crafting anew.
      if (await stableCount('crafting_table') === 0 && settings.home && memory.chest) { try { await ctx.withdrawFromChest('crafting_table', 1); } catch (e) { console.log('[bed] table withdraw:', e.message); } }
      if (await stableCount('crafting_table') === 0) { try { await ctx.craftItem('crafting_table', 1); } catch {} }
      // Place at an EXACT cell with placeBlockAt: placeItemOnGround's
      // scatter search kept failing around the hut (and its failures left
      // the inventory window desynced). Interior cells first, then the
      // spot just outside the door.
      const { Vec3 } = require('vec3');
      const home = settings.home;
      const spots = [];
      if (home) { for (let x = home.x - 1; x <= home.x + 1; x++) for (let z = home.z - 1; z <= home.z + 1; z++) spots.push([x, home.y, z]); spots.push([home.x, home.y, home.z + 3]); }
      for (const [sx, sy, sz] of spots) {
        if (ctx.findCraftingTable()) break;
        const cell = bot.blockAt(new Vec3(sx, sy, sz));
        if (!cell || !(cell.name === 'air' || REPLACEABLE_CELLS.has(cell.name))) continue;
        try { await ctx.gotoWatched(new goals.GoalNear(sx, sy, sz, 2), 20000, 'table spot'); } catch {}
        const ok = await ctx.placeBlockAt(sx, sy, sz, 'crafting_table').catch(() => false);
        console.log(`[bed] placeBlockAt table (${sx}, ${sz}): ${ok}`);
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[bed] table check: ${ctx.findCraftingTable() ? 'ready' : 'STILL NONE'}`);
      if (!ctx.findCraftingTable()) { ctx.say('作業台が用意できなくてベッドが作れなかった'); return; }
    }
    const bedName = woolName.replace('_wool', '_bed');
    await resyncViaChest();
    if (!await ctx.craftItem(bedName, 1)) { ctx.say('ベッドのクラフトに失敗しちゃった'); return; }
    if (!settings.home) { ctx.say('拠点がないからベッドを置けなかった'); return; }
    await ctx.goHome();
    await resyncViaChest();
    const placed = await placeBedInside(bedName);
    if (placed) { memory.bed = placed; ctx.saveMemory(); console.log('[bed] placed at', JSON.stringify(placed)); ctx.say(`ベッドを置いたよ（${placed.x}, ${placed.z}）。夜は寝て朝にできるね`); }
    else ctx.say('ベッドを置くスペースが確保できなかった');
  } catch (e) { console.log('[bed] failed:', e.message); ctx.say('ベッド作りに失敗しちゃった'); }
  finally { S.bedMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
};
// ---- missing-fixture recovery (user request 2026-11-23) ----
// The home chest and furnace can be destroyed (a creeper took both,
// plus the door, on 2026-11-23) while memory keeps pointing at the
// cell and the stale contents snapshot keeps lying to every caller —
// deposits and withdraws then just fail forever. Detect it, rebuild
// the fixture at the remembered cell from crafted / gathered /
// partner-borrowed materials, and reset the snapshot to the truth.
async function obtainFixtureItem(kind) {
  if (kind === 'chest') {
    if (ctx.countItem('chest') > 0) return true;
    const plankTotal = () => bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
    const tryCraftChest = async () => { try { await ctx.craftItem('chest', 1); } catch (e) { console.log('[fixture] craft chest:', e.message); } return ctx.countItem('chest') > 0; };
    // One craft operation per call, re-reading the inventory each round:
    // a multi-craft bot.craft under this server's lag silently delivers
    // a single batch (live 2026-11-23: asked for 2 crafts, got 4 planks
    // and the rebuild starved at half the wood it needed).
    const logsToPlanks = async () => {
      for (let round = 0; round < 6 && plankTotal() < 8; round++) {
        const logs = bot.inventory.items().filter(i => i.name.endsWith('_log'));
        if (!logs.length) break;
        logs.sort((a, b) => b.count - a.count);
        try { await ctx.craftItem(logs[0].name.replace('_log', '_planks'), 1); } catch {}
      }
    };
    if (plankTotal() >= 8 && await tryCraftChest()) return true;
    await logsToPlanks();
    if (plankTotal() >= 8 && await tryCraftChest()) return true;
    try { if (await ctx.askPartnerFor('chest', 1)) return true; } catch {}
    try { await ctx.collectByNames(ctx.C.LOG_TYPES, 3, 'chest wood'); } catch (e) { console.log('[fixture] gather logs:', e.message); }
    await logsToPlanks();
    if (plankTotal() >= 8 && await tryCraftChest()) return true;
    return ctx.countItem('chest') > 0;
  }
  // A 3x3 craft with no reachable crafting table needs 4 planks in hand
  // so craftItem can make itself a table on the spot. The hut's own table
  // died in the same blast as the chest and furnace (verified 2026-11-23),
  // so this can no longer be assumed.
  const ensureTableStock = async () => {
    if (ctx.findCraftingTable() || ctx.countItem('crafting_table') > 0) return;
    const planks = () => bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0);
    if (planks() >= 4) return;
    if (!bot.inventory.items().some(i => i.name.endsWith('_log'))) { try { await ctx.collectByNames(ctx.C.LOG_TYPES, 1, '原木', 32); } catch {} }
    const log = bot.inventory.items().find(i => i.name.endsWith('_log'));
    if (log) { try { await ctx.craftItem(log.name.replace('_log', '_planks'), 1); } catch {} }
  };
  // furnace: craft from 8 cobblestone, gathering the stone if needed.
  // Two gather+craft rounds: a phantom inventory read once let a craft
  // start on stone that was not really there (furnishBase, 2026-11-23).
  if (ctx.countItem('furnace') > 0) return true;
  for (let attempt = 0; attempt < 2 && ctx.countItem('furnace') === 0; attempt++) {
    if (ctx.countItem('cobblestone') < 8) { try { await ctx.gatherCobble(8); } catch (e) { console.log('[fixture] gather cobble:', e.message); } }
    if (ctx.countItem('cobblestone') >= 8) { await ensureTableStock(); try { await ctx.craftItem('furnace', 1); } catch (e) { console.log('[fixture] craft furnace:', e.message); } }
  }
  if (ctx.countItem('furnace') === 0) { try { if (await ctx.askPartnerFor('furnace', 1)) return true; } catch {} }
  return ctx.countItem('furnace') > 0;
}
ctx.ensureHomeFixture = async function (kind) {
  const { Vec3 } = require('vec3');
  const mem = kind === 'chest' ? memory.chest : memory.furnace;
  if (!mem || !settings.home) return null;
  const cell = new Vec3(mem.x, mem.y, mem.z);
  const cur = bot.blockAt(cell);
  if (cur && cur.name === kind) return cur;
  // One rebuild per kind across both bodies, at most every 4 minutes —
  // a failed rebuild must not turn into a spam loop.
  if (shared.fixtureFix[kind] && Date.now() - shared.fixtureFix[kind] < 240000) return null;
  shared.fixtureFix[kind] = Date.now();
  console.log(`[fixture] home ${kind} missing (cell is ${cur ? cur.name : 'unloaded'}) — rebuilding`);
  ctx.say(`${kind === 'chest' ? 'チェスト' : 'かまど'}がなくなってる！作り直すね`);
  // Flagged as mission work: unflagged, the auto-pickup behavior kept
  // cancelling the rebuild's gotos mid-craft (live 2026-11-23).
  S.fixtureMode = true;
  // Hold busy for the rebuild's own gotos AND stop the finally from
  // clearing a CALLER's busy (deposit/withdraw call this mid-flow;
  // audit 2026-11-25).
  const fixtureWasBusy = S.desiredState === 'busy';
  S.desiredState = 'busy';
  try {
    try { await ctx.goHome(); } catch {}
    try { await ctx.gotoWatched(new goals.GoalNear(cell.x, cell.y, cell.z, 2), 30000, 'fixture approach'); } catch {}
    const here = bot.blockAt(cell);
    if (here && here.name === kind) return here; // false alarm: chunk was just unloaded
    if (!await obtainFixtureItem(kind)) { console.log(`[fixture] could not obtain a ${kind}`); ctx.say('材料が足りなくて作り直せなかった'); return null; }
    const occ = bot.blockAt(cell);
    if (occ && occ.name !== 'air' && !REPLACEABLE_CELLS.has(occ.name) && occ.name !== kind) { try { await ctx.withTimeout(bot.dig(occ), 20000, 'fixture clear cell'); } catch (e) { console.log('[fixture] clear cell:', e.message); } }
    const ok = await ctx.placeBlockAt(cell.x, cell.y, cell.z, kind);
    const after = bot.blockAt(cell);
    if (!ok || !after || after.name !== kind) { console.log(`[fixture] placement of ${kind} failed (cell now ${after ? after.name : '?'})`); return null; }
    console.log(`[fixture] home ${kind} rebuilt at ${cell.x},${cell.y},${cell.z}`);
    if (kind === 'chest') {
      // The old contents are gone with the old chest; forget them.
      memory.chestContents = []; ctx.saveMemory();
      try { const c = await bot.openContainer(after); ctx.snapshotChest(c); try { c.close(); } catch {} } catch {}
      ctx.say('チェストを作り直したよ（中身は空っぽから）');
    } else ctx.say('かまどを作り直したよ');
    return after;
  } catch (e) { console.log('[fixture] rebuild failed:', e.message); return null; }
  finally { S.fixtureMode = false; if (!fixtureWasBusy && S.desiredState === 'busy') S.desiredState = 'idle'; }
};
ctx.ensureHomeChest = function () { return ctx.ensureHomeFixture('chest'); };
ctx.findHomeChest = function () {
  // Locate the chest at the base (bot must be near home) and remember it.
  if (!settings.home) return null;
  const found = ctx.findBlocks(['chest', 'trapped_chest'], 24, 4);
  const blocks = found.map(p => bot.blockAt(p)).filter(b => b && (b.name === 'chest' || b.name === 'trapped_chest'));
  blocks.sort((a, b) => (Math.abs(a.position.x - settings.home.x) + Math.abs(a.position.z - settings.home.z)) - (Math.abs(b.position.x - settings.home.x) + Math.abs(b.position.z - settings.home.z)));
  if (blocks.length) {
    const np = { x: blocks[0].position.x, y: blocks[0].position.y, z: blocks[0].position.z };
    if (JSON.stringify(memory.chest) !== JSON.stringify(np)) { memory.chest = np; ctx.saveMemory(); console.log('[memory] home chest at', JSON.stringify(np)); }
    return blocks[0];
  }
  if (memory.chest) {
    // The old fallback returned blockAt(memory.chest) unchecked: with a
    // phantom view that hands openContainer a non-chest (or nothing) and
    // every deposit/withdraw dies with "containerToOpen is neither a
    // block nor an entity" (live 2026-11-23 night). Scan the remembered
    // neighbourhood for a block actually named chest instead.
    const { Vec3 } = require('vec3');
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
      const b = bot.blockAt(new Vec3(memory.chest.x + dx, memory.chest.y + dy, memory.chest.z + dz));
      if (b && (b.name === 'chest' || b.name === 'trapped_chest')) return b;
    }
  }
  return null;
}
ctx.containerItems = function (container) {
  // container.items() on this stack returns the PLAYER's side of the window;
  // the container's own slots are [0, inventoryStart). (Live 2026-11-23: a
  // snapshot after depositing read back the bot's kept food/tools.)
  try {
    const start = (typeof container.inventoryStart === 'number') ? container.inventoryStart : 27;
    return (container.slots || []).slice(0, start).filter(Boolean);
  } catch { return []; }
}
ctx.snapshotChest = function (container) {
  try { memory.chestContents = ctx.containerItems(container).map(i => ({ name: i.name, count: i.count })); ctx.saveMemory(); console.log('[memory] chest snapshot:', memory.chestContents.map(i => `${i.name}x${i.count}`).join(', ') || '(empty)'); } catch {}
}

};
