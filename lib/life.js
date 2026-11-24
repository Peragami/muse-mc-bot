module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { FOOD_ORDER, HOSTILES, PREY } = ctx.C;
ctx.isFood = function (name) { try { const f = bot.registry.foodsByName; return !!(f && f[name]); } catch { return false; } }
ctx.bestFoodItem = function () {
  if (!bot.inventory) return null;
  const items = bot.inventory.items();
  for (const n of FOOD_ORDER) { const it = items.find(i => i.name === n); if (it) return it; }
  return items.find(i => ctx.isFood(i.name)) || null;
}
ctx.nearestPrey = function (range = 24) {
  if (!bot.entity) return null;
  const es = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && PREY.has(e.name) && bot.entity.position.distanceTo(e.position) <= range);
  es.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
  return es[0] || null;
}
// ---- auto behaviors (dashboard-toggleable) ----
// Entities that proved unreachable/unkillable get skipped for a while —
// without this the tick retried the same stuck drop / kiting skeleton every
// 3s forever (seen live 2026-11-23).
const pickupBan = new Map();
const fightBan = new Map();
// Record a fight that ended without a kill. Bans escalate 3 -> 10 ->
// 30 minutes: the old flat 90-second ban expired and the bot re-engaged
// the same unreachable mob (roof spider, shade zombie, husks) forever.
const noteNoKill = (e) => {
  const rec = fightBan.get(e.id) || { strikes: 0, until: 0, x: e.position ? e.position.x : 0, z: e.position ? e.position.z : 0 };
  rec.strikes++;
  if (e.position) { rec.x = e.position.x; rec.z = e.position.z; }
  const mins = [3, 10, 30][Math.min(rec.strikes, 3) - 1];
  rec.until = Date.now() + mins * 60 * 1000;
  fightBan.set(e.id, rec);
  console.log(`[fight] ${e.name} is not dying (strike ${rec.strikes}) — leaving it alone for ${mins} min`);
};
ctx.nearestFightable = function (range = 8) {
  if (!bot.entity) return null;
  const now = Date.now();
  const es = Object.values(bot.entities).filter(e => {
    if (!e || e === bot.entity || !e.position || !HOSTILES.has(e.name)) return false;
    const d = bot.entity.position.distanceTo(e.position);
    if (d > range) return false;
    const rec = fightBan.get(e.id);
    if (rec) {
      if (rec.until > now) return false; // serving a ban
      if (rec.strikes >= 1 && d > 5) return false; // repeat offender: only when it comes close
    }
    // A mob standing where a heavily-banned one loitered (roof, wall
    // top) is the same unreachable spot — don't bite unless it is
    // right on top of the bot.
    if (d > 4) { for (const r of fightBan.values()) { if (r.strikes >= 3 && r.until > now && Math.hypot(e.position.x - r.x, e.position.z - r.z) < 6) return false; } }
    return true;
  });
  es.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
  return es[0] || null;
}
setInterval(async () => {
  try {
    if (!bot.entity || !bot.inventory || S.autoBusy) return;
    // Keep the best armor worn (checked every 30s while idle).
    if (settings.autoEquip && !ctx.anyMissionActive() && !S.nightMode && Date.now() - S.lastEquipAt > 30000) {
      S.lastEquipAt = Date.now();
      try { await bot.armorManager.equipAll(); } catch {}
    }
    // Eat when hungry (health only regens while fed). 15s cooldown.
    if (settings.autoEat && bot.food <= 14 && Date.now() - S.lastEatAt > 15000) {
      const food = ctx.bestFoodItem();
      if (food) {
        S.autoBusy = true; S.autoLabel = '食事中'; S.lastEatAt = Date.now();
        console.log(`[auto] eating ${food.name} (food=${bot.food})`);
        try { await bot.equip(food, 'hand'); await bot.consume(); } catch (e) { console.log('[auto] eat failed:', e.message); }
        S.autoBusy = false; S.autoLabel = '';
        return;
      }
    }
    // No food at all and getting hungry: hunt a nearby passive animal.
    if (settings.autoEat && !ctx.anyMissionActive() && !S.nightMode && Date.now() - S.lastHuntAt > 60000) {
      const foodCount = bot.inventory.items().filter(i => ctx.isFood(i.name)).reduce((a, i) => a + i.count, 0);
      if (foodCount === 0 && bot.food <= 16) {
        const prey = ctx.nearestPrey(24);
        if (prey) {
          S.lastHuntAt = Date.now();
          S.autoBusy = true; S.autoLabel = '食料を狩り中'; S.desiredState = 'busy';
          console.log(`[auto] no food — hunting ${prey.name}`);
          ctx.say('食べ物がないから狩ってくるね');
          const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe'));
          if (weapon) { try { await bot.equip(weapon, 'hand'); } catch {} }
          try { await ctx.withTimeout(bot.pvp.attack(prey), 20000, 'hunt'); } catch (e) { console.log('[auto] hunt failed:', e.message); }
          if (S.desiredState === 'busy') S.desiredState = 'idle';
          S.autoBusy = false; S.autoLabel = '';
          return; // the drops are collected by the pickup branch on later ticks
        }
      }
    }
    // Proactive stockpile (user-approved 2026-11-23): on a calm day,
    // keep at least 6 food items instead of waiting for an empty belly.
    if (settings.autoEat && !ctx.anyMissionActive() && !S.nightMode && bot.time && bot.time.isDay && Date.now() - S.lastStockAt > 300000) {
      const foodCount = bot.inventory.items().filter(i => ctx.isFood(i.name)).reduce((a, i) => a + i.count, 0);
      if (foodCount < 6 && bot.food > 12) {
        const prey = ctx.nearestPrey(32);
        if (prey) {
          S.lastStockAt = Date.now();
          S.autoBusy = true; S.autoLabel = '備蓄の狩り中'; S.desiredState = 'busy';
          console.log(`[auto] stockpile hunt (food=${foodCount}) — ${prey.name}`);
          const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe'));
          if (weapon) { try { await bot.equip(weapon, 'hand'); } catch {} }
          try { await ctx.withTimeout(bot.pvp.attack(prey), 20000, 'stockpile hunt'); } catch (e) { console.log('[auto] stockpile hunt failed:', e.message); }
          if (S.desiredState === 'busy') S.desiredState = 'idle';
          S.autoBusy = false; S.autoLabel = '';
          return;
        }
      }
    }
    // Cooperation (lib/coop.js): rush to a partner who is fighting, and
    // deliver items a partner asked for — before starting anything else.
    if (!ctx.anyMissionActive() && !S.nightMode) {
      if (ctx.tryAssist && ctx.tryAssist()) return;
      if (ctx.tryDeliver && ctx.tryDeliver()) return;
    }
    // Fight hostiles that come close (not during missions: checkDanger covers
    // step boundaries there; not during night survival: its loop fights too).
    if (settings.autoFight && !ctx.anyMissionActive() && !S.nightMode) {
      // Survival first: at low health, do not start a fight bare-handed —
      // fall back and eat to regen. (A 17hp fist-fight vs husk+enderman
      // killed the bot in the 2026-11-23 live test.) The retreat decision
      // uses ANY hostile, even one we stopped trying to kill.
      const hAny = ctx.nearestHostile(8);
      if (hAny && bot.health <= 10) {
        S.autoBusy = true; S.autoLabel = '撤退中'; S.desiredState = 'busy';
        console.log(`[auto] health low (${bot.health}) — retreating from ${hAny.name}`);
        ctx.say('体力が少ないから逃げるね');
        try {
          // Pathfinding is too slow on this server to trust in an emergency
          // (retreat gotos timed out deciding while a skeleton kept
          // shooting, 2026-11-23): sprint straight away first.
          const { Vec3 } = require('vec3');
          const p = bot.entity.position;
          const away = new Vec3(p.x + (p.x - hAny.position.x) * 3, p.y + 1.6, p.z + (p.z - hAny.position.z) * 3);
          try {
            await bot.lookAt(away, true);
            bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 600));
            bot.setControlState('jump', false);
            await new Promise(r => setTimeout(r, 2900));
            bot.clearControlStates();
          } catch {}
          if (!ctx.nearestHostile(10)) {
            const food = ctx.bestFoodItem();
            if (food && bot.food < 20) { try { await bot.equip(food, 'hand'); await bot.consume(); S.lastEatAt = Date.now(); } catch {} }
          }
        } catch (e) { console.log('[auto] retreat failed:', e.message); }
        if (S.desiredState === 'busy') S.desiredState = 'idle';
        S.autoBusy = false; S.autoLabel = '';
        return;
      }
      const h = S.fishingMode ? null : ctx.nearestFightable(8);
      if (h) {
        S.autoBusy = true; S.autoLabel = '戦闘中'; S.desiredState = 'busy';
        const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe')) || bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
        if (weapon) { try { await bot.equip(weapon, 'hand'); } catch {} }
        console.log(`[auto] fighting ${h.name} at ${bot.entity.position.distanceTo(h.position).toFixed(1)}m`);
        // Survival-first combat (safeFight): kite melee mobs, rush
        // shooters, abort when hurt. If hurt: break off, eat,
        // regenerate to near-full, then take ONE rematch — winning
        // slowly beats dying fast (user request 2026-11-23).
        if (bot.health < 18 && bot.entity.position.distanceTo(h.position) > 5) { const f0 = ctx.bestFoodItem(); if (f0 && bot.food < 19) { try { await bot.equip(f0, 'hand'); await bot.consume(); } catch {} } }
        let res = 'timeout';
        try { res = await ctx.safeFight(h, { timeout: 90000 }); } catch (e) { console.log('[auto] safeFight error:', e.message); }
        console.log(`[auto] safeFight vs ${h.name}: ${res} (health=${bot.health})`);
        if (res === 'hurt') {
          try { bot.setControlState('back', true); bot.setControlState('sprint', true); await new Promise(r => setTimeout(r, 2500)); bot.clearControlStates(); } catch {}
          for (let i = 0; i < 4 && bot.food < 19; i++) { const f = ctx.bestFoodItem(); if (!f) break; try { await bot.equip(f, 'hand'); await bot.consume(); } catch { break; } }
          const waitUntil = Date.now() + 45000;
          while (bot.health < 18 && Date.now() < waitUntil) { if (ctx.nearestHostile(6)) break; await new Promise(r => setTimeout(r, 2000)); }
          const again = bot.entities[h.id];
          if (again && again.position && bot.health >= 16 && bot.entity.position.distanceTo(again.position) <= 16) {
            const w2 = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe'));
            if (w2) { try { await bot.equip(w2, 'hand'); } catch {} }
            console.log(`[auto] rematch vs ${h.name} at health=${bot.health}`);
            try { res = await ctx.safeFight(again, { timeout: 90000 }); } catch (e) { console.log('[auto] rematch error:', e.message); res = 'timeout'; }
            console.log(`[auto] rematch result: ${res} (health=${bot.health})`);
            if (res === 'hurt') { noteNoKill(h); res = 'done'; }
          } else res = 'done';
        }
        if (res === 'killed' || res === 'gone') fightBan.delete(h.id);
        else if (res === 'skip' || res === 'timeout') {
          // Unkillable or not worth it: strike it (escalating ban).
          const still = bot.entities[h.id];
          if (still && still.position && bot.entity.position.distanceTo(still.position) <= 14) noteNoKill(h);
          else fightBan.delete(h.id);
        }
        if (S.desiredState === 'busy') S.desiredState = 'idle';
        S.autoBusy = false; S.autoLabel = '';
        return;
      }
    }
    // Pick up dropped items lying around (idle only, within 24 blocks).
    if (settings.autoPickup && !ctx.anyMissionActive() && !S.nightMode) {
      const drops = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && e.name === 'item' && bot.entity.position.distanceTo(e.position) <= 24 && !(pickupBan.get(e.id) > Date.now()));
      if (drops.length) {
        drops.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
        const d = drops[0];
        S.autoBusy = true; S.autoLabel = 'ドロップ回収中'; S.desiredState = 'busy';
        console.log(`[auto] picking up drop at ${d.position}`);
        try { await ctx.gotoWatched(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 1), 20000, 'autoPickup'); await new Promise(r => setTimeout(r, 1200)); } catch (e) { console.log('[auto] pickup failed:', e.message); }
        const still = bot.entities[d.id];
        if (still && still.position && bot.entity.position.distanceTo(still.position) < 3) { pickupBan.set(d.id, Date.now() + 5 * 60 * 1000); console.log('[auto] that drop seems unreachable — skipping it for a while'); }
        if (S.desiredState === 'busy') S.desiredState = 'idle';
        S.autoBusy = false; S.autoLabel = '';
        return;
      }
    }
    // Daytime fishing: when nothing else needs doing, gather/craft a
    // rod if needed and fish until dusk (user request 2026-11-23).
    // Launched without awaiting — the mission runs as its own loop and
    // this tick keeps watch for danger in the meantime.
    if (settings.autoFish && !ctx.anyMissionActive() && !S.nightMode && bot.time && bot.time.isDay && Date.now() - (S.lastFishAt || 0) > 10 * 60 * 1000) {
      console.log('[auto] starting daytime fishing');
      S.lastFishAt = Date.now();
      ctx.fishMission({ auto: true }).catch(e => console.log('[auto] fishing error:', e.message));
    }
  } catch (e) { console.log('[auto] tick error:', e.message); S.autoBusy = false; S.autoLabel = ''; }
}, 3000);

