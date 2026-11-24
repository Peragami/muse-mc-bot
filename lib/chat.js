const shared = require('./shared');
module.exports = (ctx) => {
  const { bot, goals, settings, memory, S } = ctx;
  const { JP_CRAFT, JP_ITEMS, LOG_TYPES } = ctx.C;
const HELP = ['ヘルプ: ついてきて/こっちきて/とまれ/木切って/石掘って/鉄掘って/たたかって/まもって/装備して/食べて/もちもの/寝て/釣って/◯◯作って/もどって/預けて/〇〇出して/覚えてること/木ちょうだい/一人でサバイバル/拠点つくって/ベッド作って/拠点を整えて/池作って/うちかえる', '名指しOK: 「ねむは拠点建てて、ゆめは釣りしてて」「みんなで家建てて」みたいに一人ずつ別々の指示もできる'];

// ---- chat commands ----
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  // Rescue protocol across processes (2026-11-24): the dev Muze
  // lives in another process, so its stuck SOS arrives as chat
  // WITH coordinates — turn it into a shared.helpReq here so the
  // pair's rescue duty answers it. Its other chatter, like the
  // pair's own, is never a command (a completion phrase once
  // re-triggered a mission through this route).
  if (username === 'Muze') {
    const m = message.match(/[\(（](-?\d+),\s*(-?\d+),\s*(-?\d+)[\)）]/);
    if (message.includes('助けて') && m) {
      // Dev Muze gets its OWN slot: writing its SOS into
      // shared.helpReq overwrote a pair member's active
      // request (live 2026-11-25: Nemu's SOS was replaced by
      // Muze's, the rescue queue forgot her, and Nemu then
      // "launched a rescue" for Muze from inside her own
      // hole). The rescue duty reads helpReq first and only
      // falls back to devHelpReq.
      shared.devHelpReq = { by: 'Muze', x: +m[1], y: +m[2], z: +m[3], at: Date.now(), reason: 'stuck' };
      console.log(`[help] Muze SOS via chat at ${m[1]}, ${m[2]}, ${m[3]}`);
    }
    return;
  }
  if (username === 'Nemu' || username === 'Yume') {
    // A partner's "exit is open" announcement completes the
    // rescue protocol for a body stuck in THIS process (the
    // rescuer may be the other process's pair member).
    if (message.includes('道開けたよ') && shared.helpReq && shared.helpReq.by === bot.username) {
      shared.rescue = { for: bot.username, by: username, phase: 'open', at: Date.now() };
      console.log('[rescue] partner opened the exit (announced via chat)');
    }
    return; // bots never take orders from bots
  }
  console.log(`<${username}> ${message}`);
  const msg = message.trim();
  if (msg.includes('とまれ') || msg === 'stop') { ctx.stopAll(); return; } // stop always reaches every body
  // Multi-target addressing (user request 2026-11-24): one
  // message can carry a different order per body —
  // 「むぜとねむは拠点建てて！ゆめは釣りしてて」 — and みんな/全員
  // addresses every body at once. Split into clauses; each body
  // runs only the clauses naming it (or みんな). A message with
  // no named clause at all keeps the legacy routing below.
  const myKey = bot.username.toLowerCase();
  // A name counts as an ADDRESSEE only when followed by a particle
  // (は/と), a clause separator, whitespace or the end of the clause:
  // plain substring matching routed 「ねむいから寝て」 to Nemu and
  // 「ゆめみる」 to Yume (audit 2026-11-25). Mentions like ゆめの近く
  // (name + の) deliberately do not count.
  const ADDR_AFTER = '(?=は|と|、|，|,|：|:|！|!|。|\\s|$)';
  const clauseTargets = (text) => {
    const t = [];
    if (/みんな|全員/.test(text)) t.push('all');
    if (new RegExp(`ねむ${ADDR_AFTER}`).test(text) || /\bnemu\b/i.test(text)) t.push('nemu');
    if (new RegExp(`ゆめ${ADDR_AFTER}`).test(text) || /\byume\b/i.test(text)) t.push('yume');
    if (new RegExp(`むぜ${ADDR_AFTER}`).test(text) || /\bmuze\b/i.test(text)) t.push('muze');
    return t;
  };
  const stripAddressee = (text) => text.replace(/^((?:むぜ|ねむ|ゆめ|muze|nemu|yume|みんなで|みんな|全員)(?:と|は|、|,|\s)*)+/i, '').trim();
  const clauses = msg.split(/[！!。、\n]+/).map(s => s.trim()).filter(Boolean);
  if (clauses.some(c => clauseTargets(c).length)) {
    // Unnamed clauses inherit the most recent named clause's
    // addressee (a leading unnamed clause defaults to the primary,
    // matching legacy routing). The old code silently DISCARDED
    // every unnamed clause once any clause was named, and still ran
    // a first named clause on a body that was already mid-mission
    // (audit 2026-11-25) — both fixed here.
    let inherited = ctx.cfg.primary ? [myKey] : ['nemu'];
    for (const raw of clauses) {
      const t = clauseTargets(raw);
      if (t.length) inherited = t;
      if (!inherited.includes('all') && !inherited.includes(myKey)) continue;
      const clean = stripAddressee(raw);
      if (!clean) continue; // name-only clause: it only set the addressee
      if (ctx.anyMissionActive()) {
        console.log(`[chat] ${bot.username}: clause skipped while busy: ${raw}`);
        if (inherited.length === 1 && inherited[0] === myKey) ctx.say('今は別の作業中');
        continue;
      }
      console.log(`[chat] ${bot.username} takes clause: ${clean}`);
      await handleCommand(username, clean);
    }
    return;
  }
  // Pair addressing (in-game chat only; dashboard commands arrive
  // with username 'Dashboard' and always address their own body):
  // an unprefixed command goes to the primary; naming ゆめ routes
  // it to Yume.
  if (username !== 'Dashboard') {
    const namedMuze = msg.includes('むぜ');
    const namedYume = msg.includes('ゆめ');
    if (ctx.cfg.primary && namedYume && !namedMuze) return;
    if (!ctx.cfg.primary && !namedYume) return;
  }
  await handleCommand(username, msg);
});

