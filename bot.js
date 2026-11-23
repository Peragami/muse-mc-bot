// Muze — Minecraft bot (entry point).
// Everything lives in lib/: context.js builds the bot + shared state (ctx),
// and each feature module attaches its functions to that ctx.
//   lib/consts.js    constants + env config
//   lib/context.js   bot creation, plugins, shared state, settings/memory
//   lib/world.js     movement, gathering, mining, block placement
//   lib/craft.js     crafting, charcoal smelting, wooden sword
//   lib/home.js      base building, go-home, chest storage, memory talk
//   lib/missions.js  guard, fishing, sleep, solo/pickaxe/sword/armor missions
//   lib/life.js      auto behaviors, night survival, death/respawn handling
//   lib/dashboard.js viewer + state API/dashboard server
//   lib/chat.js      chat command router
const ctx = require('./lib/context');
const { bot, S, Movements } = ctx;

require('./lib/world')(ctx);
require('./lib/craft')(ctx);
require('./lib/home')(ctx);
require('./lib/missions')(ctx);
require('./lib/life')(ctx);
require('./lib/dashboard')(ctx);
require('./lib/chat')(ctx);

// ---- lifecycle ----
bot.once('spawn', () => {
  try { bot.pathfinder.setMovements(new Movements(bot)); } catch {}
  ctx.setupStateMachine(); ctx.startViewer(); ctx.startStateServer();
  ctx.say('むぜ、来たよ');
  console.log(`spawned as ${ctx.C.USERNAME} at ${bot.entity.position}`);
  // auto-totem: try plugin, fall back to manual off-hand equip
  const totemTick = async () => { try { if (S.autototemOk && bot.autototem?.equip) bot.autototem.equip(); else { const off = bot.inventory.slots[45]; if (!off && bot.health <= 10) { const t = bot.inventory.items().find(i => i.name === 'totem_of_undying'); if (t) await bot.equip(t, 'off-hand'); } } } catch {} };
  bot.on('physicsTick', totemTick);
  setTimeout(() => { try { bot.armorManager?.equipAll(); } catch {} }, 2000);
  if (S.deathPos) ctx.say(`前に死んだ場所は ${Math.floor(S.deathPos.x)}, ${Math.floor(S.deathPos.y)}, ${Math.floor(S.deathPos.z)}。「もどって」で戻るよ`);
  if (ctx.C.AUTOSOLO) setTimeout(() => ctx.soloSurvival(), 3000);
  if (process.env.AUTO_SWORD === '1') setTimeout(() => ctx.swordMission(), 4000);
  if (process.env.AUTO_ARMOR === '1') setTimeout(() => ctx.armorMission(), 4000);
});
bot.on('kicked', (r) => console.log('kicked:', r));
bot.on('error', (e) => console.log('error:', e.message));
bot.on('end', (r) => console.log('disconnected:', r));
