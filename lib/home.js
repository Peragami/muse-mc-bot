module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { REPLACEABLE_CELLS, JP_ITEMS, DEPOSIT_KEEP } = ctx.C;
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
  ];
  const ref = refs.find(r => r.b && r.b.boundingBox === 'block');
  if (!ref) { console.log(`[build] no reference block for ${itemName} at ${x},${y},${z}`); return false; }
  if (bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4) {
    try { await ctx.gotoWatched(new goals.GoalNear(x, y, z, 3), 15000, 'build move'); } catch {}
  }
  try { await bot.equip(item, 'hand'); } catch {}
  try { await ctx.withTimeout(bot.placeBlock(ref.b, ref.f), 10000, 'placeBlock'); } catch (e) { console.log(`[build] place ${itemName} at ${x},${y},${z}: ${e.message}`); return false; }
  await new Promise(r => setTimeout(r, 350));
  const after = bot.blockAt(target);
  return !!after && after.name === itemName;
}
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
ctx.closeDoorNear = function () {
  try {
    const doors = ctx.findBlocks(['oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'iron_door'], 6, 4);
    for (const p of doors) {
      const b = bot.blockAt(p); if (!b) continue;
      const props = b.getProperties ? b.getProperties() : {};
      if (props.open === 'true' || props.open === true) { bot.activateBlock(b); console.log('[home] closed the door'); }
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

ctx.depositToChest = async function () {
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
      if (!pos.length) { ctx.say('近くにチェストが見つからない'); return; }
      chestBlock = bot.blockAt(pos[0]);
      if (chestBlock) { memory.chest = { x: chestBlock.position.x, y: chestBlock.position.y, z: chestBlock.position.z }; ctx.saveMemory(); }
    }
    if (!chestBlock) { ctx.say('チェストが見つからない'); return; }
    await ctx.gotoWatched(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 30000, 'to chest');
    const chest = await bot.openContainer(chestBlock);
    let n = 0;
    for (const item of [...bot.inventory.items()]) {
      if (DEPOSIT_KEEP(item.name) || ctx.isFood(item.name)) continue;
      try { await chest.deposit(item.type, null, item.count); n += item.count; } catch (e) { console.log('[deposit]', item.name, e.message); }
    }
    ctx.snapshotChest(chest);
    try { chest.close(); } catch {}
    ctx.say(n ? `素材を${n}個預けた` : '預けるものがなかった（食料とツールは手元に残す）');
  } catch (e) { ctx.fail('預けられなかった', e); } finally { if (S.desiredState === 'busy') S.desiredState = 'idle'; }
}
ctx.withdrawFromChest = async function (query) {
  const name = JP_ITEMS[query] || query;
  if (!settings.home) { ctx.say('拠点がまだないからチェストもないよ'); return; }
  try {
    S.desiredState = 'busy';
    await ctx.goHome();
    const chestBlock = ctx.findHomeChest();
    if (!chestBlock) { ctx.say('拠点のチェストが見つからない'); return; }
    await ctx.gotoWatched(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 30000, 'to chest');
    const chest = await bot.openContainer(chestBlock);
    const inChest = ctx.containerItems(chest);
    const item = inChest.find(i => i.name === name) || inChest.find(i => i.name.includes(name));
    if (!item) { ctx.snapshotChest(chest); try { chest.close(); } catch {} ctx.say(`${query}はチェストに入ってない`); return; }
    const cnt = item.count;
    await chest.withdraw(item.type, null, cnt);
    ctx.snapshotChest(chest);
    try { chest.close(); } catch {}
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

ctx.findHomeChest = function () {
  // Locate the chest at the base (bot must be near home) and remember it.
  if (!settings.home) return null;
  const found = ctx.findBlocks(['chest', 'trapped_chest'], 24, 4);
  const blocks = found.map(p => bot.blockAt(p)).filter(Boolean);
  blocks.sort((a, b) => (Math.abs(a.position.x - settings.home.x) + Math.abs(a.position.z - settings.home.z)) - (Math.abs(b.position.x - settings.home.x) + Math.abs(b.position.z - settings.home.z)));
  if (blocks.length) {
    const np = { x: blocks[0].position.x, y: blocks[0].position.y, z: blocks[0].position.z };
    if (JSON.stringify(memory.chest) !== JSON.stringify(np)) { memory.chest = np; ctx.saveMemory(); console.log('[memory] home chest at', JSON.stringify(np)); }
    return blocks[0];
  }
  if (memory.chest) { const { Vec3 } = require('vec3'); return bot.blockAt(new Vec3(memory.chest.x, memory.chest.y, memory.chest.z)); }
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
