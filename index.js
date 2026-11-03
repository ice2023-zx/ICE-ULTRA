import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  getContentType,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';

// ═════════ CONFIG (edit here) ═════════
const BOT_NAME = process.env.BOT_NAME || 'ICE-X';
const PREFIX = process.env.PREFIX || '.';
const OWNER_NUMBER = process.env.OWNER_NUMBER || '0621115283';
const COUNTRY_CODE = process.env.COUNTRY_CODE || '255'; // 255 = Tanzania
// ════════════════════════════════════════

const digits = (s) => String(s).replace(/\D/g, '');
const OWNER = digits(OWNER_NUMBER).startsWith('0')
  ? COUNTRY_CODE + digits(OWNER_NUMBER).slice(1)
  : digits(OWNER_NUMBER);
const OWNER_JID = `${OWNER}@s.whatsapp.net`;

// ───── Settings (saved to disk) ─────
const SETTINGS_FILE = './settings.json';
const defaults = {
  publicMode: true,
  antilink: {},
  welcome: {},
  features: { antiDelete: false, autoViewStatus: false, autoRead: false, alwaysOnline: false, autoReact: false, chatbot: false, antiBan: true, viewOnceCache: true },
};
let loaded = {};
try { loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
const settings = { ...defaults, ...loaded, features: { ...defaults.features, ...loaded.features } };
const save = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

// ───── Helpers ─────
const startedAt = Date.now();
const num = (jid = '') => jid.split('@')[0].split(':')[0];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const uptime = () => {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
};
const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
const getText = async (url) => (await fetch(url, { signal: AbortSignal.timeout(8000) })).text();
const onOff = (b) => (b ? '✅ ON' : '❌ OFF');

// Anti-ban: limit reply speed per chat
const lastReply = new Map();
const canReply = (key, ms = 1200) => {
  if (!settings.features.antiBan) return true;
  const now = Date.now();
  if (now - (lastReply.get(key) || 0) < ms) return false;
  lastReply.set(key, now);
  return true;
};

// Message cache (for anti-delete + resending messages that failed to decrypt)
const cache = new Map();
const sentCache = new Map();
const cacheMessage = (msg) => {
  if (!msg?.key?.id) return;
  cache.set(msg.key.id, { key: msg.key, message: msg.message });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
};

// Group metadata cache (avoids asking WhatsApp on every message)
const metaCache = new Map();
const getMeta = async (sock, jid) => {
  const hit = metaCache.get(jid);
  if (hit && Date.now() - hit.t < 60000) return hit.m;
  const m = await sock.groupMetadata(jid);
  metaCache.set(jid, { m, t: Date.now() });
  return m;
};

// View Once: WhatsApp deletes the media once it is opened, so we download it
// as soon as it arrives (memory only, 30 min, max 8 items, <6MB each).
const vvCache = new Map();
async function captureViewOnce(sock, msg) {
  const m = msg.message;
  const wrapped = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
  const inner = wrapped || m;
  const type = getContentType(inner);
  if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(type)) return;
  const c = inner[type];
  if (!wrapped && !c.viewOnce) return;
  if (Number(c.fileLength) > 6 * 1024 * 1024) return;
  const buffer = await downloadMediaMessage({ key: msg.key, message: inner }, 'buffer', {}, {
    logger: pino({ level: 'silent' }),
    reuploadRequest: sock.updateMediaMessage,
  });
  const now = Date.now();
  for (const [k, v] of vvCache) if (now - v.t > 30 * 60 * 1000) vvCache.delete(k);
  vvCache.set(msg.key.id, { t: now, type, buffer, mimetype: c.mimetype, caption: c.caption || '', ptt: !!c.ptt, from: num(msg.key.participant || msg.key.remoteJid) });
  while (vvCache.size > 8) vvCache.delete(vvCache.keys().next().value);
}

