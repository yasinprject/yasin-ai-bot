import { Telegraf, Markup } from 'telegraf';

const CONFIG = {
  KV_STATE: 'state_',
  KV_HISTORY: 'history_',
  KV_LAST_INTERACTION: 'last_int_',
  KV_TARGET: 'target_',
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

async function getGeminiResponse(env, chatId, userText, isOwner, userName) {
  if (!env.GEMINI_API_KEY) return "⚠️ API Key পাওয়া যায়নি।";

  const apiKey = String(env.GEMINI_API_KEY).trim();
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  // ১. পারফেক্ট সিস্টেম প্রম্পট (ওনার এবং ইউজারের জন্য আলাদা নির্দেশ)
  const systemPrompt = isOwner
    ? `You are a highly intelligent personal AI assistant. You are talking DIRECTLY to your creator and owner, Yasin Adnan. Be highly respectful, extremely helpful, and concise. Address him as "ইয়াসিন ভাই", but DO NOT greet him repeatedly in every single message. Give direct, well-organized answers in Bengali.`
    : `You are Yasin Adnan's official virtual assistant. You are currently talking to a guest user named ${userName}. Answer their queries politely, clearly, and concisely in Bengali. DO NOT use repetitive greetings (like "আসসালামু আলাইকুম" or "হ্যালো") in every response. Just answer directly and keep the conversation context in mind.`;

  // ২. চ্যাটের মেমরি (আগের কথা) নিয়ে আসা
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
      return `⚠️ Google AI Error: ${errText}`;
    }

    const data = await response.json();
    const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ আমি বুঝতে পারিনি।";

    // ৩. মেমরিতে এআইয়ের নতুন উত্তর সেভ করা (সর্বোচ্চ ১৫ জোড়া মেসেজ রাখবো)
    history.push({ role: "model", parts: [{ text: aiReply }] });
    if (history.length > 30) history = history.slice(-30);
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
        // অটো-ডিলিট ফাংশন (চ্যাট স্ক্রিন ক্লিন রাখার জন্য)
        // ==========================================
        const deletePreviousInteraction = async () => {
          const lastIntStr = await env.CONTACT_KV.get(`${CONFIG.KV_LAST_INTERACTION}${chatId}`);
          if (lastIntStr) {
            try {
              const lastInt = JSON.parse(lastIntStr);
              if (lastInt.userMsgId) await ctxBot.telegram.deleteMessage(chatId, lastInt.userMsgId).catch(() => {});
              if (lastInt.botReplyId) await ctxBot.telegram.deleteMessage(chatId, lastInt.botReplyId).catch(() => {});
            } catch (err) {}
          }
        };

        const saveCurrentInteraction = async (userMsgId, botReplyId) => {
          await env.CONTACT_KV.put(`${CONFIG.KV_LAST_INTERACTION}${chatId}`, JSON.stringify({ userMsgId, botReplyId }), { expirationTtl: CONFIG.EXPIRATION_TTL });
        };

        // ==========================================
        // ১. ওনারের রিপ্লাই লজিক (Contact Mode)
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
        // ২. মেনু এবং কমান্ডস
        // ==========================================
        if (text === '/start' || text === '🔄 Reset Bot') {
          // সবকিছু ক্লিয়ার করা
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_HISTORY}${chatId}`);
          await deletePreviousInteraction();
          await env.CONTACT_KV.delete(`${CONFIG.KV_LAST_INTERACTION}${chatId}`);
          await ctxBot.deleteMessage(msg.message_id).catch(() => {}); // কমান্ড মেসেজটিও ডিলিট

          const welcomeMsg = isOwner
            ? `আসসালামু আলাইকুম <b>ইয়াসিন ভাই</b>! 👋\n\nসবকিছু রিসেট করা হয়েছে। আপনার ওনার প্যানেল সম্পূর্ণ প্রস্তুত।`
            : `আসসালামু আলাইকুম <b>${displayName}</b>! 👋\n\nসবকিছু রিসেট করা হয়েছে। আমি ইয়াসিন আদনানের অফিশিয়াল বট।\nঅনুগ্রহ করে নিচের মেনু থেকে আপনার মোড নির্বাচন করুন:`;

          await ctxBot.reply(welcomeMsg, { parse_mode: 'HTML', ...MAIN_MENU });
          return;
        }

        if (text === 'ℹ️ About') {
          await ctxBot.deleteMessage(msg.message_id).catch(() => {});
          return ctxBot.reply('🤖 এটি ইয়াসিন আদনানের পার্সোনাল AI এবং কন্টাক্ট বট।', MAIN_MENU);
        }

        if (text === '🤖 AI Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'ai');
          await ctxBot.deleteMessage(msg.message_id).catch(() => {});
          
          const aiWelcome = isOwner 
            ? '🤖 <b>AI Mode Active!</b>\nইয়াসিন ভাই, আমি প্রস্তুত। আমাকে নির্দেশ দিন।'
            : '🤖 <b>AI Mode Active!</b>\nআমি ইয়াসিন আদনানের ব্যক্তিগত Ai. আমাকে নির্দ্বিধায় যেকোনো প্রশ্ন করতে পারেন।';
            
          return ctxBot.reply(aiWelcome, { parse_mode: 'HTML', ...MAIN_MENU });
        }

        if (text === '📞 Contact Mode') {
          await ctxBot.deleteMessage(msg.message_id).catch(() => {});
          if (isOwner) {
            return ctxBot.reply('💡 ইয়াসিন ভাই, আপনি নিজেই ওনার! আপনার মেসেজ ফরওয়ার্ড করার প্রয়োজন নেই। আপনি সরাসরি AI ব্যবহার করতে পারেন।', MAIN_MENU);
          }
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'contact');
          return ctxBot.reply('📞 <b>Contact Mode Active!</b>\n\nএখানে আপনি যা লিখবেন তা সরাসরি ইয়াসিন ভাইয়ের কাছে চলে যাবে।', { parse_mode: 'HTML', ...MAIN_MENU });
        }

        // ==========================================
        // ৩. মেসেজ প্রসেসিং (AI বা Contact)
        // ==========================================
        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';
        await ctxBot.sendChatAction('typing');

        // নতুন মেসেজ আসার সাথে সাথে আগের মেসেজগুলো ডিলিট করে স্ক্রিন পরিষ্কার করে দেওয়া
        await deletePreviousInteraction();

        // --- AI মোড ---
        if (currentMode === 'ai' || isOwner) {
          if (hasMedia) {
            const reply = await ctxBot.reply('আমি বর্তমানে শুধু টেক্সট পড়তে পারি। ছবি বা ফাইল পাঠাতে চাইলে "📞 Contact Mode" ব্যবহার করুন।');
            await saveCurrentInteraction(msg.message_id, reply.message_id);
            return;
          }

          const aiResponse = await getGeminiResponse(env, chatId, text, isOwner, displayName);
          const botReply = await ctxBot.reply(aiResponse);
          // মেসেজ সেভ রাখা, যাতে পরের মেসেজ দিলে এগুলো ডিলিট করা যায়
          await saveCurrentInteraction(msg.message_id, botReply.message_id);
          return;
        }

        // --- Contact মোড ---
        if (currentMode === 'contact') {
          let ownerAlertMsg;
          if (hasMedia) {
            ownerAlertMsg = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msg.message_id);
          } else {
            const ownerAlertText = `📩 <b>নতুন মেসেজ (Contact Mode)</b>\n👤 <b>নাম:</b> ${displayName}\n💬 <b>মেসেজ:</b>\n${text}`;
            ownerAlertMsg = await ctxBot.telegram.sendMessage(OWNER_ID, ownerAlertText, { parse_mode: 'HTML' });
          }

          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${ownerAlertMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });

          const botReply = await ctxBot.reply('✅ আপনার মেসেজটি সফলভাবে ইয়াসিন ভাইয়ের কাছে পাঠানো হয়েছে।');
          await saveCurrentInteraction(msg.message_id, botReply.message_id);
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
