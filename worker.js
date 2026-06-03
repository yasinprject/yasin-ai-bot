import { Telegraf, Markup } from 'telegraf';

const CONFIG = {
  KV_STATE: 'state_',
  KV_HISTORY: 'history_',
  KV_TARGET: 'target_',
  KV_MSG_TRACK: 'msg_track_', 
  KV_LAST_MSG: 'last_msg_',   
  KV_OWNER_TARGET: 'owner_target_', // ওনারের ফরোয়ার্ডের জন্য
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

// স্ক্রিন ক্লিয়ার করার জন্য মেসেজ ট্র্যাকার
async function trackMessages(env, chatId, newIds) {
  try {
    const key = `${CONFIG.KV_MSG_TRACK}${chatId}`;
    let listStr = await env.CONTACT_KV.get(key);
    let list = listStr ? JSON.parse(listStr) : [];
    list.push(...newIds);
    list = [...new Set(list)];
    if (list.length > 500) list = list.slice(-500); 
    await env.CONTACT_KV.put(key, JSON.stringify(list), { expirationTtl: CONFIG.EXPIRATION_TTL });
  } catch (e) {}
}

// ==========================================
// Gemini AI (স্ট্যাবল মডেল + স্মার্ট প্রম্পট)
// ==========================================
async function getGeminiResponse(env, chatId, userText, isOwner, userName) {
  if (!env.GEMINI_API_KEY) return "⚠️ API Key not found.";

  const apiKey = String(env.GEMINI_API_KEY).trim();
  // একদম স্ট্যাবল এবং ফ্রি মডেল
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const currentTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', dateStyle: 'full', timeStyle: 'medium' });

  // বর্তমান পরিস্থিতি ও কড়া নির্দেশ
  const systemPrompt = `You are a highly intelligent and organized AI assistant.
  
  CRITICAL KNOWLEDGE: Today is ${currentTime}. The year is 2026. DO NOT announce the date or time unless asked. In Bangladesh politics: Sheikh Hasina resigned on Aug 5, 2024. Currently, the Interim Government is led by Chief Adviser Dr. Muhammad Yunus. Remember this.
  
  Profile: ${isOwner ? 'You are talking DIRECTLY to your Owner, Yasin Adnan.' : `You are talking to a User named ${userName}. You are the official assistant of Yasin Adnan.`}
  
  RULES:
  1. DO NOT use repetitive greetings (Do not say Assalamualaikum, Hello, Hi, etc. in every message). Start answering directly to save time.
  2. Answer perfectly in Bengali, but ALWAYS keep the specific names "Yasin Adnan", "Owner", and "User" in English.
  3. Organize your answers beautifully with short paragraphs or bullet points.
  4. If there is any important text, command, link, or code, ALWAYS put it inside backticks (\`text\`) so it becomes 1-click copyable.`;

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
        const msgId = msg.message_id;
        const text = msg.text || '';
        const isOwner = (chatId === OWNER_ID);
        const hasMedia = !!(msg.photo || msg.video || msg.document || msg.audio || msg.voice || msg.sticker || msg.animation);
        const displayName = getDisplayName(from);

        await trackMessages(env, chatId, [msgId]);

        // ==========================================
        // ১. Owner Forward & Reply Logic
        // ==========================================
        if (isOwner) {
          let targetUserId = null;
          const isReply = !!msg.reply_to_message;
          const isForward = !!(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat);

          if (isReply) {
            const repliedId = msg.reply_to_message.message_id;
            targetUserId = await env.CONTACT_KV.get(`${CONFIG.KV_TARGET}${repliedId}`);
            if (targetUserId) {
              await env.CONTACT_KV.put(CONFIG.KV_OWNER_TARGET, targetUserId, { expirationTtl: CONFIG.EXPIRATION_TTL });
            }
          } else if (isForward) {
            targetUserId = await env.CONTACT_KV.get(CONFIG.KV_OWNER_TARGET);
          }

          if (isReply || isForward) {
            if (!targetUserId) {
              const warn = await ctxBot.reply('⚠️ ফরোয়ার্ড করার আগে ইউজারের কোনো মেসেজে একবার Reply করে টার্গেট সেট করুন।', MAIN_MENU);
              await trackMessages(env, chatId, [warn.message_id]);
              return;
            }
            try {
              await ctxBot.telegram.copyMessage(targetUserId, chatId, msgId);
              const sent = await ctxBot.reply('✅ মেসেজটি ইউজারের কাছে পাঠানো হয়েছে।', MAIN_MENU);
              await trackMessages(env, chatId, [sent.message_id]);
              return;
            } catch (err) {
              const fail = await ctxBot.reply('❌ মেসেজ পাঠানো যায়নি। সম্ভবত User বটটি ব্লক করেছেন।', MAIN_MENU);
              await trackMessages(env, chatId, [fail.message_id]);
              return;
            }
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
          
          // Bulk Delete
          if (msgIds.length > 0) {
            for (let i = 0; i < msgIds.length; i += 100) {
              const chunk = msgIds.slice(i, i + 100);
              try {
                await ctxBot.telegram.deleteMessages(chatId, chunk);
              } catch (e) {
                for (const id of chunk) {
                  try { await ctxBot.telegram.deleteMessage(chatId, id); } catch (err) {}
                }
              }
            }
          }

          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_LAST_MSG}${chatId}`);
          await env.CONTACT_KV.delete(trackKey);

          const welcomeMsg = isOwner
            ? `Hello **Owner** (Yasin Adnan)! 👋\n\nScreen completely cleared. Your Owner panel is active.`
            : `Hello **User** (${displayName})! 👋\n\nScreen completely cleared. I am the official bot of Yasin Adnan.\nPlease select a mode below:`;

          const sent = await ctxBot.reply(welcomeMsg, { parse_mode: 'Markdown', ...MAIN_MENU });
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

          const sent = await ctxBot.reply(welcomeMsg, { parse_mode: 'Markdown', ...MAIN_MENU });
          await trackMessages(env, chatId, [sent.message_id]);
          return;
        }

        if (text === 'ℹ️ About') {
          const sent = await ctxBot.reply('🤖 This is the personal AI & Contact Bot of Yasin Adnan.', MAIN_MENU);
          await trackMessages(env, chatId, [sent.message_id]);
          return;
        }

        if (text === '🤖 AI Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'ai');
          const sent = await ctxBot.reply('🤖 **AI Mode Active!**\nAsk me anything you want.', { parse_mode: 'Markdown', ...MAIN_MENU });
          await trackMessages(env, chatId, [sent.message_id]);
          return;
        }

        if (text === '📞 Contact Mode') {
          if (isOwner) {
            const sent = await ctxBot.reply('💡 You are the Owner! No need to forward messages. You can use AI directly.', MAIN_MENU);
            await trackMessages(env, chatId, [sent.message_id]);
            return;
          }
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'contact');
          const sent = await ctxBot.reply('📞 **Contact Mode Active!**\n\nWhatever you send here will be directly forwarded to Yasin Adnan.', { parse_mode: 'Markdown', ...MAIN_MENU });
          await trackMessages(env, chatId, [sent.message_id]);
          return;
        }

        // ==========================================
        // ৪. Message Processing
        // ==========================================
        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';
        await ctxBot.sendChatAction('typing');

        if (currentMode === 'ai' || isOwner) {
          if (hasMedia && !text) {
             const sent = await ctxBot.reply('আমি শুধু টেক্সট পড়তে পারি। ছবি বা ফাইল পাঠাতে "📞 Contact Mode" ব্যবহার করুন।', MAIN_MENU);
             await trackMessages(env, chatId, [sent.message_id]);
             return;
          }

          const aiResponse = await getGeminiResponse(env, chatId, text || "(Media with text)", isOwner, displayName);
          let sentBotMsg;
          try {
            sentBotMsg = await ctxBot.reply(aiResponse, { parse_mode: 'Markdown', ...MAIN_MENU });
          } catch (e) {
            sentBotMsg = await ctxBot.reply(aiResponse, MAIN_MENU);
          }
          await trackMessages(env, chatId, [sentBotMsg.message_id]);
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
          const fwdMsg = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msgId);

          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${fwdMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });
          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${alertMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });

          const botReply = await ctxBot.reply('✅ Message sent to Yasin Adnan successfully.', MAIN_MENU);
          
          await env.CONTACT_KV.put(`${CONFIG.KV_LAST_MSG}${chatId}`, JSON.stringify({
            userMsgId: msgId,
            botReplyId: botReply.message_id
          }));
          
          await trackMessages(env, chatId, [botReply.message_id]);
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
