// Cooperation between the two bodies (user request 2026-11-23: fight
// together, and share items when a task needs them — e.g. hand over
// string when the partner is short while preparing a fishing rod).
// Coordination goes through lib/shared.js: a combat alert (who is
// fighting what, where) and a single pending item transfer. Each body
// polls these from its life tick; a body only helps while it is not
// busy with a mission of its own.
const shared = require('./shared');
module.exports = (ctx) => {
  const { bot, goals, S } = ctx;
  const ME = ctx.C.USERNAME;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  ctx.partnerCtx = function () {
    const names = Object.keys(shared.bodies).filter(n => n !== ME);
    if (!names.length) return null;
    const e = shared.bodies[names[0]];
    return { name: names[0], ctx: e.ctx, cfg: e.cfg };
  };

  // ---- combat alerts ----
  ctx.publishCombat = function (target) {
    if (!target || !target.position) return;
    // A fresh alert from the partner stands — do not overwrite it.
    if (shared.combat && shared.combat.by !== ME && Date.now() - shared.combat.at < 12000) return;
    shared.combat = { by: ME, targetId: target.id, name: target.name, x: target.position.x, y: target.position.y, z: target.position.z, at: Date.now() };
  };
  ctx.refreshCombat = function (target) {
    if (shared.combat && shared.combat.targetId === target.id) {
      shared.combat.at = Date.now();
      if (target.position) { shared.combat.x = target.position.x; shared.combat.y = target.position.y; shared.combat.z = target.position.z; }
    }
  };
  ctx.clearCombat = function (target) {
    if (shared.combat && shared.combat.by === ME && (!target || shared.combat.targetId === target.id)) shared.combat = null;
  };

  // Rush to a fighting partner and join the same fight. Called from the
  // life tick; returns true when an assist was launched.
  ctx.tryAssist = function () {
    const c = shared.combat;
    if (!c || c.by === ME || Date.now() - c.at > 12000) return false;
    if (S.assistMode || S.nightMode || ctx.anyMissionActive()) return false;
    if (!bot.entity) return false;
    const { Vec3 } = require('vec3');
    const spot = new Vec3(c.x, c.y, c.z);
    if (bot.entity.position.distanceTo(spot) > 72) return false;
    S.assistMode = true; S.desiredState = 'busy'; S.autoBusy = true; S.autoLabel = '助太刀中';
    (async () => {
      try {
        console.log(`[coop] assisting ${c.by} against ${c.name}`);
        ctx.say('助太刀に行く！');
        await ctx.gotoWatched(new goals.GoalNear(c.x, c.y, c.z, 3), 45000, 'assist-approach');
        let e = bot.entities[c.targetId];
        if (!e || !e.position) {
          // Alert target already gone or not loaded here — hit the
          // nearest hostile around the fight spot instead.
          e = Object.values(bot.entities).filter(x => x && x.position && ctx.C.HOSTILES.has(x.name) && x.position.distanceTo(spot) <= 10)
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
        }
        if (e) {
          const r = await ctx.safeFight(e);
          console.log(`[coop] assist fight vs ${e.name}: ${r}`);
          if (r === 'hurt') { const food = ctx.bestFoodItem(); if (food) { try { await bot.equip(food, 'hand'); await bot.consume(); } catch {} } }
        } else console.log('[coop] assist: nothing left to fight');
      } catch (err) { console.log('[coop] assist failed:', err.message); }
      finally {
        // In a finally (and the say moved inside the try): if
        // anything before the IIFE threw, assistMode used to stay
        // set forever and the body silently stopped all auto
        // behavior (audit 2026-11-25).
        S.assistMode = false; S.autoBusy = false; S.autoLabel = '';
        if (S.desiredState === 'busy') S.desiredState = 'idle';
      }
    })();
    return true;
  };

  // ---- item transfer ----
  // Ask the partner for an item. The partner's tick picks the request
  // up (tryDeliver), walks over and tosses it; resolve true once our
  // count of the item grows. Falls back to false on timeout / partner
  // busy / partner short, so callers can gather it themselves.
  ctx.askPartnerFor = async function (name, count) {
    const p = ctx.partnerCtx(); if (!p) return false;
    if (ctx.countItem(name) >= count) return true;
    if (shared.transfer) return false;
    const have = p.ctx.countItem(name);
    // Pockets short is no longer a refusal: the giver checks the
    // home chest before tossing (tryDeliver). Refusing here made
    // "wood please" fail while 14 logs sat in the chest, because
    // the partner's pockets happened to be empty (live, 2026-11-24).
    if (have < count) console.log(`[coop] partner ${p.name} has ${name} x${have} (need ${count}) — asking anyway, she can fetch from the chest`);
    if (p.ctx.anyMissionActive()) { console.log(`[coop] partner ${p.name} is busy — not asking for ${name}`); return false; }
    if (!bot.entity) return false;
    const pos = bot.entity.position;
    shared.transfer = { from: p.name, to: ME, name, count, x: pos.x, y: pos.y, z: pos.z, at: Date.now() };
    console.log(`[coop] asked ${p.name} for ${name} x${count}`);
    ctx.say(`${p.cfg.callName}、${name}を${count}個ちょうだい`);
    const before = ctx.countItem(name);
    const deadline = Date.now() + 120000;
    let clearedAt = 0;
    let metGiver = false;
    while (Date.now() < deadline) {
      await wait(2500);
      if (ctx.countItem(name) > before) { console.log(`[coop] received ${name} from ${p.name}`); ctx.say('ありがとう！'); return true; }
      // Meet the giver: the toss lands at HER feet, and standing
      // still waiting left the drop sitting a block away forever
      // (three verified giver retries, zero pickups, live
      // 2026-11-24). Once she has tossed (request cleared), walk
      // to where she stands and sweep up the drop myself.
      if (!shared.transfer && !metGiver) {
        metGiver = true;
        const pp = (p.ctx.bot && p.ctx.bot.entity) ? p.ctx.bot.entity.position : null;
        if (pp) { try { await ctx.gotoWatched(new goals.GoalNear(Math.floor(pp.x), Math.floor(pp.y), Math.floor(pp.z), 1), 15000, 'meet giver'); } catch {} }
      }
      if (shared.transfer && bot.entity) { shared.transfer.x = bot.entity.position.x; shared.transfer.y = bot.entity.position.y; shared.transfer.z = bot.entity.position.z; }
      // The giver clears the request the moment it tosses; the pickup
      // and the inventory sync can lag seconds behind on this server,
      // so keep watching for a grace period before giving up.
      if (!shared.transfer) { if (!clearedAt) clearedAt = Date.now(); if (Date.now() - clearedAt > 12000) break; }
    }
    if (shared.transfer && shared.transfer.to === ME) shared.transfer = null;
    if (ctx.countItem(name) > before) { console.log(`[coop] received ${name} from ${p.name} (late sync)`); return true; }
    console.log(`[coop] transfer of ${name} timed out`);
    return false;
  };

  // Deliver a pending transfer addressed to us as the giver. Called
  // from the life tick; returns true when a delivery was launched.
  ctx.tryDeliver = function () {
    const t = shared.transfer;
    if (!t || t.from !== ME) return false;
    if (Date.now() - t.at > 180000) { shared.transfer = null; return false; }
    if (S.givingMode || S.nightMode || ctx.anyMissionActive()) return false;
    if (!bot.entity) return false;
    S.givingMode = true; S.desiredState = 'busy'; S.autoBusy = true; S.autoLabel = '届け中';
    (async () => {
      try {
        console.log(`[coop] delivering ${t.name} x${t.count} to ${t.to}`);
        ctx.say(`${t.name}を持っていくね`);
        // Chest fallback: if my pockets are short, fetch the
        // shortfall from the home chest before heading over.
        if (ctx.countItem(t.name) < t.count) { try { await ctx.withdrawFromChest(t.name, t.count - ctx.countItem(t.name)); } catch {} }
        // Toss, then VERIFY the receiver actually picked it up —
        // and retry at her live position if she didn't. The old
        // fire-and-forget toss kept failing live (2026-11-24, twice
        // in a row): the item landed a block or two away, the
        // receiver stood still waiting, nobody walked over it, and
        // the ask timed out with the item on the ground.
        let left = t.count;
        // The requested count is a DEFICIT (askPartnerFor is
        // called with need - held), so "receiver total >= count"
        // confirms nothing: with 1 held and 1 requested it was
        // already true before any toss, and the giver stopped
        // retrying with the item on the ground (audit
        // 2026-11-25). Confirm on an INCREASE over what the
        // receiver held when this delivery started — the same
        // test askPartnerFor uses on its side.
        const pw0 = ctx.partnerCtx();
        const beforeGot = (pw0 && pw0.ctx) ? pw0.ctx.countItem(t.name) : 0;
        for (let attempt = 1; attempt <= 3 && left > 0; attempt++) {
          const recv = (bot.players[t.to] && bot.players[t.to].entity) ? bot.players[t.to].entity.position : null;
          const tp = recv || { x: t.x, y: t.y, z: t.z };
          try { await ctx.gotoWatched(new goals.GoalNear(Math.floor(tp.x), Math.floor(tp.y), Math.floor(tp.z), 1), 30000, 'deliver-approach'); } catch (e) { console.log('[coop] approach:', e.message); }
          if (recv) { try { await bot.lookAt(recv.offset(0, 1.2, 0), true); } catch {} }
          let tossed = 0;
          while (tossed < left) {
            const item = bot.inventory.items().find(i => i.name === t.name);
            if (!item) break;
            const n = Math.min(left - tossed, item.count);
            await bot.toss(item.type, item.metadata, n);
            tossed += n;
            await wait(400);
          }
          console.log(`[coop] tossed ${t.name} x${tossed} for ${t.to} (try ${attempt})`);
          if (!tossed) break;
          await wait(3000);
          const pw = ctx.partnerCtx();
          const got = (pw && pw.ctx) ? pw.ctx.countItem(t.name) : 0;
          if (got > beforeGot) { left = 0; console.log(`[coop] ${t.to} confirmed holding ${t.name} x${got} (was ${beforeGot})`); break; }
          // Not picked up: walk onto her spot to reclaim the drop
          // (it lands at her feet), then loop and toss again.
          console.log(`[coop] ${t.to} has not picked it up — reclaiming and retrying`);
          try { await ctx.gotoWatched(new goals.GoalNear(Math.floor(tp.x), Math.floor(tp.y), Math.floor(tp.z), 1), 20000, 'deliver-reclaim'); } catch {}
          await wait(2000);
        }
        if (left > 0) console.log(`[coop] delivery of ${t.name} unverified after retries`);
      } catch (err) { console.log('[coop] deliver failed:', err.message); }
      finally {
        if (shared.transfer === t) shared.transfer = null;
        S.givingMode = false; S.autoBusy = false; S.autoLabel = '';
        if (S.desiredState === 'busy') S.desiredState = 'idle';
      }
    })();
    return true;
  };

  // Medic run (user improvement 2026-11-24): the partner is at
  // hp <= 5 with no food (shared.medicReq, published by her life
  // watcher). Bring up to 4 food — from my own inventory first,
  // else the home chest — walk to her live position and toss it.
  ctx.medicRun = async function (req) {
    let food = bot.inventory.items().filter(i => ctx.C.FOOD_ORDER.includes(i.name)).sort((a, b) => b.count - a.count)[0];
    if (!food) {
      for (const name of ['cooked_porkchop', 'cooked_beef', 'bread', 'cooked_chicken', 'baked_potato', 'apple', 'carrot']) {
        try { await ctx.withdrawFromChest(name, 4); } catch {}
        food = bot.inventory.items().find(i => i.name === name);
        if (food) break;
      }
    }
    if (!food) { console.log('[medic] no food available to bring'); ctx.say('食料が見つからない…'); return false; }
    const pw = ctx.partnerCtx();
    const pp = (pw && pw.ctx && pw.ctx.bot && pw.ctx.bot.entity) ? pw.ctx.bot.entity.position : req;
    try { await ctx.gotoWatched(new goals.GoalNear(Math.floor(pp.x), Math.floor(pp.y), Math.floor(pp.z), 2), 60000, 'medic approach'); } catch (e) { console.log('[medic] approach:', e.message); }
    const patientFood = () => { const w = ctx.partnerCtx(); return (w && w.ctx && w.ctx.bot && w.ctx.bot.inventory) ? w.ctx.bot.inventory.items().filter(i => ctx.C.FOOD_ORDER.includes(i.name)).reduce((a, i) => a + i.count, 0) : 0; };
    const foodBefore = patientFood();
    let left = Math.min(4, food.count);
    while (left > 0) {
      const item = bot.inventory.items().find(i => i.name === food.name);
      if (!item) break;
      const n = Math.min(left, item.count);
      await bot.toss(item.type, item.metadata, n);
      left -= n;
      await wait(400);
    }
    // Verify the patient actually gained food before clearing
    // the request: a stomped approach used to toss the food
    // wherever the medic stood, log "delivered" and clear the
    // request — and the publisher's 180s re-ask throttle then
    // silenced the still-starving patient for minutes (audit
    // 2026-11-25).
    await wait(2500);
    const gained = patientFood() > foodBefore;
    const pw2 = ctx.partnerCtx();
    const healed = !!(pw2 && pw2.ctx && pw2.ctx.bot && pw2.ctx.bot.health > 8);
    if (gained || healed) {
      console.log(`[medic] delivered food to ${req.by} (verified: food ${foodBefore} -> ${patientFood()})`);
      ctx.say(`${req.by}、食料持ってきたよ。食べて`);
      if (shared.medicReq && shared.medicReq.by === req.by) shared.medicReq = null;
      return true;
    }
    console.log(`[medic] delivery to ${req.by} UNVERIFIED (food ${foodBefore} -> ${patientFood()}) — leaving the request open for a retry`);
    return false;
  };
};
