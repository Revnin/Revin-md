const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  WAMessageStubType,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const ytDlp = require('yt-dlp-exec');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const entry = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!entry || entry[1].startsWith('#')) continue;
    const value = entry[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[entry[1]] === undefined) process.env[entry[1]] = value;
  }
}

loadEnv();

const BOT_NAME = process.env.BOT_NAME || 'Revin-MD';
const SONG_TIMEOUT_MS = Number.parseInt(process.env.SONG_TIMEOUT_MS, 10) || 45000;
const PREFIX = process.env.PREFIX || '.';
const OWNER_NAME = process.env.OWNER_NAME || 'Revin';
const OWNER_NUMBER = process.env.OWNER_NUMBER || '';
const ANTIDELETE_ENABLED = process.env.ANTIDELETE !== 'false';
const STARTUP_NOTIFY = process.env.STARTUP_NOTIFY !== 'false';
const MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || 'https://imgur.com/a/KcGHbfW';
const ANTIDELETE_DESTINATION = process.env.ANTIDELETE_DESTINATION || 'owner';
let resolvedMenuImageUrl;
let retryCount = 0;
let latestSocket;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function isAdmin(participant) {
  return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
}

function sameJid(first, second) {
  if (!first || !second) return false;
  return first === second || first.split('@')[0].split(':')[0] === second.split('@')[0].split(':')[0];
}

function phoneToJid(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.length >= 7 ? `${digits}@s.whatsapp.net` : null;
}

function ownJid(sock) {
  return sock.user?.id?.replace(/:\d+(?=@)/, '') || null;
}

function csvValue(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

async function getMenuImageUrl() {
  if (resolvedMenuImageUrl !== undefined) return resolvedMenuImageUrl;
  if (/^https?:\/\/i\.imgur\.com\//i.test(MENU_IMAGE_URL)) {
    resolvedMenuImageUrl = MENU_IMAGE_URL;
    return resolvedMenuImageUrl;
  }

  try {
    const response = await fetch(MENU_IMAGE_URL, { headers: { 'user-agent': 'Revin-MD/1.0' } });
    const html = await response.text();
    const match = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    resolvedMenuImageUrl = match?.[1]?.replace(/&amp;/g, '&') || null;
  } catch (error) {
    console.error('[Menu image error]', error.message);
    resolvedMenuImageUrl = null;
  }
  return resolvedMenuImageUrl;
}

function messageText(message) {
  return message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    '';
}

function mediaType(message) {
  if (message?.imageMessage) return 'image';
  if (message?.videoMessage) return 'video';
  if (message?.audioMessage) return 'audio';
  if (message?.documentMessage) return 'document';
  if (message?.stickerMessage) return 'sticker';
  return null;
}

async function sendMessageSafe(sock, jid, content, options) {
  // A long yt-dlp request can overlap a WhatsApp reconnect. Never let a
  // rejected send become an unhandled promise that terminates the bot.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await (latestSocket || sock).sendMessage(jid, content, options);
    } catch (error) {
      console.error(`[${BOT_NAME}] Message send failed (attempt ${attempt + 1}):`, error.message);
      if (attempt < 2) await wait(3000);
    }
  }
  return null;
}