bot.on('death', () => { try { S.lastDeathByMob = !!ctx.nearestHostile(16); } catch { S.lastDeathByMob = false; } try { S.deathPos = bot.entity.position.clone(); console.log(`[death] at ${S.deathPos} (byMob=${S.lastDeathByMob})`); } catch {} try { if (S.deathPos) { memory.deaths.push({ x: Math.floor(S.deathPos.x), y: Math.floor(S.deathPos.y), z: Math.floor(S.deathPos.z), byMob: S.lastDeathByMob, at: Date.now() }); memory.deaths = memory.deaths.slice(-5); ctx.saveMemory(); } } catch {} S.soloAbort = true; S.fishingMode = false; S.guardMode = false; S.deathTimes.push(Date.now()); S.deathTimes = S.deathTimes.filter(t => Date.now() - t < 3 * 60 * 1000); if (S.deathTimes.length >= 3) console.log(`[death] loop detected: ${S.deathTimes.length} deaths in 3 min`); });
// ---- night survival + death-loop protection ----
// Incident 2026-11-23: after finishing a mission at dusk the bot idled in the
// open, got mobbed at world spawn, and died 5+ times in a row (respawn -> slain
// by shade-sheltering zombies). Standing still at night is what kills it, so
// at night an idle bot keeps moving (zombies cannot catch a walking bot) and
// fights back at point blank. A death-loop breaker forces this mode on.
ctx.anyMissionActive = function () { return S.soloMode || S.pickaxeMode || S.swordMode || S.armorMode || S.fishingMode || S.guardMode || S.baseMode || S.bedMode || S.furnishMode || S.pondMode || S.returningHome || S.assistMode || S.givingMode || S.fixtureMode || S.repairMode || S.cleanupMode; }
ctx.nightSurvival = async function () {
  if (S.nightMode) return;
  S.nightMode = true;
  // S.desiredState must be 'busy': at 'idle' the state machine makes
  // pathfinder.goto resolve instantly without moving (found live 2026-11-23
  // via wander logs: "arrived" in 0s, position unchanged). Every working
  // goto in this codebase (collectByNames, attackEntity, crafts) runs busy.
  S.desiredState = 'busy';
  console.log('[night] survival mode start');
  // With a registered base, going home beats wandering: sealed + lit inside.
  if (settings.home) {
    ctx.say('夜だから拠点に帰るね');
    // goHome can fake-succeed from the spawn hilltop (pathfinder pathology):
    // verify the bot actually IS home before trusting the wait loop to it.
    const nearHome = () => !!bot.entity && Math.hypot(bot.entity.position.x - settings.home.x, bot.entity.position.z - settings.home.z) <= 7;
    let ok = await ctx.goHome().catch(() => false);
    if (ok && !nearHome()) { console.log('[night] goHome claimed success but the bot is not home — retrying once'); ok = await ctx.goHome().catch(() => false); }
    ok = ok && nearHome();
    if (ok && S.nightMode) {
      S.homeWaitMode = true;
      // Home for the night: put surplus materials away in the chest.
      try { await ctx.depositToChest(); } catch (e) { console.log('[night] deposit failed:', e.message); }
      try {
        while (S.nightMode && bot.time && !bot.time.isDay) {
          // Leash: if anything dragged the bot away from the hut (a
          // kiting skeleton's pvp chase dragged it 30 blocks out and
          // nearly killed it, 2026-11-23), returning beats fighting.
          if (bot.entity && Math.hypot(bot.entity.position.x - settings.home.x, bot.entity.position.z - settings.home.z) > 5) {
            console.log('[night] dragged away from home — returning');
            try { await ctx.goHome(); } catch {}
          }
          const h = ctx.nearestHostile(3);
          if (h) {
            // Respect the same escalating ban as daytime fights (a
            // spider parked by the hut is not worth duelling all
            // night) — unless it actually hurts the bot, which clears
            // the ban on the spot. (Absolute health is the wrong test:
            // the bot often sits below full for unrelated reasons.)
            const rec = fightBan.get(h.id);
            const banned = rec && rec.until > Date.now() && bot.entity.position.distanceTo(h.position) >= 2;
            if (!banned) {
              const hpBefore = bot.health;
              try { await ctx.withTimeout(bot.pvp.attack(h), 6000, 'home defense'); } catch {}
              if (!bot.entities[h.id]) fightBan.delete(h.id);
              else if (bot.health < hpBefore) { const r = fightBan.get(h.id); if (r) { r.until = 0; fightBan.set(h.id, r); } console.log('[night] defense: it is hurting me — ignoring the ban'); }
              else noteNoKill(h);
            }
          }
          if (!bot.isSleeping) {
            // Sleep in the base bed to skip the night (prefer the
            // remembered bed; fall back to any bed nearby).
            let bb = null;
            if (memory.bed) { const { Vec3 } = require('vec3'); const b = bot.blockAt(new Vec3(memory.bed.x, memory.bed.y, memory.bed.z)); if (b && b.name.endsWith('_bed')) bb = b; }
            if (!bb) { const bedPos = ctx.findBlocks(['white_bed', 'red_bed', 'blue_bed', 'black_bed', 'brown_bed', 'cyan_bed', 'gray_bed', 'green_bed', 'light_blue_bed', 'light_gray_bed', 'lime_bed', 'magenta_bed', 'orange_bed', 'pink_bed', 'purple_bed', 'yellow_bed'], 8, 1)[0]; if (bedPos) { const b = bot.blockAt(bedPos); if (b) bb = b; } }
            if (bb) { try { await bot.sleep(bb); console.log('[night] sleeping in bed — night should skip'); } catch (e) { console.log('[night] sleep failed:', e.message); } }
          }
          await new Promise(r => setTimeout(r, 3000));
          if (!bot.entity) break;
        }
      } finally { S.homeWaitMode = false; }
      console.log('[night] home wait end');
      // The wander branch resets nightMode in its finally; this early
      // return must do it too — otherwise the flag sticks all day and the
      // watchdog never engages again the next night (found live 2026-11-23).
      S.nightMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle';
      console.log('[night] survival mode end');
      return;
    }
    if (!S.nightMode) return; // stopped while heading home
    console.log('[night] could not get home — falling back to wandering');
  }
  ctx.say('夜は危ないから動き回ってやり過ごすね');
  try {
    while (S.nightMode && bot.time && !bot.time.isDay) {
      const h = ctx.nearestHostile(4);
      if (h) {
        // Bound the fight: pvp.attack never resolves when the hostile is
        // unreachable (e.g. a zombie under the bot's hill/tree), and the first
        // live night run froze on exactly that — no movement, no logs.
        try { await ctx.withTimeout(bot.pvp.attack(h), 6000, 'night fight'); } catch (e) { console.log(`[night] fight gave up: ${e.message}`); }
        // Whether it died or not, move on: wandering away is the escape.
      }
      if (!bot.entity) break;
      const p = bot.entity.position.clone();
      const ang = Math.random() * Math.PI * 2;
      const dist = 14 + Math.random() * 10;
      const tx = p.x + Math.cos(ang) * dist, tz = p.z + Math.sin(ang) * dist;
      console.log(`[night] wander from (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) to (${tx.toFixed(1)}, ${tz.toFixed(1)})`);
      const wStart = Date.now();
      try { await ctx.withTimeout(bot.pathfinder.goto(new goals.GoalNear(tx, p.y, tz, 2)), 20000, 'night wander'); console.log(`[night] wander arrived at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`); } catch (e) { console.log(`[night] wander failed: ${e.message}`); }
      if (Date.now() - wStart < 1500 && bot.entity && bot.entity.position.distanceTo(p) < 1) {
        // In some spots the pathfinder instantly "arrives" without moving
        // (seen frozen at the old spawn hilltop): walk out with raw controls.
        console.log('[night] wander made no progress — manual walk escape');
        try {
          const { Vec3 } = require('vec3');
          await bot.lookAt(new Vec3(tx, bot.entity.position.y + 1.6, tz), true);
          bot.setControlState('forward', true); bot.setControlState('jump', true);
          await new Promise(r => setTimeout(r, 500));
          bot.setControlState('jump', false);
          await new Promise(r => setTimeout(r, 2000));
          bot.clearControlStates();
        } catch {}
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) { console.log('[night] survival error:', e.message); }
  finally { S.nightMode = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; console.log('[night] survival mode end'); }
}
// Respawn handling: first spawn is set up by the once('spawn') handler above.
bot.on('spawn', () => {
  if (!S.firstSpawnSeen) { S.firstSpawnSeen = true; return; }
  console.log('[spawn] respawned');
  setTimeout(async () => {
    try {
      if (!bot.entity || !bot.time) return;
      if (!bot.time.isDay) { if (settings.nightSurvival) ctx.nightSurvival(); return; }
      // If mobs camp the respawn point, sprint away before anything else —
      // the bot died 6 times in 3 minutes at a camped spawn (2026-11-23).
      const camper = ctx.nearestHostile(12);
      if (camper) {
        console.log(`[spawn] hostile near respawn (${camper.name}) — escaping first`);
        S.desiredState = 'busy';
        try {
          const { Vec3 } = require('vec3');
          const p = bot.entity.position;
          await bot.lookAt(new Vec3(p.x + (p.x - camper.position.x) * 3, p.y + 1.6, p.z + (p.z - camper.position.z) * 3), true);
          bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
          await new Promise(r => setTimeout(r, 600));
          bot.setControlState('jump', false);
          await new Promise(r => setTimeout(r, 2900));
          bot.clearControlStates();
        } catch {}
        if (S.desiredState === 'busy') S.desiredState = 'idle';
      }
      // Killed by a monster? Craft at least a wooden sword before going
      // back (user request 2026-11-23).
      if (S.lastDeathByMob && S.deathPos) { try { await ctx.ensureWoodenSword(); } catch (e) { console.log('[spawn] sword craft failed:', e.message); } }
      // Daytime: walk back to the death spot to recover dropped items (5 min
      // despawn) when nothing hostile is around. But after repeated deaths
      // the drops are not worth dying for again (the bot died twice more
      // walking back into a skeleton's range, 2026-11-23): skip recovery
      // once the death loop breaker is hot.
      if (settings.autoRecover && S.deathPos && !ctx.nearestHostile(12) && S.deathTimes.length < 2) {
        const dp = S.deathPos; S.deathPos = null;
        ctx.say('落としたものを回収しに行くね');
        S.autoBusy = true; // keep the auto tick out of the recovery's pathfinding
        S.desiredState = 'busy'; // goto only moves while busy (see nightSurvival note)
        try {
          await ctx.gotoWatched(new goals.GoalNear(dp.x, dp.y, dp.z, 1), 60000, 'recover drops');
          await new Promise(r => setTimeout(r, 3000));
          console.log('[spawn] drop recovery walk done');
          ctx.say('回収できたはず。今の持ち物を確認してね');
        } catch (e) { console.log('[spawn] drop recovery failed:', e.message); }
        finally { S.autoBusy = false; if (S.desiredState === 'busy') S.desiredState = 'idle'; }
      }
    } catch (e) { console.log('[spawn] respawn handler:', e.message); }
  }, 1500);
});
// Watchdog: an idle bot must never sit in the open at night, and repeated
// deaths force survival mode even mid-evening.
setInterval(() => {
  try {
    if (!bot.entity || !bot.time || S.nightMode) return;
    const looped = S.deathTimes.length >= 3;
    if (settings.nightSurvival && !bot.time.isDay && (looped || !ctx.anyMissionActive())) { console.log(`[night] watchdog engaging survival (looped=${looped})`); ctx.nightSurvival(); }
  } catch {}
}, 20000);
// Drowning guard (user improvement 2026-11-24): Muze drowned three
// times in the pond today because missions and death-recovery drove
// the body through deep water with nobody watching the air bar.
// A dedicated 1s tick: when oxygen runs low underwater, stop
// pathing and swim straight up until the air is back.
{
  let drownActive = false;
  setInterval(() => {
    try {
      if (!bot.entity || bot.oxygenLevel === undefined || bot.oxygenLevel === null) return;
      const o2 = bot.oxygenLevel;
      if (o2 <= 10 && bot.entity.isInWater) {
        if (!drownActive) { drownActive = true; console.log(`[drown] ${bot.username} oxygen ${o2} — surfacing`); try { bot.pathfinder.stop(); } catch {} }
        try { bot.setControlState('jump', true); bot.setControlState('forward', true); } catch {}
      } else if (drownActive && (o2 >= 18 || !bot.entity.isInWater)) {
        drownActive = false;
        try { bot.setControlState('jump', false); bot.setControlState('forward', false); } catch {}
        console.log(`[drown] ${bot.username} surfaced (oxygen ${o2})`);
      }
    } catch {}
  }, 1000);
}

// ---- watchers (user-requested improvements, 2026-11-24) ----
// A2 damage watch: diff the blueprint against the last snapshot and
// log what vanished plus which hostiles were nearby — the 2026-11-23
// wall holes were blamed on an enderman, but endermen cannot carry
// planks in vanilla, so collect evidence instead of guessing.
// A4 idle watch: a body left idle far from home (or stuck in a pit
// below home level, like Yume's hours in the crater) walks home.
// B6 scout duty: answer the partner's sheep-hunt request.
const shared = require('./shared');
S.watchState = { lastDamageScan: 0, idleSince: 0, lastScoutAt: 0 };
setInterval(async () => {
  try {
    if (!bot.entity || !bot.inventory) return;
    const now = Date.now();
    const W = S.watchState;
    // Stuck detection + help request (user request 2026-11-24):
    // a body that has not moved for 2 minutes while deep below
    // home level and far from home is stuck (Yume spent hours in
    // a 1-wide shaft like this). Publish a help request carrying
    // the position + reason so the partner can dig it out, and
    // say so in chat. The partner's watcher answers further down.
    try {
      const p = bot.entity.position;
      if (!W.stuckPos || W.stuckPos.distanceTo(p) > 1.5) { W.stuckPos = p.clone(); W.stuckSince = now; }
      const deep = settings.home && p.y < settings.home.y - 4;
      const far = settings.home && Math.hypot(p.x - settings.home.x, p.z - settings.home.z) > 16;
      const still = now - (W.stuckSince || now) > 120000;
      if (deep && far && still) {
        if (!shared.helpReq || shared.helpReq.by !== bot.username || now - shared.helpReq.at > 60000) {
          shared.helpReq = { by: bot.username, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: now, reason: 'stuck' };
          console.log(`[help] ${bot.username} is stuck at ${shared.helpReq.x}, ${shared.helpReq.y}, ${shared.helpReq.z} — requesting help`);
          ctx.say('詰まっちゃって動けない…助けて');
        }
      } else if (shared.helpReq && shared.helpReq.by === bot.username) {
        shared.helpReq = null;
        console.log(`[help] ${bot.username} is free again`);
      }
      // If the partner dug an exit for me, use it: retry going home.
      if (shared.helpReq && shared.helpReq.by === bot.username && shared.rescue && shared.rescue.for === bot.username && shared.rescue.phase === 'open' && bot.time && bot.time.isDay && now - (W.lastEscapeTry || 0) > 30000) {
        W.lastEscapeTry = now;
        console.log('[help] exit is open — trying to go home');
        try { await ctx.goHome(); } catch (e) { console.log('[help] escape try:', e.message); }
      }
    } catch (e) { console.log('[help] detector:', e.message); }
    // Health alert + medic request (user improvement 2026-11-24):
    // Yume sat at hp 1 today with nobody noticing. A big sudden
    // drop is logged; at hp <= 5 with no food in hand, publish
    // shared.medicReq so the partner brings food (coop.medicRun).
    try {
      const hp = bot.health;
      if (W.lastHp !== undefined && W.lastHp - hp >= 5) console.log(`[medic] ${bot.username} took a big hit: ${W.lastHp} -> ${hp}`);
      W.lastHp = hp;
      const hasFood = bot.inventory.items().some(i => ctx.C.FOOD_ORDER.includes(i.name));
      if (hp <= 5 && !hasFood && (!shared.medicReq || shared.medicReq.by !== bot.username) && now - (W.lastMedicReq || 0) > 180000) {
        W.lastMedicReq = now;
        const p = bot.entity.position;
        shared.medicReq = { by: bot.username, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), hp, at: now };
        console.log(`[medic] ${bot.username} is at hp ${hp} with no food — asking the partner to bring food`);
        ctx.say('体力がピンチ…食料を持ってきて');
      }
      if (shared.medicReq && shared.medicReq.by === bot.username && (hp > 8 || hasFood)) { shared.medicReq = null; console.log(`[medic] ${bot.username} recovered — request cleared`); }
    } catch (e) { console.log('[medic] watch:', e.message); }
    // Fall recorder (night-safety improvement 2026-11-24): a sudden
    // drop of 4+ blocks while walking (not digging) marks the
    // column as a hazard in memory; the idle watcher caps
    // remembered hazards with dirt in daytime. Yume's open shaft
    // is the case this exists for.
    try {
      const py = bot.entity.position.y;
      if (W.lastPosY !== undefined && W.lastPosY - py >= 4 && !S.pondMode && !S.cleanupMode && !S.nightMode) {
        memory.hazards = memory.hazards || [];
        const hx = Math.floor(bot.entity.position.x), hz = Math.floor(bot.entity.position.z);
        if (!memory.hazards.some(h => h.x === hx && h.z === hz)) {
          memory.hazards.push({ x: hx, z: hz, capY: Math.floor(W.lastPosY) - 1, at: now, tries: 0 });
          if (memory.hazards.length > 20) memory.hazards.shift();
          ctx.saveMemory();
          console.log(`[fall] ${bot.username} dropped from y${Math.floor(W.lastPosY)} at ${hx}, ${hz} — hazard recorded`);
        }
      }
      W.lastPosY = py;
    } catch (e) { console.log('[fall] watch:', e.message); }
    // A2: only near home (chunks loaded, blockAt truthful there).
    if (settings.home && ctx.blueprintCells && now - W.lastDamageScan > 45000) {
      W.lastDamageScan = now;
      const p0 = bot.entity.position;
      if (Math.hypot(p0.x - settings.home.x, p0.z - settings.home.z) < 48) {
        const { Vec3 } = require('vec3');
        const snap = {};
        for (const c of ctx.blueprintCells()) { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); snap[`${c.x},${c.y},${c.z}`] = b ? b.name : null; }
        if (S.blueprintSnap && !S.repairMode) {
          for (const k of Object.keys(snap)) {
            const was = S.blueprintSnap[k], is = snap[k];
            if (was && was !== 'air' && (is === 'air' || is === null)) {
              const [x, y, z] = k.split(',').map(Number);
              // Only hostiles within 24m can plausibly be involved
              // (the first live log listed every hostile in the loaded
              // chunks out to 140m — noise, not evidence). Both bodies
              // watch, so dedupe against the shared log.
              memory.damageLog = memory.damageLog || [];
              if (memory.damageLog.some(d => d.x === x && d.y === y && d.z === z && now - d.at < 120000)) continue;
              // Distance is measured from the DAMAGED CELL, not from
              // the watching bot (a watcher 35m away filtered out the
              // very mob standing at the wall, 2026-11-24).
              const { Vec3: V3 } = require('vec3');
              const cellPos = new V3(x + 0.5, y + 0.5, z + 0.5);
              const foes = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && HOSTILES.has(e.name))
                .map(e => ({ n: e.name, d: cellPos.distanceTo(e.position) })).filter(f => f.d <= 24).sort((a, b) => a.d - b.d).slice(0, 8)
                .map(f => `${f.n}@${f.d.toFixed(0)}m`);
              console.log(`[damage] ${k} was ${was}, now ${is}; hostiles near: ${foes.join(' ') || 'none'}`);
              memory.damageLog.push({ x, y, z, was, at: now, foes });
              memory.damageLog = memory.damageLog.slice(-10);
              ctx.saveMemory();
            }
          }
        }
        S.blueprintSnap = snap;
      }
    }
    if (S.autoBusy || ctx.anyMissionActive() || S.nightMode || S.homeWaitMode) { W.idleSince = 0; return; }
    // Rescue duty (user request 2026-11-24): the partner published
    // a help request — go dig her out. Shared information:
    // shared.helpReq carries her position + reason, shared.rescue
    // carries the phase (going / digging / open / done).
    const hr = shared.helpReq;
    if (hr && hr.by !== bot.username && now - hr.at < 180000 && now - (W.lastRescueTry || 0) > 60000) {
      const pw = ctx.partnerCtx();
      const pHp = pw && pw.ctx && pw.ctx.bot && pw.ctx.bot.entity ? pw.ctx.bot.health : 20;
      if (bot.time && (bot.time.isDay || pHp < 10)) {
        W.lastRescueTry = now;
        console.log(`[rescue] ${hr.by} needs help at ${hr.x}, ${hr.y}, ${hr.z} — going`);
        S.autoBusy = true; S.autoLabel = '相方を救助中'; S.desiredState = 'busy';
        try { await ctx.rescuePartner(hr); } catch (e) { console.log('[rescue] failed:', e.message); }
        if (S.desiredState === 'busy') S.desiredState = 'idle';
        S.autoBusy = false; S.autoLabel = '';
        try { await ctx.goHome(); } catch {}
        W.idleSince = 0;
        return;
      }
    }
    // Dusk return (night-safety improvement 2026-11-24): twice
    // today a body was caught far from home at nightfall, failed
    // the long goHome and wandered among hostiles (one died).
    // Start the trip home while there is still light instead.
    if (settings.home && bot.time && bot.time.timeOfDay > 10000 && bot.time.timeOfDay < 12500) {
      const p = bot.entity.position;
      if (Math.hypot(p.x - settings.home.x, p.z - settings.home.z) > 24) {
        console.log('[night] dusk is coming and I am far from home — heading back early');
        S.autoBusy = true; S.autoLabel = '夕方の帰宅中'; S.desiredState = 'busy';
        try { await ctx.goHome(); } catch (e) { console.log('[night] dusk return:', e.message); }
        if (S.desiredState === 'busy') S.desiredState = 'idle';
        S.autoBusy = false; S.autoLabel = '';
        W.idleSince = 0;
        return;
      }
    }
    // Medic duty: the partner is at hp <= 5 with no food — bring
    // her some (user improvement 2026-11-24; coop.medicRun).
    const mr = shared.medicReq;
    if (mr && mr.by !== bot.username && now - mr.at < 180000 && now - (W.lastMedicRun || 0) > 60000) {
      W.lastMedicRun = now;
      console.log(`[medic] ${mr.by} needs food (hp ${mr.hp}) — bringing some`);
      S.autoBusy = true; S.autoLabel = '食料を届け中'; S.desiredState = 'busy';
      try { await ctx.medicRun(mr); } catch (e) { console.log('[medic] run failed:', e.message); }
      if (S.desiredState === 'busy') S.desiredState = 'idle';
      S.autoBusy = false; S.autoLabel = '';
      W.idleSince = 0;
      return;
    }
    // B6: scout for sheep when the partner's bed hunt asks for help.
    const req = shared.sheepReq;
    if (req && req.by !== bot.username && now - req.at < 120000 && now - W.lastScoutAt > 120000 && bot.time && bot.time.isDay && settings.home) {
      W.lastScoutAt = now;
      shared.sheepReq = null;
      console.log('[scout] partner is hunting sheep — scouting');
      S.autoBusy = true; S.autoLabel = '羊を探し中'; S.desiredState = 'busy';
      try {
        const home = settings.home; const ang = Math.random() * Math.PI * 2;
        try { await ctx.gotoWatched(new goals.GoalNear(home.x + Math.cos(ang) * 56, bot.entity.position.y, home.z + Math.sin(ang) * 56, 4), 60000, 'sheep scout'); } catch {}
        await new Promise(r => setTimeout(r, 3000));
        const sheep = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && e.name === 'sheep').sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
        if (sheep && bot.entity.position.distanceTo(sheep.position) <= 64) {
          shared.sheepSpot = { x: Math.floor(sheep.position.x), y: Math.floor(sheep.position.y), z: Math.floor(sheep.position.z), at: Date.now(), by: bot.username };
          console.log(`[scout] sheep found at ${shared.sheepSpot.x}, ${shared.sheepSpot.z} — reporting`);
          ctx.say(`羊なら ${shared.sheepSpot.x}, ${shared.sheepSpot.z} の方にいたよ`);
        } else console.log('[scout] no sheep on this scout');
      } catch (e) { console.log('[scout] failed:', e.message); }
      if (S.desiredState === 'busy') S.desiredState = 'idle';
      S.autoBusy = false; S.autoLabel = '';
      try { await ctx.goHome(); } catch {}
      W.idleSince = 0;
      return;
    }
    // Pond pair work: the lead published a shared fill job — haul
    // water from the well too instead of idling (user request
    // 2026-11-24: Yume waits around too much during pair tasks).
    const pj = shared.pondJob;
    if (pj && pj.by !== bot.username && now - pj.at < 8 * 60000 && bot.time && bot.time.isDay) {
      console.log('[pond] partner fill job — joining the water haul');
      S.autoBusy = true; S.autoLabel = '池の水運び手伝い'; S.desiredState = 'busy';
      try {
        if (ctx.countItem('bucket') + ctx.countItem('water_bucket') === 0) { try { await ctx.resyncViaChest(); } catch {} }
        if (ctx.countItem('bucket') + ctx.countItem('water_bucket') === 0) { try { await ctx.withdrawFromChest('bucket', 1); } catch {} }
        if (ctx.countItem('bucket') + ctx.countItem('water_bucket') > 0) await ctx.fillPondCells(pj);
        else console.log('[pond] assist: no bucket even after a resync — sitting this one out');
      } catch (e) { console.log('[pond] assist failed:', e.message); }
      if (S.desiredState === 'busy') S.desiredState = 'idle';
      S.autoBusy = false; S.autoLabel = '';
      W.idleSince = 0;
      return;
    }
    // Hazard cap: a fall was recorded somewhere (fall recorder
    // above) — go plug the top of the hole with dirt so nobody
    // falls in again (user improvement 2026-11-24).
    const hz = (memory.hazards || [])[0];
    if (hz && bot.time && bot.time.isDay && now - (W.lastCapTry || 0) > 60000) {
      W.lastCapTry = now;
      console.log(`[fall] capping hazard at ${hz.x}, ${hz.z} (capY ${hz.capY})`);
      S.autoBusy = true; S.autoLabel = '穴を塞ぎ中'; S.desiredState = 'busy';
      try {
        if (ctx.countItem('dirt') === 0) { try { await ctx.withdrawFromChest('dirt', 1); } catch {} }
        if (ctx.countItem('dirt') > 0) {
          try { await ctx.gotoWatched(new goals.GoalNear(hz.x, hz.capY, hz.z, 2), 30000, 'hazard cap'); } catch {}
          const ok = await ctx.placeBlockAt(hz.x, hz.capY, hz.z, 'dirt').catch(() => false);
          if (ok) { memory.hazards.shift(); ctx.saveMemory(); console.log('[fall] hazard capped'); }
          else { hz.tries = (hz.tries || 0) + 1; if (hz.tries >= 2) { memory.hazards.shift(); ctx.saveMemory(); console.log('[fall] hazard cap gave up after 2 tries'); } }
        } else console.log('[fall] no dirt to cap with — will retry later');
      } catch (e) { console.log('[fall] cap failed:', e.message); }
      if (S.desiredState === 'busy') S.desiredState = 'idle';
      S.autoBusy = false; S.autoLabel = '';
      try { await ctx.goHome(); } catch {}
      W.idleSince = 0;
      return;
    }
    // Phantom-inventory guard (user improvement 2026-11-24): the
    // client inventory view can lie for minutes under lag (it hid
    // a total inventory loss today). Every ~10 minutes while idle
    // near home, force a chest open/close resync and log any
    // difference between what the view said and what is real.
    if (settings.home && now - (W.lastResyncAt || 0) > 600000 && Math.hypot(bot.entity.position.x - settings.home.x, bot.entity.position.z - settings.home.z) < 24) {
      W.lastResyncAt = now;
      const snapInv = () => { const m = {}; for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count; return m; };
      const beforeInv = snapInv();
      try { await ctx.resyncViaChest(); } catch (e) { console.log('[desync] resync failed:', e.message); }
      const afterInv = snapInv();
      let diffs = 0;
      for (const k of new Set([...Object.keys(beforeInv), ...Object.keys(afterInv)])) {
        if ((beforeInv[k] || 0) !== (afterInv[k] || 0)) { console.log(`[desync] ${bot.username} ${k}: view said ${beforeInv[k] || 0}, real ${afterInv[k] || 0}`); diffs++; }
      }
      if (!diffs) console.log(`[desync] ${bot.username} periodic resync: no phantom differences`);
    }
    // A4: idle too long while far from home or stuck below it — go home.
    if (!W.idleSince) W.idleSince = now;
    if (settings.home && now - W.idleSince > 180000) {
      const p = bot.entity.position;
      const dHome = Math.hypot(p.x - settings.home.x, p.z - settings.home.z);
      W.idleSince = now; // retest in 3 minutes either way
      if (dHome > 24 || p.y < settings.home.y - 3) {
        console.log(`[watch] idle far from home (${dHome.toFixed(0)}m, y=${Math.floor(p.y)}) — heading home`);
        S.returningHome = true;
        try { await ctx.goHome(); } catch (e) { console.log('[watch] goHome:', e.message); }
        S.returningHome = false;
      }
    }
  } catch (e) { console.log('[watch] error:', e.message); }
}, 15000);
};
