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
  if (!from) return 'Guest';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || from.username || 'Guest';
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
  const currentTime = new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka', dateStyle: 'full', timeStyle: 'short' });

  // লাইভ সার্চ এবং বর্তমান সময়ের জন্য কড়া প্রম্পট
  const systemPrompt = `You are a highly intelligent AI assistant connected to the live internet.
  
  CRITICAL RULE: Today is ${currentTime}. The current year is 2026. You MUST provide the absolute latest and most up-to-date information using your Google Search tool whenever asked about current events.
  
  Profile: ${isOwner ? 'You are talking DIRECTLY to your Owner, Yasin Adnan.' : `You are talking to a User named ${userName}. You are the official assistant of Yasin Adnan.`}
  
  RULES:
  1. DO NOT use repetitive greetings (Do not say Assalamualaikum, Hello, etc. in every message). Start answering directly.
  2. Answer perfectly in Bengali, but keep names like "Yasin Adnan", "Owner", and "User" in English.
  3. Organize answers beautifully.
  4. Use backticks (\`text\`) for important copyable items.`;

  let history = [];
  try {
    const histStr = await env.CONTACT_KV.get(`${CONFIG.KV_HISTORY}${chatId}`);
    if (histStr) history = JSON.parse(histStr);
  } catch (e) {}

  history.push({ role: "user", parts: [{ text: userText }] });

  // লাইভ ইন্টারনেট সার্চ (Google Search Grounding) এনাবল করা হলো
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: history,
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.7 }
  });

  // আপনার API Key এর লিস্ট অনুযায়ী অটো-পাইলট মডেল
  const modelsToTry = [
    'gemini-flash-latest',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash'
  ];

  let lastError = "";

  for (const model of modelsToTry) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      if (response.ok) {
        const data = await response.json();
        const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (aiReply) {
          history.push({ role: "model", parts: [{ text: aiReply }] });
          if (history.length > 20) history = history.slice(-20);
          await env.CONTACT_KV.put(`${CONFIG.KV_HISTORY}${chatId}`, JSON.stringify(history), { expirationTtl: CONFIG.EXPIRATION_TTL });
          return aiReply;
        }
      } else {
        const errText = await response.text();
        lastError = errText;
        continue; // কাজ না করলে পরের ফ্রি মডেলে জাম্প করবে
      }
    } catch (error) {
      lastError = error.message;
      continue;
    }
  }

  return `⚠️ **Google AI Error (All models failed):**\n\n${lastError}`;
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
            : `Hello **${displayName}**! 👋\n\nScreen cleared. I am the official bot of Yasin Adnan.\nPlease select a mode below:`;

          const sent = await ctxBot.reply(welcomeMsg, { parse_mode: 'HTML', ...MAIN_MENU });
          await trackMessages(env, chatId, [sent.message_id]);
          return;
        }

        if (text === '/start') {
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          
          const welcomeMsg = isOwner
            ? `Hello **Owner** (Yasin Adnan)! 👋\n\nYour Owner panel is active.`
            : `Hello **${displayName}**! 👋\n\nI am the official bot of Yasin Adnan.\nPlease select a mode below:`;

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

        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';
        await ctxBot.sendChatAction('typing');

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
      console.error(error);
      return new Response('Error', { status: 500 });
    }
  }
};
