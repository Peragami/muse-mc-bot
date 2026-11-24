// Muze + Yume — Minecraft bot pair (entry point).
// One process, two bodies, one shared brain: lib/context.js is a
// factory that builds a per-body ctx (own bot, own state S, own
// dashboard ports) around shared settings/memory singletons. Each
// feature module attaches its functions to a body's ctx, so the same
// code drives both bodies; a body runs one mission at a time while
// the other body can work in parallel (pair setup, 2026-11-23).
//   lib/consts.js    constants + env config
//   lib/context.js   body factory: bot creation, plugins, state, persistence
//   lib/world.js     movement, gathering, mining, block placement
//   lib/craft.js     crafting, charcoal smelting, wooden sword
//   lib/home.js      base building, go-home, chest storage, memory talk
//   lib/missions.js  guard, fishing, pond building, sleep, solo missions
//   lib/life.js      auto behaviors, night survival, death/respawn handling
//   lib/dashboard.js viewer + state API/dashboard server (per body)
//   lib/chat.js      chat command router (name-addressed in game chat)
const createCtx = require('./lib/context');

const BODIES = [
  { username: 'Nemu', viewerPort: 3007, statePort: 3008, callName: 'ねむ', primary: true },
  { username: 'Yume', viewerPort: 3017, statePort: 3018, callName: 'ゆめ', primary: false },
];
const MODULES = ['./lib/world', './lib/coop', './lib/craft', './lib/home', './lib/missions', './lib/life', './lib/dashboard', './lib/chat'];

for (const cfg of BODIES) {
  const ctx = createCtx(cfg);
  for (const m of MODULES) require(m)(ctx);
  wireLifecycle(ctx, cfg);
}

function wireLifecycle(ctx, cfg) {
  const { bot, S, Movements } = ctx;
  bot.once('spawn', () => {
    // canDig MUST stay false: with the default (true) the pathfinder
    // breaks blocks to shorten its path — it was digging bot-sized
    // holes through the hut walls instead of using the door, which
    // the damage watcher kept recording as mystery destruction
    // (evidence 2026-11-24). All real digging is explicit bot.dig.
    try { const mv = new Movements(bot); mv.canDig = false; bot.pathfinder.setMovements(mv); } catch {}
    ctx.setupStateMachine(); ctx.startViewer(); ctx.startStateServer();
    ctx.say(cfg.primary ? 'むぜ、来たよ' : 'ゆめ、来たよ');
    console.log(`spawned as ${cfg.username} at ${bot.entity.position}`);
    // auto-totem: try plugin, fall back to manual off-hand equip
    const totemTick = async () => { try { if (S.autototemOk && bot.autototem?.equip) bot.autototem.equip(); else { const off = bot.inventory.slots[45]; if (!off && bot.health <= 10) { const t = bot.inventory.items().find(i => i.name === 'totem_of_undying'); if (t) await bot.equip(t, 'off-hand'); } } } catch {} };
    bot.on('physicsTick', totemTick);
    setTimeout(() => { try { bot.armorManager?.equipAll(); } catch {} }, 2000);
    if (S.deathPos) ctx.say(`前に死んだ場所は ${Math.floor(S.deathPos.x)}, ${Math.floor(S.deathPos.y)}, ${Math.floor(S.deathPos.z)}。「もどって」で戻るよ`);
    // Env-driven solo demos only ever run on the primary body.
    if (cfg.primary) {
      if (ctx.C.AUTOSOLO) setTimeout(() => ctx.soloSurvival(), 3000);
      if (process.env.AUTO_SWORD === '1') setTimeout(() => ctx.swordMission(), 4000);
      if (process.env.AUTO_ARMOR === '1') setTimeout(() => ctx.armorMission(), 4000);
    }
  });
  bot.on('kicked', (r) => console.log(`kicked (${cfg.username}):`, r));
  bot.on('error', (e) => console.log(`error (${cfg.username}):`, e.message));
  bot.on('end', (r) => console.log(`disconnected (${cfg.username}):`, r));
}