const MEDIA = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
const describe = (m = {}) =>
  m.conversation || m.extendedTextMessage?.text ||
  (m.imageMessage && `[Photo] ${m.imageMessage.caption || ''}`) ||
  (m.videoMessage && `[Video] ${m.videoMessage.caption || ''}`) ||
  (m.audioMessage && '[Audio]') || (m.stickerMessage && '[Sticker]') ||
  (m.documentMessage && `[File] ${m.documentMessage.fileName || ''}`) || '[Unknown]';

async function resendMedia(sock, jid, m, caption = '') {
  const type = getContentType(m.message);
  const c = type && m.message[type];
  if (!c || !MEDIA.includes(type)) throw new Error('unsupported');
  const buffer = await downloadMediaMessage(m, 'buffer', {}, {
    logger: pino({ level: 'silent' }),
    reuploadRequest: sock.updateMediaMessage,
  });
  const out = {
    imageMessage: { image: buffer, caption: caption || c.caption || '' },
    videoMessage: { video: buffer, caption: caption || c.caption || '' },
    audioMessage: { audio: buffer, mimetype: c.mimetype || 'audio/ogg; codecs=opus', ptt: !!c.ptt },
    documentMessage: { document: buffer, mimetype: c.mimetype || 'application/octet-stream', fileName: c.fileName || 'file' },
    stickerMessage: { sticker: buffer },
  }[type];
  return sock.sendMessage(jid, out);
}

// ───── Content ─────
const roasts = [
  '😭 That was your best shot? I only felt a breeze.',
  '😈 You came to a roast battle with a butter knife.',
  '💀 That comeback needs a software update.',
  '🤣 Confidence 100%, damage 0%.',
  '😂 I\'ve seen loading screens with better comebacks.',
  '🔥 Cute. Now try again.',
  '😏 Even autocorrect couldn\'t save that one.',
];
const truths = [
  '👀 What\'s something you\'re really good at that people don\'t know about?',
  '😂 What\'s the funniest thing you\'ve ever done?',
  '🤔 What\'s one thing you want to learn this year?',
  '🔥 What\'s the biggest mistake you\'ve learned from?',
  '😎 Who was your first crush?',
];
const dares = [
  '😂 Send the funniest emoji combination you can think of.',
  '🤣 Send "I am a legend" to the group.',
  '😎 Say something nice about the person above you.',
  '💀 Send your last-used emoji three times.',
  '🎤 Send a voice note of you singing any song.',
];
const ball = ['🎱 Definitely yes.', '🎱 Most likely.', '🎱 Ask again later.', '🎱 Hard to tell.', '🎱 Probably not.', '🎱 My answer is no.'];
const quotes = [
  '💫 Small progress is still progress.',
  '🔥 Keep learning. Keep building.',
  '🚀 Every expert started as a beginner.',
  '⚡ Build something today that makes tomorrow easier.',
];
const botReplies = [
  'Hey! How can I help you today? 😊',
  "I'm listening... what's up?",
  'Tell me more 🔥',
  'Haha okay, and then?',
  `${BOT_NAME} is online 💪`,
  `Type *${PREFIX}menu* to see what I can do.`,
];

