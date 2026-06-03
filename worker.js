import { Telegraf, Markup } from 'telegraf';

const CONFIG = {
  KV_STATE: 'state_',
  KV_HISTORY: 'history_',
  KV_TARGET: 'target_',
  KV_MSG_TRACK: 'msg_track_', 
  KV_LAST_MSG: 'last_msg_',   
  EXPIRATION_TTL: 7 * 24 * 60 * 60,
};

const MAIN_MENU = Markup.keyboard([
  ['🤖 AI Mode', '📞 Contact Mode'],
  ['🔄 Reset Bot', 'ℹ️ About']
]).resize();

function getDisplayName(from) {
  if (!from) return 'Unknown User';
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || 'User';
}

async function trackMessages(env, chatId, newIds) {
  try {
    const key = `${CONFIG.KV_MSG_TRACK}${chatId}`;
    let listStr = await env.CONTACT_KV.get(key);
    let list = listStr ? JSON.parse(listStr) : [];
    list.push(...newIds);
    if (list.length > 100) list = list.slice(-100);
    await env.CONTACT_KV.put(key, JSON.stringify(list), { expirationTtl: CONFIG.EXPIRATION_TTL });
  } catch (e) {}
}

async function getGeminiResponse(env, chatId, userText, isOwner, userName) {
  if (!env.GEMINI_API_KEY) return "⚠️ API Key not found.";

  const apiKey = String(env.GEMINI_API_KEY).trim();
  
  // এখানে ১৫০০ ফ্রি লিমিট যুক্ত স্ট্যাবল মডেল (gemini-1.5-flash) সেট করা হলো
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const systemPrompt = `You are a highly intelligent and organized AI assistant.
  Profile: ${isOwner ? 'You are talking DIRECTLY to your Owner, Yasin Adnan.' : `You are talking to a User named ${userName}. You are the official assistant of Yasin Adnan.`}
  
  CRITICAL RULES:
  1. DO NOT use any greetings (Do not say Hello, Hi, Assalamualaikum, etc.). Start answering directly to save time.
  2. Answer in Bengali, but always keep the names "Yasin Adnan", "Owner", and "User" in English.
  3. Organize your answers beautifully with short paragraphs or bullet points if needed.
  4. If there is any important text, command, or code, ALWAYS put it inside backticks (\`text\`) so it becomes 1-click copyable.`;

  let history = [];
  try {
    const histStr = await env.CONTACT_KV.get(`${CONFIG.KV_HISTORY}${chatId}`);
    if (histStr) history = JSON.parse(histStr);
  } catch (e) {}

  history.push({ role: "user", parts: [{ text: userText }] });

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: history,
        generationConfig: { temperature: 0.7 }
      })
    });

    if (!response.ok) {
        const errText = await response.text();
        try {
            const errJson = JSON.parse(errText);
            return `⚠️ **Google AI Error:** ${errJson.error.message}`;
        } catch(e) {
            return `⚠️ **AI Error:** ${errText}`;
        }
    }

    const data = await response.json();
    const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ বুঝতে পারিনি।";

    history.push({ role: "model", parts: [{ text: aiReply }] });
    if (history.length > 20) history = history.slice(-20);
    await env.CONTACT_KV.put(`${CONFIG.KV_HISTORY}${chatId}`, JSON.stringify(history), { expirationTtl: CONFIG.EXPIRATION_TTL });

    return aiReply;
  } catch (error) {
    return `⚠️ System Error: ${error.message}`;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('🤖 Yasin AI Bot is Running!', { status: 200 });

    try {
      const botToken = String(env.BOT_TOKEN).trim();
      const bot = new Telegraf(botToken);
      const OWNER_ID = String(env.OWNER_ID).trim();

      bot.on('message', async (ctxBot) => {
        const msg = ctxBot.message;
        const chat = msg.chat;
        const from = msg.from;

        if (chat.type !== 'private') return;

        const chatId = String(chat.id);
        const text = msg.text || '';
        const isOwner = (chatId === OWNER_ID);
        const hasMedia = !!(msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.sticker || msg.animation);
        const displayName = getDisplayName(from);

        // ==========================================
        // ১. Owner Reply Logic
        // ==========================================
        if (isOwner && msg.reply_to_message) {
          const repliedId = msg.reply_to_message.message_id;
          const targetUserId = await env.CONTACT_KV.get(`${CONFIG.KV_TARGET}${repliedId}`);

          if (!targetUserId) return ctxBot.reply('⚠️ User data not found.', MAIN_MENU);

          try {
            await ctxBot.telegram.copyMessage(targetUserId, chatId, msg.message_id);
            const sent = await ctxBot.reply('✅ Reply sent to User successfully.', MAIN_MENU);
            await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
            return;
          } catch (err) {
            const sent = await ctxBot.reply('❌ Could not send message. User might have blocked the bot.', MAIN_MENU);
            await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
            return;
          }
        }

        // ==========================================
        // ২. Powerful Reset (Clear Screen)
        // ==========================================
        if (text === '🔄 Reset Bot') {
          await ctxBot.sendChatAction('typing');
          
          const trackKey = `${CONFIG.KV_MSG_TRACK}${chatId}`;
          let msgIds = [];
          try {
            const listStr = await env.CONTACT_KV.get(trackKey);
            if (listStr) msgIds = JSON.parse(listStr);
          } catch (e) {}

          msgIds.push(msg.message_id);
          for (const id of msgIds) {
            try { await ctxBot.telegram.deleteMessage(chatId, id); } catch (e) {}
          }

          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_LAST_MSG}${chatId}`);
          await env.CONTACT_KV.delete(trackKey);

          const welcomeMsg = isOwner
            ? `Hello **Owner** (Yasin Adnan)! 👋\n\nScreen cleared. Your Owner panel is fully active.`
            : `Hello **User** (${displayName})! 👋\n\nScreen cleared. I am the official bot of Yasin Adnan.\nPlease select a mode below:`;

          const sent = await ctxBot.reply(welcomeMsg, { parse_mode: 'HTML', ...MAIN_MENU });
          await trackMessages(env, chatId, [sent.message_id]);
          return;
        }

        // ==========================================
        // ৩. Commands
        // ==========================================
        if (text === '/start') {
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          
          const welcomeMsg = isOwner
            ? `Hello **Owner** (Yasin Adnan)! 👋\n\nYour Owner panel is active.`
            : `Hello **User** (${displayName})! 👋\n\nI am the official bot of Yasin Adnan.\nPlease select a mode below:`;

          const sent = await ctxBot.reply(welcomeMsg, { parse_mode: 'HTML', ...MAIN_MENU });
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        if (text === 'ℹ️ About') {
          const sent = await ctxBot.reply('🤖 This is the personal AI & Contact Bot of Yasin Adnan.', MAIN_MENU);
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        if (text === '🤖 AI Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'ai');
          const sent = await ctxBot.reply('🤖 **AI Mode Active!**\nAsk me anything you want.', { parse_mode: 'Markdown', ...MAIN_MENU });
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        if (text === '📞 Contact Mode') {
          if (isOwner) {
            const sent = await ctxBot.reply('💡 You are the Owner! No need to forward messages. You can use AI directly.', MAIN_MENU);
            await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
            return;
          }
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'contact');
          const sent = await ctxBot.reply('📞 **Contact Mode Active!**\n\nWhatever you send here will be directly forwarded to Yasin Adnan.', { parse_mode: 'Markdown', ...MAIN_MENU });
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        // ==========================================
        // ৪. Message Processing
        // ==========================================
        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';
        await ctxBot.sendChatAction('typing');

        // --- AI Mode ---
        if (currentMode === 'ai' || isOwner) {
          if (hasMedia && !text) {
             const sent = await ctxBot.reply('আমি শুধু টেক্সট পড়তে পারি। ছবি বা ফাইল পাঠাতে "📞 Contact Mode" ব্যবহার করুন।', MAIN_MENU);
             await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
             return;
          }

          const aiResponse = await getGeminiResponse(env, chatId, text || "(Media with text)", isOwner, displayName);
          let sentBotMsg;
          try {
            sentBotMsg = await ctxBot.reply(aiResponse, { parse_mode: 'Markdown', ...MAIN_MENU });
          } catch (e) {
            sentBotMsg = await ctxBot.reply(aiResponse, MAIN_MENU);
          }
          await trackMessages(env, chatId, [msg.message_id, sentBotMsg.message_id]);
          return;
        }

        // --- Contact Mode (For Users) ---
        if (currentMode === 'contact') {
          const lastMsgStr = await env.CONTACT_KV.get(`${CONFIG.KV_LAST_MSG}${chatId}`);
          if (lastMsgStr) {
            try {
              const lastMsg = JSON.parse(lastMsgStr);
              await ctxBot.telegram.deleteMessage(chatId, lastMsg.userMsgId).catch(() => {});
              await ctxBot.telegram.deleteMessage(chatId, lastMsg.botReplyId).catch(() => {});
            } catch (err) {}
          }

          const ownerAlertText = `📩 <b>Message from User:</b> ${displayName}`;
          const alertMsg = await ctxBot.telegram.sendMessage(OWNER_ID, ownerAlertText, { parse_mode: 'HTML' });
          const fwdMsg = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msg.message_id);

          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${fwdMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });
          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${alertMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });

          const botReply = await ctxBot.reply('✅ Message sent to Yasin Adnan successfully.', MAIN_MENU);
          
          await env.CONTACT_KV.put(`${CONFIG.KV_LAST_MSG}${chatId}`, JSON.stringify({
            userMsgId: msg.message_id,
            botReplyId: botReply.message_id
          }));
          
          await trackMessages(env, chatId, [msg.message_id, botReply.message_id]);
        }
      });

      const update = await request.json();
      await bot.handleUpdate(update);
      return new Response('OK', { status: 200 });
    } catch (error) {
      return new Response('Error', { status: 500 });
    }
  }
};