async function downloadSong(query, outPath) {
  // Pass arguments directly to yt-dlp. A shell command breaks when a title
  // contains quotes, &, $, or other shell characters.
  const source = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SONG_TIMEOUT_MS);
  try {
    const options = {
      noPlaylist: true,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: outPath,
      socketTimeout: 20,
      forceIpv4: true,
      retries: 1,
      extractorRetries: 1,
      noPart: true,
      noKeepVideo: true,
    };

    // Use the same current YouTube extractor for URLs and title searches.
    // The restricted Android client often fails specifically on ytsearch.
    options.jsRuntimes = 'deno';
    options.remoteComponents = 'ejs:github';

    await ytDlp(source, options, { signal: controller.signal });
  } catch (error) {
    const details = error.stderr || error.shortMessage || error.message;
    throw new Error(`yt-dlp failed: ${error.name === 'AbortError' ? `timed out after ${Math.round(SONG_TIMEOUT_MS / 1000)} seconds` : details}`);
  } finally {
    clearTimeout(timeout);
  }

  await fsp.access(outPath, fs.constants.R_OK);
  return outPath;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: [BOT_NAME, 'Safari', '1.0.0'],
  });
  latestSocket = sock;

  const messageCache = new Map();
  const cacheLimit = 2000;
  const cacheAge = 24 * 60 * 60 * 1000;
  let antiDeleteDestination = ANTIDELETE_DESTINATION === 'current' ? 'current' : 'owner';

  const rememberMessage = (message) => {
    if (!message?.key?.id || !message.message || message.message.protocolMessage) return;
    messageCache.set(message.key.id, { message, savedAt: Date.now() });
    while (messageCache.size > cacheLimit) messageCache.delete(messageCache.keys().next().value);
  };

  if (ANTIDELETE_ENABLED) {
    setInterval(() => {
      const cutoff = Date.now() - cacheAge;
      for (const [id, entry] of messageCache) {
        if (entry.savedAt < cutoff) messageCache.delete(id);
      }
    }, 10 * 60 * 1000).unref();

    sock.ev.on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        const protocol = update?.message?.protocolMessage;
        const revoked = update?.messageStubType === WAMessageStubType.REVOKE || protocol?.type === 0;
        if (!revoked || !key?.id) continue;

        const cached = messageCache.get(key.id)?.message;
        if (!cached?.message) continue;

        const chat = key.remoteJid;
        const ownerChat = OWNER_NUMBER ? phoneToJid(OWNER_NUMBER) : ownJid(sock);
        const destination = antiDeleteDestination === 'current' ? chat : ownerChat;
        if (!destination) continue;
        const sender = key.participant || key.remoteJid;
        const originalText = messageText(cached.message);
        const senderLabel = sender?.split('@')[0] || 'unknown';
        await sendMessageSafe(sock, destination, {
          text: `🗑️ *Deleted message recovered*\nFrom: @${senderLabel}${destination !== chat ? `\nOriginal chat: ${chat}` : ''}${originalText ? `\n\n${originalText}` : ''}`,
          mentions: sender ? [sender] : [],
        });

        const type = mediaType(cached.message);
        if (type) {
          try {
            const media = await downloadMediaMessage(cached, 'buffer', {}, {
              reuploadRequest: sock.updateMediaMessage,
            });
            const source = cached.message[`${type}Message`];
            const payload = { [type]: media, mimetype: source.mimetype };
            if (source.caption) payload.caption = source.caption;
            if (source.fileName) payload.fileName = source.fileName;
            await sendMessageSafe(sock, destination, payload);
          } catch (error) {
            console.error('[Anti-delete media error]', error.message);
            await sendMessageSafe(sock, destination, { text: '⚠️ The deleted media could not be recovered.' });
          }
        }
        messageCache.delete(key.id);
      }
    });
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`\n🤖 ${BOT_NAME} - Scan QR to connect:\n`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        retryCount++;
        const delay = Math.min(1000 * 2 ** retryCount, 60000);
        console.log(`[${BOT_NAME}] Reconnecting in ${delay / 1000}s... (attempt ${retryCount})`);
        setTimeout(startBot, delay);
      } else {
        console.log(`[${BOT_NAME}] Logged out. Delete the auth folder and restart.`);
      }
    } else if (connection === 'open') {
      retryCount = 0;
      console.log(`[${BOT_NAME}] Connected successfully! ✅`);

      if (STARTUP_NOTIFY) {
        const ownJid = sock.user?.id?.replace(/:\d+(?=@)/, '');
        const startupChat = OWNER_NUMBER ? phoneToJid(OWNER_NUMBER) : ownJid;
        if (startupChat) {
          await sendMessageSafe(sock, startupChat, {
            text: `🚀 *${BOT_NAME} is up!*\n⏱️ Uptime: ${formatUptime(process.uptime())}`,
          });
        }
      }
    }
  });

  // Auto-view status
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      rememberMessage(msg);
      if (msg.key.remoteJid === 'status@broadcast') {
        try {
          await sock.readMessages([msg.key]);
        } catch (error) {
          console.error(`[${BOT_NAME}] Could not mark status as read:`, error.message);
        }
      }
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Messages sent from another linked device are also marked `fromMe`.
      // Keep processing them so commands work in the account's self-chat.
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      const command = body.trim();
      const lowerCommand = command.toLowerCase();

      // .help / .menu
      if (lowerCommand === `${PREFIX}help` || lowerCommand === `${PREFIX}menu`) {
        const menuText =
            `*${BOT_NAME} made by ${OWNER_NAME}*\n` +
            `🤖 Your WhatsApp assistant\n\n` +
            `*Commands:*\n` +
            `> ${PREFIX}song <title or YouTube URL> — Download music\n` +
            `> ${PREFIX}ping — Check bot response\n` +
            `> ${PREFIX}alive — Check bot status\n` +
            `> ${PREFIX}runtime — Show uptime\n` +
            `> ${PREFIX}owner — Show owner\n` +
            `> ${PREFIX}jid — Show chat ID\n` +
            `> ${PREFIX}time — Show server time\n` +
            `> ${PREFIX}groupinfo — Show group details\n` +
            `> ${PREFIX}admins — List group admins\n` +
            `> Deleted messages are automatically recovered when possible.\n\n` +
            `*Group admin commands:*\n` +
            `> ${PREFIX}kick @member — Remove a member\n` +
            `> ${PREFIX}add 2547XXXXXXXX — Add a number\n` +
            `> ${PREFIX}tagall [message] — Mention all members\n` +
            `> ${PREFIX}members — Export members as CSV\n\n` +
            `*Anti-delete:* ${PREFIX}antidelete owner/current/status\n\n` +
            `*Auto Features:*\n` +
            `> 👁️ Auto-view status updates`;
        const menuImageUrl = await getMenuImageUrl();
        await sendMessageSafe(sock, from, menuImageUrl ? {
          image: { url: menuImageUrl },
          caption: menuText,
        } : {
          text: `🖼️ ${MENU_IMAGE_URL}\n\n${menuText}`,
        }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}antidelete` || lowerCommand.startsWith(`${PREFIX}antidelete `)) {
        const ownerChat = OWNER_NUMBER ? phoneToJid(OWNER_NUMBER) : ownJid(sock);
        // WhatsApp may represent the self-chat with a LID instead of the
        // phone-number JID. Messages sent from the linked owner device are
        // marked `fromMe`, so accept those as owner commands too.
        if (!msg.key.fromMe && (!ownerChat || !sameJid(from, ownerChat))) {
          await sendMessageSafe(sock, from, { text: '❌ Only the owner chat can change anti-delete settings.' }, { quoted: msg });
          continue;
        }
        const mode = command.split(/\s+/)[1]?.toLowerCase();
        if (mode === 'owner' || mode === 'current') antiDeleteDestination = mode;
        const label = antiDeleteDestination === 'owner' ? 'your owner chat' : 'the original chat';
        await sendMessageSafe(sock, from, {
          text: `🛡️ Anti-delete recovery is sent to *${label}*.\nUse ${PREFIX}antidelete owner or ${PREFIX}antidelete current to change it.`
        }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}ping`) {
        await sendMessageSafe(sock, from, { text: `🏓 Pong! ${BOT_NAME} is online.` }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}alive` || lowerCommand === `${PREFIX}bot`) {
        await sendMessageSafe(sock, from, {
          text: `✅ *${BOT_NAME} is online*\n⏱️ Uptime: ${formatUptime(process.uptime())}`
        }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}runtime` || lowerCommand === `${PREFIX}uptime`) {
        await sendMessageSafe(sock, from, { text: `⏱️ Runtime: ${formatUptime(process.uptime())}` }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}owner`) {
        const number = OWNER_NUMBER ? `\n📞 +${OWNER_NUMBER.replace(/^\+/, '')}` : '';
        await sendMessageSafe(sock, from, { text: `👤 Owner: ${OWNER_NAME}${number}` }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}jid` || lowerCommand === `${PREFIX}id`) {
        await sendMessageSafe(sock, from, { text: `🆔 Chat ID:\n${from}` }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}time`) {
        await sendMessageSafe(sock, from, {
          text: `🕒 ${new Date().toLocaleString('en-KE', { timeZone: process.env.TIMEZONE || 'Africa/Nairobi' })}`
        }, { quoted: msg });
        continue;
      }

      if (lowerCommand === `${PREFIX}groupinfo` || lowerCommand === `${PREFIX}admins`) {
        if (!from.endsWith('@g.us')) {
          await sendMessageSafe(sock, from, { text: '❌ This command only works in groups.' }, { quoted: msg });
          continue;
        }

        try {
          const metadata = await sock.groupMetadata(from);
          const admins = metadata.participants.filter((participant) => participant.admin);
          if (lowerCommand === `${PREFIX}admins`) {
            const list = admins.map((participant) => `@${participant.id.split('@')[0]}`).join('\n');
            await sendMessageSafe(sock, from, {
              text: `👮 *Group admins*\n${list || 'No admins found.'}`,
              mentions: admins.map((participant) => participant.id),
            }, { quoted: msg });
          } else {
            await sendMessageSafe(sock, from, {
              text: `👥 *${metadata.subject}*\nMembers: ${metadata.participants.length}\nAdmins: ${admins.length}`
            }, { quoted: msg });
          }
        } catch (error) {
          console.error('[Group command error]', error.message);
          await sendMessageSafe(sock, from, { text: '❌ Could not read group information.' }, { quoted: msg });
        }
        continue;
      }

      if ([`${PREFIX}kick`, `${PREFIX}add`, `${PREFIX}tagall`, `${PREFIX}members`].some((name) => lowerCommand === name || lowerCommand.startsWith(`${name} `))) {
        if (!from.endsWith('@g.us')) {
          await sendMessageSafe(sock, from, { text: '❌ This command only works in groups.' }, { quoted: msg });
          continue;
        }

        try {
          const metadata = await sock.groupMetadata(from);
          const sender = msg.key.participant || msg.key.remoteJid;
          const senderInfo = metadata.participants.find((participant) => sameJid(participant.id, sender));
          const botInfo = metadata.participants.find((participant) => sameJid(participant.id, sock.user?.id));

          if (!isAdmin(senderInfo)) {
            await sendMessageSafe(sock, from, { text: '❌ Only group admins can use this command.' }, { quoted: msg });
            continue;
          }
          if (!isAdmin(botInfo)) {
            await sendMessageSafe(sock, from, { text: '❌ Promote me to a group admin first.' }, { quoted: msg });
            continue;
          }

          const context = msg.message?.extendedTextMessage?.contextInfo;
          const mentioned = context?.mentionedJid || [];
          const argument = command.split(/\s+/).slice(1).join(' ').trim();

          if (lowerCommand === `${PREFIX}members`) {
            const rows = ['number,admin'];
            for (const participant of metadata.participants) {
              const number = (participant.jid || participant.id).split('@')[0];
              rows.push(`${csvValue(number)},${csvValue(participant.admin || 'member')}`);
            }
            await sendMessageSafe(sock, from, {
              document: Buffer.from(`${rows.join('\n')}\n`, 'utf8'),
              fileName: `${metadata.subject.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-members.csv`,
              mimetype: 'text/csv',
              caption: `📄 ${metadata.subject} member list (${metadata.participants.length} members)`,
            }, { quoted: msg });
            continue;
          }

          if (lowerCommand.startsWith(`${PREFIX}tagall`)) {
            const text = argument || 'Attention everyone';
            const tags = metadata.participants.map((participant) => `@${participant.id.split('@')[0]}`);
            await sendMessageSafe(sock, from, {
              text: `📢 *${text}*\n\n${tags.join(' ')}`,
              mentions: metadata.participants.map((participant) => participant.id),
            }, { quoted: msg });
            continue;
          }

          let targets = mentioned.slice();
          const quotedParticipant = context?.participant;
          if (!targets.length && quotedParticipant) targets.push(quotedParticipant);
          if (!targets.length && argument) {
            targets = argument.split(/[\s,]+/).map(phoneToJid).filter(Boolean);
          }
          targets = [...new Map(targets.map((target) => [target, target])).values()];

          if (!targets.length) {
            await sendMessageSafe(sock, from, { text: `❌ Mention or reply to a member, or provide an international phone number.\nExample: ${PREFIX}add 2547XXXXXXXX` }, { quoted: msg });
            continue;
          }

          const action = lowerCommand.startsWith(`${PREFIX}kick`) ? 'remove' : 'add';
          const result = await sock.groupParticipantsUpdate(from, targets, action);
          const failed = Array.isArray(result)
            ? result.filter((entry) => entry.status && entry.status !== '200')
            : [];
          await sendMessageSafe(sock, from, {
            text: failed.length
              ? `⚠️ ${action === 'add' ? 'Add' : 'Removal'} partially failed. Check that the numbers use country codes.`
              : `✅ ${action === 'add' ? 'Added' : 'Removed'} ${targets.length} member(s).`,
          }, { quoted: msg });
        } catch (error) {
          console.error('[Group admin command error]', error.stack || error.message);
          await sendMessageSafe(sock, from, { text: `❌ Group action failed: ${String(error.message).slice(0, 300)}` }, { quoted: msg });
        }
        continue;
      }

      // .song
      if (lowerCommand.startsWith(`${PREFIX}song `)) {
        const query = command.slice(`${PREFIX}song `.length).trim();
        if (!query) {
          await sendMessageSafe(sock, from, {
            text: `❌ Please provide a song name.\nExample: *${PREFIX}song Mockingbird by Eminem*`
          }, { quoted: msg });
          continue;
        }

        await sendMessageSafe(sock, from, { text: `🎵 *${BOT_NAME}*\nSearching: *${query}*...` });

        const outPath = path.join(os.tmpdir(), `revin-song-${Date.now()}-${process.pid}.mp3`);
        const progressTimer = setTimeout(() => {
          sendMessageSafe(sock, from, {
            text: `⏳ Still downloading *${query}*... this may take a few seconds.`
          }).catch(() => {});
        }, 10000);

        try {
          await downloadSong(query, outPath);

          if (!fs.existsSync(outPath)) {
            throw new Error('File not found after download');
          }

          await sendMessageSafe(sock, from, {
            audio: fs.readFileSync(outPath),
            mimetype: 'audio/mpeg',
            ptt: false,
          }, { quoted: msg });
        } catch (e) {
          console.error('[Song error]', e.stack || e.message);
          const reason = String(e.message || 'unknown downloader error')
            .replace(/\s+/g, ' ')
            .slice(0, 500);
          await sendMessageSafe(sock, from, {
            text: `❌ *${BOT_NAME}:* Download failed for *${query}*.\n\n_${reason}_`
          }, { quoted: msg });
        } finally {
          clearTimeout(progressTimer);
          // Always remove temporary audio, including when WhatsApp rejects it.
          await fsp.rm(outPath, { force: true }).catch(() => {});
        }
      }
    }
  });
}

startBot();