// ═════════ COMMANDS ═════════
const commands = {
  menu: {
    run: async ({ reply }) => {
      const p = PREFIX;
      await reply(
        `╭━━❄️ *${BOT_NAME}* ❄️━━╮\n` +
        `┃ 👑 wa.me/${OWNER}\n` +
        `┃ ⚙️ Prefix: ${p} | 🌐 ${settings.publicMode ? 'public' : 'self'}\n` +
        `┃ ⏱️ ${uptime()}\n` +
        `╰━━━━━━━━━━━━━━━╯\n\n` +
        `*📌 GENERAL*\n${p}ping ${p}alive ${p}runtime ${p}status\n${p}time ${p}owner ${p}about ${p}say <text>\n\n` +
        `*🎉 FUN*\n${p}joke ${p}fact ${p}quote ${p}roast\n${p}truth ${p}dare ${p}8ball <question>\n${p}weather <city> ${p}calc <2+2> ${p}flip ${p}dice\n\n` +
        `*📥 MEDIA*\n${p}getpp (@user/reply)\n${p}download (reply media)\n${p}vv (reply View Once, owner)\n\n` +
        `*👥 GROUP*\n${p}groupinfo ${p}groupid ${p}admins ${p}listmembers\n${p}tagall ${p}hidetag ${p}link\n${p}kick ${p}promote ${p}demote\n${p}antilink on/off ${p}welcome on/off\n\n` +
        `*🎭 PRESENCE*\n${p}typing ${p}recording ${p}available\n\n` +
        `*🛡️ FEATURES (owner)*\n${p}features\n${p}antidelete ${p}autoviewstatus ${p}autoread\n${p}alwaysonline ${p}autoreact ${p}chatbot ${p}antiban ${p}vvcache\n(all: on/off)\n\n` +
        `*👑 OWNER*\n${p}public ${p}self ${p}tome <text> ${p}restart`
      );
    },
  },
  ping: {
    run: async ({ sock, jid, msg }) => {
      const t = Date.now();
      const sent = await sock.sendMessage(jid, { text: '🏓 ...' }, { quoted: msg });
      await sock.sendMessage(jid, { text: `🏓 Pong! *${Date.now() - t}ms*`, edit: sent.key });
    },
  },
  alive: { run: async ({ reply }) => reply(`❄️ *${BOT_NAME}* is online!\n⏱️ Uptime: ${uptime()}`) },
  runtime: { run: async ({ reply }) => reply(`⏱️ Uptime: ${uptime()}`) },
  time: { run: async ({ reply }) => reply(`🕒 ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam' })} (EAT)`) },
  about: { run: async ({ reply }) => reply(`❄️ *${BOT_NAME}* v3.0\nWhatsApp bot with fun, group and utility commands.\nOwner: wa.me/${OWNER}`) },
  say: { run: async ({ reply, args }) => reply(args.join(' ') || `Usage: ${PREFIX}say <text>`) },
  flip: { run: async ({ reply }) => reply(Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails') },
  dice: { run: async ({ reply }) => reply(`🎲 You rolled *${1 + Math.floor(Math.random() * 6)}*`) },
  quote: { run: async ({ reply }) => reply(pick(quotes)) },
  roast: { run: async ({ reply }) => reply(`😈 *ROAST*\n\n${pick(roasts)}`) },
  truth: { run: async ({ reply }) => reply(`🎭 *TRUTH*\n\n${pick(truths)}`) },
  dare: { run: async ({ reply }) => reply(`🎯 *DARE*\n\n${pick(dares)}`) },
  '8ball': {
    run: async ({ reply, args }) =>
      args.length ? reply(`🎱 *8 BALL*\n\n❓ ${args.join(' ')}\n\n${pick(ball)}`) : reply(`Usage: ${PREFIX}8ball will I succeed?`),
  },

  status: {
    run: async ({ reply }) => {
      const f = settings.features;
      await reply(
        `📊 *${BOT_NAME} STATUS*\n\n🟢 Online | ⏱️ ${uptime()}\n` +
        `🛡️ Anti-Delete: ${onOff(f.antiDelete)}\n👁️ Auto-View Status: ${onOff(f.autoViewStatus)}\n` +
        `📖 Auto-Read: ${onOff(f.autoRead)}\n🟢 Always Online: ${onOff(f.alwaysOnline)}\n` +
        `❤️ Auto-React: ${onOff(f.autoReact)}\n💬 Chatbot: ${onOff(f.chatbot)}\n🚦 Anti-Ban: ${onOff(f.antiBan)}\n👁️ VV-Cache: ${onOff(f.viewOnceCache)}`
      );
    },
  },
  owner: {
    run: async ({ sock, jid, msg }) =>
      sock.sendMessage(jid, {
        contacts: {
          displayName: `${BOT_NAME} Owner`,
          contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${BOT_NAME} Owner\nTEL;type=CELL;waid=${OWNER}:+${OWNER}\nEND:VCARD` }],
        },
      }, { quoted: msg }),
  },
  joke: {
    run: async ({ reply }) => {
      try { await reply(`😂 ${(await getJson('https://v2.jokeapi.dev/joke/Any?safe-mode&type=single')).joke}`); }
      catch { await reply('😂 Why do programmers prefer dark mode? Because light attracts bugs.'); }
    },
  },
  fact: {
    run: async ({ reply }) => {
      try { await reply(`💡 ${(await getJson('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en')).text}`); }
      catch { await reply('🐙 Octopuses have three hearts.'); }
    },
  },
  weather: {
    run: async ({ reply, args }) => {
      if (!args.length) return reply(`Usage: ${PREFIX}weather London`);
      try { await reply(`🌤️ ${(await getText(`https://wttr.in/${encodeURIComponent(args.join(' '))}?format=3`)).trim()}`); }
      catch { await reply("Couldn't get the weather."); }
    },
  },
  calc: {
    run: async ({ reply, args }) => {
      const expr = args.join(' ').replace(/\^/g, '**');
      if (!expr || !/^[0-9+\-*/().%\s*]+$/.test(expr)) return reply(`Usage: ${PREFIX}calc 12*(3+4)`);
      try { await reply(`🧮 ${args.join(' ')} = *${Function(`"use strict";return (${expr})`)()}*`); }
      catch { await reply('Invalid expression.'); }
    },
  },

  // ───── Media ─────
  getpp: {
    run: async ({ sock, jid, msg, reply }) => {
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      const target = ctx?.mentionedJid?.[0] || ctx?.participant || msg.key.participant || msg.key.remoteJid;
      try {
        const url = await sock.profilePictureUrl(target, 'image');
        await sock.sendMessage(jid, { image: { url }, caption: `🖼️ +${num(target)}` }, { quoted: msg });
      } catch { await reply('No profile picture, or it is hidden.'); }
    },
  },
  download: {
    run: async ({ sock, jid, msg, reply }) => {
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      if (!ctx?.quotedMessage) return reply('Reply to a photo/video/audio/file, then send .download');
      const fake = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage };
      try { await resendMedia(sock, jid, fake, '📥 Downloaded'); }
      catch { await reply("❌ Failed. The media may have expired, or the type isn't supported."); }
    },
  },

  vv: {
    owner: true,
    run: async ({ sock, msg, reply }) => {
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      if (!ctx?.stanzaId) return reply(`👁️ *VIEW ONCE*\n\nReply to a View Once photo/video with *${PREFIX}vv*`);
      const item = vvCache.get(ctx.stanzaId);
      if (!item) return reply("❌ I didn't capture this one. .vv only works for View Once messages that arrive *while the bot is online* (within 30 minutes). Send a new one to try.");
      const cap = `👁️ View Once from +${item.from}${item.caption ? '\n' + item.caption : ''}`;
      const out = {
        imageMessage: { image: item.buffer, caption: cap },
        videoMessage: { video: item.buffer, caption: cap },
        audioMessage: { audio: item.buffer, mimetype: item.mimetype || 'audio/ogg; codecs=opus', ptt: item.ptt },
      }[item.type];
      await sock.sendMessage(OWNER_JID, out);
      await reply('✅ Sent to your DM.');
    },
  },

  // ───── Presence ─────
  typing: { run: async ({ sock, jid, reply }) => { await sock.sendPresenceUpdate('composing', jid); await reply('⌨️ typing...'); } },
  recording: { run: async ({ sock, jid, reply }) => { await sock.sendPresenceUpdate('recording', jid); await reply('🎙️ recording...'); } },
  available: { run: async ({ sock, jid, reply }) => { await sock.sendPresenceUpdate('available', jid); await reply('🟢 available'); } },

  // ───── Group ─────
  groupid: { group: true, run: async ({ jid, reply }) => reply(`🆔 ${jid}`) },
  groupinfo: {
    group: true,
    run: async ({ sock, jid, reply }) => {
      const m = await getMeta(sock, jid);
      await reply(`*👥 ${m.subject}*\nMembers: ${m.participants.length}\nAdmins: ${m.participants.filter((p) => p.admin).length}\nCreated: ${new Date(m.creation * 1000).toLocaleDateString('en-GB')}\n\n${m.desc || ''}`);
    },
  },
  admins: {
    group: true,
    run: async ({ sock, jid }) => {
      const a = (await getMeta(sock, jid)).participants.filter((p) => p.admin).map((p) => p.id);
      await sock.sendMessage(jid, { text: `🛡️ *Admins (${a.length})*\n\n` + a.map((i) => `• @${num(i)}`).join('\n'), mentions: a });
    },
  },
  listmembers: {
    group: true,
    run: async ({ sock, jid, reply }) => {
      const p = (await getMeta(sock, jid)).participants;
      await reply(`👥 *Members (${p.length})*\n\n` + p.slice(0, 100).map((x, i) => `${i + 1}. +${num(x.id)}`).join('\n') + (p.length > 100 ? '\n...' : ''));
    },
  },
  link: { group: true, botAdmin: true, run: async ({ sock, jid, reply }) => reply(`🔗 https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`) },
  tagall: {
    group: true, admin: true,
    run: async ({ sock, jid, args }) => {
      const ids = (await getMeta(sock, jid)).participants.map((p) => p.id);
      await sock.sendMessage(jid, { text: `📢 ${args.join(' ') || 'Attention everyone!'}\n\n` + ids.map((i) => `@${num(i)}`).join(' '), mentions: ids });
    },
  },
  hidetag: {
    group: true, admin: true,
    run: async ({ sock, jid, args }) => sock.sendMessage(jid, { text: args.join(' ') || '📢', mentions: (await getMeta(sock, jid)).participants.map((p) => p.id) }),
  },
  kick: { group: true, admin: true, botAdmin: true, target: true, run: async ({ sock, jid, targets, reply }) => { await sock.groupParticipantsUpdate(jid, targets, 'remove'); await reply('✅ User removed.'); } },
  promote: { group: true, admin: true, botAdmin: true, target: true, run: async ({ sock, jid, targets, reply }) => { await sock.groupParticipantsUpdate(jid, targets, 'promote'); await reply('✅ User promoted to admin.'); } },
  demote: { group: true, admin: true, botAdmin: true, target: true, run: async ({ sock, jid, targets, reply }) => { await sock.groupParticipantsUpdate(jid, targets, 'demote'); await reply('✅ User demoted.'); } },
  antilink: {
    group: true, admin: true,
    run: async ({ jid, args, reply }) => {
      if (!['on', 'off'].includes(args[0])) return reply(`Usage: ${PREFIX}antilink on/off`);
      settings.antilink[jid] = args[0] === 'on'; save();
      await reply(`🔗 Antilink: *${args[0]}*`);
    },
  },
  welcome: {
    group: true, admin: true,
    run: async ({ jid, args, reply }) => {
      if (!['on', 'off'].includes(args[0])) return reply(`Usage: ${PREFIX}welcome on/off`);
      settings.welcome[jid] = args[0] === 'on'; save();
      await reply(`👋 Welcome: *${args[0]}*`);
    },
  },

  // ───── Owner ─────
  public: { owner: true, run: async ({ reply }) => { settings.publicMode = true; save(); await reply('🌐 Mode: public'); } },
  self: { owner: true, run: async ({ reply }) => { settings.publicMode = false; save(); await reply('🔒 Mode: self (owner only)'); } },
  tome: {
    owner: true,
    run: async ({ sock, args, reply }) => {
      await sock.sendMessage(OWNER_JID, { text: args.join(' ') || 'This is a test message sent to my own number.' });
      await reply('✅ Sent to your own number.');
    },
  },
  restart: { owner: true, run: async ({ reply }) => { await reply('♻️ Restarting...'); setTimeout(() => process.exit(0), 1000); } },
};

// Feature toggles (owner): .antidelete on/off, etc.
const toggles = {
  antidelete: 'antiDelete', autoviewstatus: 'autoViewStatus', autoread: 'autoRead',
  alwaysonline: 'alwaysOnline', autoreact: 'autoReact', chatbot: 'chatbot', antiban: 'antiBan', vvcache: 'viewOnceCache',
};
for (const [cmd, key] of Object.entries(toggles)) {
  commands[cmd] = {
    owner: true,
    run: async ({ args, reply }) => {
      if (!['on', 'off'].includes(args[0])) return reply(`Usage: ${PREFIX}${cmd} on/off\nNow: ${onOff(settings.features[key])}`);
      settings.features[key] = args[0] === 'on'; save();
      await reply(`${cmd}: ${onOff(settings.features[key])}`);
    },
  };
}
commands.viewonce = commands.vv;
commands.reveal = commands.vv;
commands.features = { owner: true, run: commands.status.run };

// ═════════ HANDLERS ═════════
const bodyOf = (m) =>
  m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption ||
  m.ephemeralMessage?.message?.extendedTextMessage?.text || m.ephemeralMessage?.message?.conversation || '';

async function recoverDeleted(sock, proto) {
  const cached = cache.get(proto.key?.id);
  if (!cached) return;
  const chat = cached.key.remoteJid;
  const from = num(cached.key.participant || chat);
  await sock.sendMessage(OWNER_JID, {
    text: `🛡️ *ANTI-DELETE*\n\n💬 Chat: ${chat.endsWith('@g.us') ? 'group' : '+' + num(chat)}\n👤 From: +${from}\n\n${describe(cached.message)}`,
  });
  if (MEDIA.includes(getContentType(cached.message))) {
    try { await resendMedia(sock, OWNER_JID, cached, '🛡️ Deleted media'); } catch {}
  }
}

async function onMessage(sock, msg, type) {
  if (!msg.message || !msg.key.remoteJid) return;
  const jid = msg.key.remoteJid;
  const f = settings.features;
  const fromMe = msg.key.fromMe;

  if (jid === 'status@broadcast') {
    if (f.autoViewStatus && !fromMe) await sock.readMessages([msg.key]).catch(() => {});
    return;
  }
  if (!fromMe) cacheMessage(msg);
  if (!fromMe && f.viewOnceCache) captureViewOnce(sock, msg).catch((e) => console.error('vv capture:', e.message));

  const proto = msg.message.protocolMessage;
  if (proto && (proto.type === 0 || proto.type === 'REVOKE')) {
    if (f.antiDelete) await recoverDeleted(sock, proto);
    return;
  }
  if (type !== 'notify') return;

  if (f.autoRead && !fromMe) await sock.readMessages([msg.key]).catch(() => {});
  if (f.autoReact && !fromMe && canReply(`react:${jid}`, 4000)) {
    await sock.sendMessage(jid, { react: { text: pick(['👍', '❤️', '😂', '🔥', '👏']), key: msg.key } }).catch(() => {});
  }
  await handle(sock, msg);
}

async function handle(sock, msg) {
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const sender = num(msg.key.participant || jid);
  const isOwner = msg.key.fromMe || sender === OWNER;
  const text = bodyOf(msg.message).trim();
  if (!text) return;

  let isAdmin = false, botAdmin = false;
  const needMeta = () => isGroup && (settings.antilink[jid] || text.startsWith(PREFIX));
  if (needMeta()) {
    try {
      const meta = await getMeta(sock, jid);
      isAdmin = meta.participants.some((p) => num(p.id) === sender && p.admin);
      botAdmin = meta.participants.some((p) => num(p.id) === num(sock.user.id) && p.admin);
    } catch {}
  }

  // Antilink
  if (isGroup && settings.antilink[jid] && !isAdmin && !isOwner && botAdmin && /chat\.whatsapp\.com\/[A-Za-z0-9]+/i.test(text)) {
    await sock.sendMessage(jid, { delete: msg.key });
    await sock.sendMessage(jid, { text: `⚠️ @${sender} links are not allowed here.`, mentions: [`${sender}@s.whatsapp.net`] });
    return;
  }

  if (!settings.publicMode && !isOwner) return;

  // Chatbot (DM tu, si command)
  if (!text.startsWith(PREFIX)) {
    if (settings.features.chatbot && !isGroup && !msg.key.fromMe && canReply(`bot:${jid}`, 3000)) {
      await sock.sendMessage(jid, { text: pick(botReplies) });
    }
    return;
  }

  const [name, ...args] = text.slice(PREFIX.length).split(/\s+/);
  const cmd = commands[name.toLowerCase()];
  if (!cmd) return;
  if (!canReply(jid) && !['ping', 'alive', 'menu'].includes(name.toLowerCase())) return;

  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
  if (cmd.owner && !isOwner) return reply('👑 Owner only.');
  if (cmd.group && !isGroup) return reply('👥 Groups only.');
  if (cmd.admin && !isAdmin && !isOwner) return reply('🛡️ Admins only.');
  if (cmd.botAdmin && !botAdmin) return reply('🤖 Make me an admin first.');

  let targets = [];
  if (cmd.target) {
    const ctx = msg.message.extendedTextMessage?.contextInfo;
    targets = [...(ctx?.mentionedJid || []), ...(ctx?.participant ? [ctx.participant] : [])]
      .filter((t) => num(t) !== OWNER && num(t) !== num(sock.user.id));
    if (!targets.length) return reply('Tag someone or reply to their message.');
  }

  try {
    await sock.sendPresenceUpdate('composing', jid);
    await cmd.run({ sock, msg, jid, args, reply, isGroup, isAdmin, isOwner, targets });
  } catch (e) {
    console.error(`Command ${name} failed:`, e);
    await reply('⚠️ Something went wrong, please try again.');
  }
}

// ═════════ CONNECTION ═════════
let onlineTimer;
let currentSock = null;
async function start() {
  const old = currentSock;
  currentSock = null; // stop the old socket from triggering another reconnect
  try { old?.end(undefined); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: settings.features.alwaysOnline,
    syncFullHistory: false,
    // Important: if the phone fails to decrypt a message ("Waiting for this message"),
    // WhatsApp asks for it to be resent, and the bot must keep a copy.
    getMessage: async (key) => cache.get(key.id)?.message || sentCache.get(key.id) || undefined,
  });
  currentSock = sock;

  const rawSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...a) => {
    const r = await rawSend(...a);
    if (r?.key?.id && r.message) {
      sentCache.set(r.key.id, r.message);
      if (sentCache.size > 300) sentCache.delete(sentCache.keys().next().value);
    }
    return r;
  };

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(OWNER);
        console.log(`\n══════════════════════════\n ${BOT_NAME} PAIRING CODE (+${OWNER}):  ${code}\n══════════════════════════\n`);
      } catch (e) { console.error('Pairing code failed:', e.message); }
    }, 4000);
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected (+${num(sock.user.id)})`);
      clearInterval(onlineTimer);
      onlineTimer = setInterval(() => {
        if (settings.features.alwaysOnline) sock.sendPresenceUpdate('available').catch(() => {});
      }, 25000);
    }
    if (connection === 'close') {
      if (sock !== currentSock) return;
      clearInterval(onlineTimer);
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete the "auth" folder and start again.');
      } else { console.log('Connection closed, reconnecting...'); setTimeout(start, 3000); }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) onMessage(sock, m, type).catch((e) => console.error(e));
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action !== 'add' || !settings.welcome[id]) return;
    try {
      const meta = await getMeta(sock, id);
      const jids = participants.map((p) => (typeof p === 'string' ? p : p.id));
      await sock.sendMessage(id, { text: `👋 Welcome ${jids.map((j) => `@${num(j)}`).join(' ')} to *${meta.subject}*!`, mentions: jids });
    } catch {}
  });
}

process.on('unhandledRejection', (e) => console.error('Unhandled:', e));
start();
