import { Telegraf, Markup } from 'telegraf';

const CONFIG = {
  KV_STATE: 'state_',
  KV_HISTORY: 'history_',
  KV_TARGET: 'target_',
  KV_MSG_TRACK: 'msg_track_', // স্ক্রিন ক্লিয়ার করার জন্য মেসেজ আইডি ধরে রাখা
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

// ==========================================
// স্ক্রিন ক্লিয়ার করার জন্য মেসেজ ট্র্যাকার
// ==========================================
async function trackMessages(env, chatId, newIds) {
  try {
    const key = `${CONFIG.KV_MSG_TRACK}${chatId}`;
    let listStr = await env.CONTACT_KV.get(key);
    let list = listStr ? JSON.parse(listStr) : [];
    list.push(...newIds);
    // লিমিট ঠিক রাখতে শেষের ১০০টি মেসেজ ট্র্যাক করবো
    if (list.length > 100) list = list.slice(-100);
    await env.CONTACT_KV.put(key, JSON.stringify(list), { expirationTtl: CONFIG.EXPIRATION_TTL });
  } catch (e) {}
}

async function getGeminiResponse(env, chatId, userText, isOwner, userName) {
  if (!env.GEMINI_API_KEY) return "⚠️ API Key পাওয়া যায়নি।";

  const apiKey = String(env.GEMINI_API_KEY).trim();
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  // বর্তমান সময় বের করা (বাংলাদেশ সময়)
  const currentTime = new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' });

  // অ্যাডভান্সড সিস্টেম প্রম্পট (১-ক্লিক কপি ও ডিজাইনের জন্য কড়া নির্দেশ)
  const systemPrompt = `You are a highly intelligent and polite virtual assistant. Current Date and Time in Bangladesh is: ${currentTime}.
  
  User Profile: ${isOwner ? 'You are talking DIRECTLY to your creator and owner, Yasin Adnan. Address him as "ইয়াসিন ভাই".' : `You are talking to a guest user named ${userName}.`}
  
  CRITICAL FORMATTING RULES:
  1. Organize your answers beautifully with emojis, short paragraphs, and bullet points.
  2. DO NOT use repetitive greetings (like "হ্যালো" or "আসসালামু আলাইকুম") in every response. Jump straight to the point.
  3. 1-CLICK COPY FEATURE: If there is any code, command, important name, specific text, or data the user might want to copy, ALWAYS put it inside single backticks (\`text\`) or triple backticks (\`\`\`text\`\`\`) so it becomes 1-click copyable in Telegram.
  4. Answer perfectly in Bengali.`;

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

    if (!response.ok) return `⚠️ **Google AI Error:** ${await response.text()}`;

    const data = await response.json();
    const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ আমি বুঝতে পারিনি।";

    history.push({ role: "model", parts: [{ text: aiReply }] });
    if (history.length > 20) history = history.slice(-20); // এআই এর মেমরি
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
        const hasMedia = !!(msg.photo || msg.video || msg.document || msg.audio || msg.voice);
        const displayName = getDisplayName(from);

        // ==========================================
        // ১. ওনারের রিপ্লাই (Contact Mode)
        // ==========================================
        if (isOwner && msg.reply_to_message) {
          const repliedId = msg.reply_to_message.message_id;
          const targetUserId = await env.CONTACT_KV.get(`${CONFIG.KV_TARGET}${repliedId}`);

          if (!targetUserId) return ctxBot.reply('⚠️ ইউজারের ডেটা পাওয়া যায়নি বা মেসেজটি অনেক পুরোনো।');

          try {
            await ctxBot.telegram.copyMessage(targetUserId, chatId, msg.message_id);
            return ctxBot.reply('✅ আপনার রিপ্লাই ইউজারের কাছে সফলভাবে পৌঁছেছে।');
          } catch (err) {
            return ctxBot.reply('❌ মেসেজ পাঠানো যায়নি। সম্ভবত ইউজার বটটি ব্লক করেছেন।');
          }
        }

        // ==========================================
        // ২. রিয়েল রিসেট (Clear Entire Screen)
        // ==========================================
        if (text === '🔄 Reset Bot') {
          await ctxBot.sendChatAction('typing');
          
          // আগের ট্র্যাক করা সব মেসেজ ডিলিট করে স্ক্রিন ফাঁকা করা
          const trackKey = `${CONFIG.KV_MSG_TRACK}${chatId}`;
          let msgIds = [];
          try {
            const listStr = await env.CONTACT_KV.get(trackKey);
            if (listStr) msgIds = JSON.parse(listStr);
          } catch (e) {}

          // ইউজারের দেওয়া রিসেট কমান্ডটিও ডিলিট করা
          msgIds.push(msg.message_id);

          for (const id of msgIds) {
            try { await ctxBot.telegram.deleteMessage(chatId, id); } catch (e) {}
          }

          // বটের সব ডাটাবেস মেমরি মুছে ফেলা
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          await env.CONTACT_KV.delete(trackKey);

          // মেনু সরিয়ে দেওয়া এবং নতুন করে স্টার্ট করতে বলা
          await ctxBot.reply(
            '✨ <b>চ্যাট স্ক্রিন সম্পূর্ণ পরিষ্কার করা হয়েছে!</b>\n\nনতুন করে শুরু করতে নিচের /start কমান্ডটিতে ক্লিক করুন।', 
            { parse_mode: 'HTML', ...Markup.removeKeyboard() }
          );
          return;
        }

        // ==========================================
        // ৩. অন্যান্য কমান্ডস
        // ==========================================
        if (text === '/start') {
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          
          const welcomeMsg = isOwner
            ? `আসসালামু আলাইকুম <b>ইয়াসিন ভাই</b>! 👋\n\nআপনার ওনার প্যানেল অ্যাক্টিভ। আপনি সরাসরি AI এর সাথে কথা বলতে পারেন অথবা ইউজারদের মেসেজে Reply দিতে পারেন।`
            : `আসসালামু আলাইকুম <b>${displayName}</b>! 👋\n\nআমি ইয়াসিন আদনানের অফিশিয়াল বট।\nঅনুগ্রহ করে নিচের মেনু থেকে মোড নির্বাচন করুন:`;

          const sent = await ctxBot.reply(welcomeMsg, { parse_mode: 'HTML', ...MAIN_MENU });
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        if (text === 'ℹ️ About') {
          const sent = await ctxBot.reply('🤖 এটি ইয়াসিন আদনানের পার্সোনাল AI এবং কন্টাক্ট বট।', MAIN_MENU);
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        if (text === '🤖 AI Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'ai');
          const sent = await ctxBot.reply('🤖 <b>AI Mode Active!</b>\nআমি প্রস্তুত, আমাকে নির্দ্বিধায় যেকোনো প্রশ্ন করতে পারেন।', { parse_mode: 'HTML', ...MAIN_MENU });
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        if (text === '📞 Contact Mode') {
          if (isOwner) {
            const sent = await ctxBot.reply('💡 ইয়াসিন ভাই, আপনি নিজেই ওনার! আপনার মেসেজ ফরওয়ার্ড করার প্রয়োজন নেই।', MAIN_MENU);
            await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
            return;
          }
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'contact');
          const sent = await ctxBot.reply('📞 <b>Contact Mode Active!</b>\n\nএখানে আপনি যা লিখবেন তা সরাসরি ইয়াসিন ভাইয়ের কাছে চলে যাবে। (চ্যাট পরিষ্কার রাখতে আগের মেসেজগুলো মুছে যাবে)।', { parse_mode: 'HTML', ...MAIN_MENU });
          await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
          return;
        }

        // ==========================================
        // ৪. মেসেজ প্রসেসিং (AI বা Contact)
        // ==========================================
        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';
        await ctxBot.sendChatAction('typing');

        // --- AI মোড ---
        if (currentMode === 'ai' || isOwner) {
          if (hasMedia) {
            const sent = await ctxBot.reply('আমি বর্তমানে শুধু টেক্সট পড়তে পারি। ছবি বা ফাইল পাঠাতে চাইলে "📞 Contact Mode" ব্যবহার করুন।');
            await trackMessages(env, chatId, [msg.message_id, sent.message_id]);
            return;
          }

          const aiResponse = await getGeminiResponse(env, chatId, text, isOwner, displayName);
          let sentBotMsg;
          
          try {
            // সুন্দর ডিজাইনের জন্য Markdown মোডে মেসেজ পাঠানো (১-ক্লিক কপি সহ)
            sentBotMsg = await ctxBot.reply(aiResponse, { parse_mode: 'Markdown' });
          } catch (e) {
            // যদি ডিজাইনে কোনো এরর হয়, তবে নরমাল টেক্সটে পাঠাবে
            sentBotMsg = await ctxBot.reply(aiResponse);
          }
          
          await trackMessages(env, chatId, [msg.message_id, sentBotMsg.message_id]);
          return;
        }

        // --- Contact মোড (অটো ডিলিট ফিচার সহ) ---
        if (currentMode === 'contact') {
          // কন্টাক্ট মোডে ইউজার নতুন মেসেজ দিলে তার আগের মেসেজগুলো ডিলিট হয়ে যাবে
          const trackKey = `${CONFIG.KV_MSG_TRACK}${chatId}`;
          let msgIds = [];
          try {
            const listStr = await env.CONTACT_KV.get(trackKey);
            if (listStr) msgIds = JSON.parse(listStr);
          } catch (e) {}

          for (const id of msgIds) {
            try { await ctxBot.telegram.deleteMessage(chatId, id); } catch (e) {}
          }
          await env.CONTACT_KV.delete(trackKey); // ক্লিয়ার করার পর ট্র্যাক লিস্ট ফাঁকা করে দেওয়া

          let ownerAlertMsg;
          if (hasMedia) {
            ownerAlertMsg = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msg.message_id);
          } else {
            const ownerAlertText = `📩 <b>নতুন মেসেজ (Contact Mode)</b>\n👤 <b>নাম:</b> ${displayName}\n💬 <b>মেসেজ:</b>\n${text}`;
            ownerAlertMsg = await ctxBot.telegram.sendMessage(OWNER_ID, ownerAlertText, { parse_mode: 'HTML' });
          }

          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${ownerAlertMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });
          
          const botReply = await ctxBot.reply('✅ আপনার মেসেজটি সফলভাবে ইয়াসিন ভাইয়ের কাছে পাঠানো হয়েছে। তিনি শীঘ্রই উত্তর দেবেন।');
          
          // নতুন পাঠানো মেসেজগুলো আবার ট্র্যাকে রাখা, যাতে নেক্সট টাইমে ডিলিট করা যায়
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
