module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { JP_CRAFT } = ctx.C;
const HELP = ['ヘルプ: ついてきて/こっちきて/とまれ/木切って/石掘って/鉄掘って/たたかって/まもって/装備して/食べて/もちもの/寝て/釣って/◯◯作って/もどって/預けて/〇〇出して/覚えてること/木ちょうだい/一人でサバイバル/拠点つくって/ベッド作って/うちかえる'];

// ---- chat commands ----
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  console.log(`<${username}> ${message}`);
  const msg = message.trim();
  try {
    if (msg.includes('とまれ') || msg === 'stop') { ctx.stopAll(); return; }
    if (msg.includes('ヘルプ') || msg === 'help') { HELP.forEach(h => ctx.say(h)); return; }
    if (msg.includes('一人でサバイバル') || msg.includes('ソロでやって')) { ctx.soloSurvival(); return; }
    if (msg.includes('鉄の剣')) { ctx.swordMission(); return; }
    if (msg.includes('鉄装備')) { ctx.armorMission(); return; }
    if (msg.includes('まもって') || msg.includes('護衛して')) { ctx.startGuard(username); return; }
    if (msg === '寝て' || msg === 'ねて' || msg.includes('寝て')) { ctx.goSleep(); return; }
    if (msg.includes('釣って') || msg === 'つり' || msg.includes('釣りして')) { ctx.fishLoop(); return; }
    if (msg.includes('もどって')) {
      if (!S.deathPos) { ctx.say('死んだ場所の記録がない'); return; }
      S.desiredState = 'busy'; ctx.say('死んだ場所へ戻るね');
      try { await bot.pathfinder.goto(new goals.GoalNear(S.deathPos.x, S.deathPos.y, S.deathPos.z, 2)); ctx.say('着いた'); } catch (e) { ctx.fail('戻れなかった', e); } finally { if (S.desiredState==='busy') S.desiredState='idle'; } return;
    }
    if (msg.includes('預けて')) { ctx.depositToChest(); return; }
    if (msg.includes('覚えてる') || msg === '記憶') { ctx.sayMemory(); return; }
    const wm = msg.match(/^(.+?)(出して|取ってきて|とってきて)$/);
    if (wm && wm[1].trim()) { ctx.withdrawFromChest(wm[1].trim()); return; }
    const giveMatch = msg.match(/^(?:渡して)\s*(\S+)$/) || (msg.includes('ちょうだい') ? [null, msg.replace('ちょうだい','').trim() || '木'] : null);
    if (giveMatch) { ctx.giveItem(username, giveMatch[1]); return; }
    // wooden pickaxe: full chain from gathering (plain craftItem has no materials to work with)
    if ((msg.includes('ツルハシ') || msg.includes('ピッケル')) && msg.includes('作って') && !msg.includes('石') && !msg.includes('鉄')) { ctx.pickaxeMission(); return; }
    if (msg.includes('ベッド') && (msg.includes('作って') || msg.includes('つくって'))) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.bedMission(); return; }
    // craft: "<something>作って"
    const craftMatch = msg.match(/^(.+?)(?:を)?作って$/);
    if (craftMatch) { const key = craftMatch[1].trim(); const id = JP_CRAFT[key] || (/^[a-z_]+$/.test(key) ? key : null); if (id) { S.desiredState='busy'; try { await ctx.craftItem(id, 1); } finally { if(S.desiredState==='busy') S.desiredState='idle'; } } else ctx.say(`「${key}」の作り方は未対応。対応: 木のツルハシ/石のツルハシ/作業台/棒/松明/英語ID`); return; }
    if (msg.includes('ついてきて') || msg === 'follow') {
      const target = bot.players[username]?.entity; if (!target) { ctx.say('姿が見えない'); return; }
      ctx.targets.entity = target;
      if (S.stateMachine) { S.desiredState = 'follow'; } else { bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); }
      ctx.say('ついていく'); return;
    }
    if (msg.includes('こっちきて') || msg === 'come') {
      const target = bot.players[username]?.entity; if (!target) { ctx.say('姿が見えない'); return; }
      ctx.targets.position = target.position.clone();
      if (S.stateMachine) { S.desiredState = 'come'; } else { await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1)); }
      ctx.say('いくね'); return;
    }
    // collect counts: 木を5個 / 木 5
    const countMatch = msg.match(/(\d+)\s*(?:個)?/); const cnt = countMatch ? Math.min(parseInt(countMatch[1], 10) || 1, 64) : 1;
    if (/木切って|木を切って|原木掘って/.test(msg) || /^木\s*\d*\s*(掘って|切って)?$/.test(msg) && /掘|切/.test(msg)) { const n = await ctx.collectByNames(LOG_TYPES, cnt === 1 && !countMatch ? 1 : cnt, '原木'); ctx.say(n ? '掘れたよ' : '掘れなかった'); return; }
    if (msg.includes('石掘って')) { const before = ctx.countItem('cobblestone'); await ctx.mineStoneManual(Math.min(cnt, 11)); ctx.say(ctx.countItem('cobblestone') > before ? '掘れたよ' : '石が掘れなかった（露出した石が近くにないかも）'); return; }
    if (msg.includes('鉄掘って')) { const n = await ctx.collectByNames(['iron_ore','deepslate_iron_ore'], cnt, '鉄鉱石'); ctx.say(n ? '掘れたよ' : '掘れなかった'); return; }
    const generic = msg.match(/([a-z_]+)\s*(?:を)?掘って/) || msg.match(/掘って\s*([a-z_]+)/);
    if (generic) { const n = await ctx.collectByNames([generic[1]], cnt, generic[1]); ctx.say(n ? '掘れたよ' : '掘れなかった'); return; }
    if (msg.includes('掘って')) { ctx.say('何を掘るか教えて。例: 木切って / 石掘って / 鉄掘って / iron_ore掘って'); return; }
    if (msg.includes('たたかって') || msg.includes('攻撃')) {
      let ent = ctx.nearestHostile(16);
      if (!ent) { // nearest any non-player entity
        const es = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && e.type === 'mob'); es.sort((a,b)=>bot.entity.position.distanceTo(a.position)-bot.entity.position.distanceTo(b.position)); ent = es[0] || null; }
      await ctx.attackEntity(ent); return;
    }
    if (msg.includes('装備して')) { try { await bot.armorManager.equipAll(); ctx.say('装備した'); } catch (e) { ctx.fail('装備できなかった', e); } return; }
    if (msg.includes('食べて')) {
      try { if (bot.autoEat?.eat) await bot.autoEat.eat(); else if (bot.autoEat?.eatAt) await bot.autoEat.eatAt(); else { const food = bot.inventory.items().find(i => ctx.isFood(i.name)); if (!food) { ctx.say('食べ物を持ってない'); return; } await bot.equip(food, 'hand'); await bot.consume(); } ctx.say('食べた'); } catch (e) { ctx.fail('食べられなかった', e); } return;
    }
    if (msg.includes('もちもの') || msg === 'inventory') { const l = ctx.invList(); if (!l.length) ctx.say('何も持ってない'); else { let buf=''; for (const s of l) { if ((buf+s).length>170){ ctx.say(buf); buf=''; } buf += (buf?', ':'')+s; } if (buf) ctx.say(buf); } return; }
    const tossMatch = msg.match(/捨てて\s*(\S+)/); if (tossMatch) { const name = JP_ITEMS[tossMatch[1]] || tossMatch[1]; const it = bot.inventory.items().find(i=>i.name===name); if (!it) ctx.say('それは持ってない'); else { try { await bot.tossStack(it); ctx.say(`${name}を捨てた`);} catch(e){ctx.fail('捨てられなかった',e);} } return; }
    if (msg.includes('拠点つくって') || msg.includes('拠点作って') || msg.includes('家つくって') || msg.includes('家作って')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.buildBase(); return; }
    if (msg.includes('うちかえる') || msg.includes('拠点かえる') || msg.includes('拠点へ帰る') || msg.includes('家かえる')) {
      if (!settings.home) { ctx.say('まだ拠点がない。「拠点つくって」で作るよ'); return; }
      S.desiredState = 'busy';
      const ok = await ctx.goHome().catch(() => false);
      if (S.desiredState === 'busy') S.desiredState = 'idle';
      ctx.say(ok ? '拠点に帰ったよ' : '拠点に帰れなかった');
      return;
    }
    if (msg.includes('むぜ')) { ctx.say('なに？ ヘルプって言うとコマンド一覧出すよ'); return; }
  } catch (e) { ctx.fail('コマンド処理で失敗', e); }
});
};
