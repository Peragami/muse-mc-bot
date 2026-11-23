module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { LOG_TYPES, PLANK_OF } = ctx.C;
ctx.smeltCharcoalImpl = async function (n) {
  // Prefer the remembered furnace position: findBlocks' id mapping
  // missed a furnace the bot had placed itself seconds earlier.
  const { Vec3 } = require('vec3');
  let fpos = null;
  if (memory.furnace) { const b = bot.blockAt(new Vec3(memory.furnace.x, memory.furnace.y, memory.furnace.z)); if (b && b.name === 'furnace') fpos = b.position; }
  if (!fpos) fpos = ctx.findBlocks(['furnace'], 16, 1)[0];
  if (!fpos) throw new Error('かまどが見つからない');
  // Walk to the furnace first: openFurnace from out of reach just
  // times out on windowOpen (the repair's perimeter-torch smelts
  // failed exactly this way, 2026-11-24).
  if (bot.entity && bot.entity.position.distanceTo(fpos.offset(0.5, 0.5, 0.5)) > 3) {
    try { await ctx.gotoWatched(new goals.GoalNear(fpos.x, fpos.y, fpos.z, 2), 25000, 'to furnace'); } catch {}
  }
  const block = bot.blockAt(fpos);
  const furnace = await bot.openFurnace(block);
  try {
    // Clear leftovers from an earlier cook first: a clogged input or
    // fuel slot makes putInput/putFuel throw 'destination full'
    // (the base-repair torches failed exactly this way, 2026-11-23).
    try { if (furnace.inputItem()) await furnace.takeInput(); } catch {}
    try { if (furnace.fuelItem()) await furnace.takeFuel(); } catch {}
    try { if (furnace.outputItem()) await furnace.takeOutput(); } catch {}
    const fuel = bot.inventory.items().find(i => i.name.endsWith('_planks')) || bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
    if (!fuel) throw new Error('燃料がない');
    await furnace.putFuel(fuel.type, null, 3);
    const log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
    if (!log) throw new Error('原木がない');
    await furnace.putInput(log.type, null, n);
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const out = furnace.outputItem();
      if (out && out.count >= n) break;
      if (S.soloAbort) break;
    }
    const out = furnace.outputItem();
    if (out) await furnace.takeOutput();
    await new Promise(r => setTimeout(r, 800));
  } finally { try { if (furnace.close) furnace.close(); else bot.closeWindow(furnace.window); } catch {} }
  return ctx.countItem('charcoal');
}
ctx.smeltCharcoal = async function (n) { await ctx.acquireLock('furnace'); try { return await ctx.smeltCharcoalImpl(n); } finally { ctx.releaseLock('furnace'); } };
ctx.ensureWoodenSword = async function () {
  if (!bot.inventory) return false;
  if (bot.inventory.items().some(i => i.name.endsWith('_sword'))) return true;
  console.log('[sword] crafting a wooden sword before heading back');
  ctx.say('先に木の剣を作るね');
  if (ctx.countItem('stick') < 1) { try { await ctx.craftItem('stick', 1); } catch {} }
  let p = bot.inventory.items().find(i => i.name.endsWith('_planks'));
  if (!p || p.count < 6) { // sword 2 + a crafting table 4 if none is around
    let log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name));
    if (!log) { await ctx.collectByNames(LOG_TYPES, 2, '原木', 32); log = bot.inventory.items().find(i => LOG_TYPES.includes(i.name)); }
    if (log) { try { await ctx.craftItem(PLANK_OF[log.name], 1); } catch {} if (ctx.countItem('stick') < 1) { try { await ctx.craftItem('stick', 1); } catch {} } }
  }
  p = bot.inventory.items().find(i => i.name.endsWith('_planks'));
  if (!p) return false;
  const swordName = 'wooden_sword'; // not per-wood: oak_planks -> "oak_sword" is not an item
  const ok = await ctx.craftItem(swordName, 1);
  if (ok) { const sw = bot.inventory.items().find(i => i.name === swordName); if (sw) { try { await bot.equip(sw, 'hand'); } catch {} } console.log('[sword] wooden sword ready'); }
  return ok;
}
// Pre-mission check (user-approved improvement 2026-11-23): the bot died
// twice during the bed sheep hunt, bare-handed and hungry. Before a long
// mission: hold a weapon, wear any armor, eat to near-full.
ctx.prepareForMission = async function () {
  try { await ctx.ensureWoodenSword(); } catch (e) { console.log('[prep] sword:', e.message); }
  const weapon = bot.inventory.items().filter(i => i.name.endsWith('_sword')).sort((a, b) => b.name.localeCompare(a.name))[0]
    || bot.inventory.items().find(i => i.name.endsWith('_axe')) || bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
  if (weapon) { try { await bot.equip(weapon, 'hand'); } catch {} }
  try { await bot.armorManager.equipAll(); } catch {}
  for (let i = 0; i < 4 && bot.food < 18; i++) {
    const f = ctx.bestFoodItem();
    if (!f) break;
    try { await bot.equip(f, 'hand'); await bot.consume(); } catch { break; }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[prep] ready: weapon=${weapon ? weapon.name : 'none'} food=${bot.food} health=${bot.health}`);
}
// Walk back to the registered base. Caller owns S.desiredState ('busy').
ctx.findCraftingTable = function () {
  const pos = ctx.findBlocks(['crafting_table'], 16, 1);
  if (pos.length) { const b = bot.blockAt(pos[0]); if (b && b.name === 'crafting_table') return b; }
  // findBlocks' id mapping misses placed crafting tables on this server
  // (placeBlockAt verified one at the base while findBlocks saw none).
  // Fall back to a direct blockAt scan — name reads have been reliable.
  if (!bot.entity) return null;
  const { Vec3 } = require('vec3');
  const base = bot.entity.position.floored();
  for (let r = 0; r <= 16; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const b = bot.blockAt(new Vec3(base.x + dx, base.y + dy, base.z + dz));
        if (b && b.name === 'crafting_table') return b;
      }
    }
  }
  return null;
}
ctx.craftItem = async function (itemName, count = 1) {
  const item = bot.registry.itemsByName[itemName];
  if (!item) { ctx.say(`${itemName} というアイテムが分からない`); return false; }
  let table = ctx.findCraftingTable();
  // Walk up to the table first: crafting against a table left behind in a shaft
  // silently fails when it is more than a few blocks away.
  if (table && bot.entity && bot.entity.position.distanceTo(table.position) > 3) {
    try { await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2)), 30000, 'goto table'); table = ctx.findCraftingTable() || table; } catch (e) {
      console.log('[craft] goto table:', e.message);
      // Recovery: an unreachable table (across a shaft, another level) must not sink
      // the craft. Place the carried table right here, or craft a fresh one (2x2 recipe).
      try {
        if (ctx.countItem('crafting_table') > 0) { await ctx.placeItemOnGround('crafting_table'); }
        else {
          const plankItem = bot.inventory.items().find(i => i.name.endsWith('_planks') && i.count >= 4);
          if (plankItem) { const rs = bot.recipesFor(bot.registry.itemsByName['crafting_table'].id, null, 1, null) || []; if (rs.length) { await bot.craft(rs[0], 1); await new Promise(r => setTimeout(r, 800)); if (ctx.countItem('crafting_table') > 0) await ctx.placeItemOnGround('crafting_table'); } }
        }
        table = ctx.findCraftingTable() || table;
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
      try { await ctx.placeItemOnGround('crafting_table'); await new Promise(r=>setTimeout(r,500)); table = ctx.findCraftingTable(); if (table) recipes = bot.recipesFor(item.id, null, 1, table) || []; }
      catch (e) { console.log('[craft] place table failed:', e.message); }
    } else {
      // No table nearby and none carried: craft one from planks (2x2
      // recipe) and place it — 3x3 recipes like beds silently failed
      // without this (found live 2026-11-23, white_bed at the base).
      try {
        const plankItem = bot.inventory.items().find(i => i.name.endsWith('_planks') && i.count >= 4);
        if (plankItem) {
          const rs = bot.recipesFor(bot.registry.itemsByName['crafting_table'].id, null, 1, null) || [];
          if (rs.length) { await bot.craft(rs[0], 1); await new Promise(r => setTimeout(r, 800)); }
          if (ctx.countItem('crafting_table') > 0) { await ctx.placeItemOnGround('crafting_table'); await new Promise(r => setTimeout(r, 500)); table = ctx.findCraftingTable(); if (table) recipes = bot.recipesFor(item.id, null, 1, table) || []; }
          console.log(`[craft] table self-craft: now ${table ? 'have table' : 'still none'}`);
        }
      } catch (e) { console.log('[craft] craft table failed:', e.message); }
    }
  }
  if (!recipes.length) {
    // Fallback: recipesFor's delta check can reject recipes we actually have materials for
    // (e.g. ingredients split across stacks). If recipesAll knows the recipe, try crafting it anyway.
    try {
      const all = bot.recipesAll ? bot.recipesAll(item.id, null, table) : [];
      if (all && all.length) {
        console.log(`[craft] ${itemName}: recipesFor empty, trying recipesAll fallback`);
        const before = ctx.countItem(itemName);
        await bot.craft(all[0], count, table || undefined);
        for (let i = 0; i < 8 && ctx.countItem(itemName) <= before; i++) await new Promise(r => setTimeout(r, 1000));
        if (ctx.countItem(itemName) > before) { ctx.say(`${itemName}を作った`); return true; }
        ctx.say(`${itemName}: 素材が足りないみたい`); return false;
      }
      ctx.say(`${itemName}: レシピが見つからない（作業台が要るかも）`);
    } catch (e) { console.log(`[craft] ${itemName} fallback failed: ${e.message}`); ctx.say(`${itemName}: 素材不足か作業台不足`); }
    return false;
  }
  const beforeCount = ctx.countItem(itemName);
  try {
    // 'missing ingredient' can fire spuriously while inventory is still syncing; retry a few times.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await bot.craft(recipes[0], count, table || undefined); lastErr = null; break; }
      catch (e) { lastErr = e; console.log(`[craft] ${itemName} attempt ${attempt + 1} failed: ${e.message}`); await new Promise(r => setTimeout(r, 2000)); const rs = bot.recipesFor(item.id, null, 1, table) || []; if (rs.length) recipes = rs; }
    }
    if (lastErr) throw lastErr;
    for (let i = 0; i < 10 && ctx.countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
    // Verify the item actually arrived; a "successful" bot.craft under lag can produce nothing
    // (wooden_pickaxe in run10: craft returned, inventory unchanged). Retry the craft itself.
    for (let retry = 0; retry < 2 && ctx.countItem(itemName) <= beforeCount; retry++) {
      // The first craft's product can land AFTER the verify window above; re-poll
      // briefly before spending ingredients on a duplicate (live 2026-11-23: a lagged
      // crafting_table craft produced 2 tables and starved the pickaxe of planks).
      for (let i = 0; i < 5 && ctx.countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
      if (ctx.countItem(itemName) > beforeCount) break;
      console.log(`[craft] ${itemName}: no item after craft, retry ${retry + 1}`);
      const t2 = ctx.findCraftingTable() || table; const rs = bot.recipesFor(item.id, null, 1, t2) || recipes;
      try { await bot.craft(rs[0], count, t2 || undefined); } catch (e) { console.log(`[craft] ${itemName} retry failed: ${e.message}`); }
      for (let i = 0; i < 8 && ctx.countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
    }
    if (ctx.countItem(itemName) <= beforeCount) {
      // Final settle attempt: pause, refresh table + recipes, one last craft.
      // Silent no-op crafts on this slow CT cleared after a pause in the
      // 2026-11-23 pickaxe run once the mission retried from the outside.
      console.log(`[craft] ${itemName}: final settle attempt`);
      await new Promise(r => setTimeout(r, 5000));
      const t3 = ctx.findCraftingTable() || table; const rs3 = bot.recipesFor(item.id, null, 1, t3) || [];
      if (rs3.length) { try { await bot.craft(rs3[0], count, t3 || undefined); } catch (e) { console.log(`[craft] ${itemName} final attempt failed: ${e.message}`); } }
      for (let i = 0; i < 8 && ctx.countItem(itemName) <= beforeCount; i++) await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`[craft] ${itemName}: ${beforeCount} -> ${ctx.countItem(itemName)}`);
    if (ctx.countItem(itemName) <= beforeCount) return false;
    ctx.say(`${itemName}を作った`); return true; }
  catch (e) { ctx.fail(`${itemName}のクラフト失敗`, e); return false; }
}

};