const handleCommand = async (username, msg) => {
  try {
    if (msg.includes('ヘルプ') || msg === 'help') { HELP.forEach(h => ctx.say(h)); return; }
    if (msg.includes('一人でサバイバル') || msg.includes('ソロでやって')) { ctx.soloSurvival(); return; }
    if (msg.includes('鉄の剣')) { ctx.swordMission(); return; }
    if (msg.includes('鉄装備')) { ctx.armorMission(); return; }
    if (msg.includes('まもって') || msg.includes('護衛して')) { ctx.startGuard(username); return; }
    if (msg === '寝て' || msg === 'ねて' || msg.includes('寝て')) { ctx.goSleep(); return; }
    if (msg.includes('釣って') || msg === 'つり' || msg.includes('釣りして')) { ctx.fishMission(); return; }
    if (msg.includes('焼いて') || msg.includes('調理して')) { (async () => { const n = await ctx.cookFood(6); if (!n) ctx.say('焼けるものがなかった'); })().catch(e => console.log('[chat] cook route:', e && e.message || e)); return; }
    if (msg.includes('もどって')) {
      if (!S.deathPos) { ctx.say('死んだ場所の記録がない'); return; }
      S.desiredState = 'busy'; ctx.say('死んだ場所へ戻るね');
      try { await bot.pathfinder.goto(new goals.GoalNear(S.deathPos.x, S.deathPos.y, S.deathPos.z, 2)); ctx.say('着いた'); } catch (e) { ctx.fail('戻れなかった', e); } finally { if (S.desiredState==='busy') S.desiredState='idle'; } return;
    }
    if (msg.includes('預けて')) { ctx.depositToChest(); return; }
    if (msg.includes('覚えてる') || msg === '記憶') { ctx.sayMemory(); return; }
    const wm = msg.match(/^(.+?)(出して|取ってきて|とってきて)$/);
    if (wm && wm[1].trim()) { ctx.withdrawFromChest(wm[1].trim()); return; }
    // 「○○もらってきて」: fetch the item from the partner body instead
    // of gathering it (lib/coop.js). Distinct from ちょうだい, which
    // means "hand it to me, the player" (giveItem below).
    const fetchMatch = msg.match(/^(.{1,8}?)もらって/);
    if (fetchMatch) {
      const rawName = fetchMatch[1].trim();
      const itemName = ctx.C.JP_ITEMS[rawName] || rawName;
      if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; }
      ctx.say(`${itemName}、相方にもらいに行くね`);
      (async () => { const ok = await ctx.askPartnerFor(itemName, 1); if (!ok) ctx.say('相方も持ってなかった'); })().catch(e => console.log('[chat] fetch route:', e && e.message || e));
      return;
    }
    const giveMatch = msg.match(/^(?:渡して)\s*(\S+)$/) || (msg.includes('ちょうだい') ? [null, msg.replace('ちょうだい','').trim() || '木'] : null);
    if (giveMatch) { ctx.giveItem(username, giveMatch[1]); return; }
    // wooden pickaxe: full chain from gathering (plain craftItem has no materials to work with)
    if (msg.includes('助けて')) { const p = bot.entity.position; shared.helpReq = { by: bot.username, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now(), reason: 'manual' }; console.log(`[help] ${bot.username} asked for help manually`); ctx.say('助けを呼んだよ'); return; }
    if (msg.includes('羊') && (msg.includes('探して') || msg.includes('さがして'))) { shared.sheepReq = { by: bot.username, at: Date.now() }; console.log(`[scout] ${bot.username} requested a sheep scout`); ctx.say('羊探し、相方に手伝ってもらうね'); return; }
    if (msg.includes('井戸')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.fillWellMission(); return; }
    if (msg.includes('穴') && msg.includes('ふさ') && !msg.includes('終わっ')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.fillHoleMission(true); return; }
    if (msg.includes('チェスト') && (msg.includes('広げ') || msg.includes('二重'))) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.expandChest(); return; }
    if (msg.includes('空洞') && (msg.includes('ふさ') || msg.includes('埋め'))) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.caveFillMission(); return; }
    if ((msg.includes('ツルハシ') || msg.includes('ピッケル')) && msg.includes('作って') && !msg.includes('石') && !msg.includes('鉄')) { ctx.pickaxeMission(); return; }
    if (msg.includes('ベッド') && (msg.includes('作って') || msg.includes('つくって'))) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.bedMission(); return; }
    if (msg.includes('池') && (msg.includes('作って') || msg.includes('つくって'))) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.makePond(); return; }
    if (msg.includes('片付') || msg.includes('掃除')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.cleanupMission(); return; }
    if (msg.includes('建て直') || msg.includes('修復')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.repairBase(); return; }
    if ((msg.includes('家') || msg.includes('拠点')) && msg.includes('建てて')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.buildBaseV2(); return; }
    if (msg.includes('かまど') || msg.includes('松明') || msg.includes('整えて')) { if (ctx.anyMissionActive()) { ctx.say('今は別の作業中'); return; } ctx.furnishBase(); return; }
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
    if (msg.includes('石掘って')) { const before = ctx.countItem('cobblestone'); await ctx.gatherCobble(before + Math.min(cnt, 11)).catch(() => {}); const gained = ctx.countItem('cobblestone') - before; ctx.say(gained > 0 ? `${gained}個掘れたよ` : '石が掘れなかった（露出した石が近くにないかも）'); return; }
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
};
};
