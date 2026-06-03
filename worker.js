import { Telegraf, Markup } from 'telegraf';

const CONFIG = {
  KV_STATE: 'state_',        
  KV_LAST_MSG: 'lastMsg_',   
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

async function getGeminiResponse(env, userText) {
  if (!env.GEMINI_API_KEY) return "⚠️ API Key পাওয়া যায়নি।";

  // গুগলের সবচেয়ে পাওয়ারফুল লেটেস্ট প্রো মডেল সেট করা হয়েছে
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${env.GEMINI_API_KEY.trim()}`;
  
  const systemPrompt = `You are a highly intelligent and polite personal AI assistant for Yasin Adnan. Answer clearly in Bengali.`;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.7 }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return `⚠️ **Google API Error:**\n\n${errText}`;
    }
    
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ আমি বুঝতে পারিনি, আবার বলুন।";
  } catch (error) {
    return `⚠️ System Error: ${error.message}`;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('🤖 Yasin AI & Contact Bot is Running!', { status: 200 });

    try {
      const bot = new Telegraf(env.BOT_TOKEN);
      const OWNER_ID = String(env.OWNER_ID);

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
        // [A] OWNER SPECIAL LOGIC
        // ==========================================
        if (isOwner && msg.reply_to_message) {
          const repliedId = msg.reply_to_message.message_id;
          const targetUserId = await env.CONTACT_KV.get(`${CONFIG.KV_TARGET}${repliedId}`);
          
          if (!targetUserId) return ctxBot.reply('⚠️ ইউজারের ডেটা পাওয়া যায়নি বা মেসেজটি অনেক পুরোনো।');
          
          try {
            await ctxBot.telegram.copyMessage(targetUserId, chatId, msg.message_id);
            return ctxBot.reply('✅ রিপ্লাই ইউজারের কাছে পাঠানো হয়েছে।');
          } catch (err) {
            return ctxBot.reply('❌ পাঠানো যায়নি। ইউজার হয়তো বট ব্লক করেছেন।');
          }
        }

        // ==========================================
        // [B] COMMANDS & MENU
        // ==========================================
        if (text === '/start' || text === '🔄 Reset Bot') {
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_LAST_MSG}${chatId}`);
          
          // ওনার এবং ইউজারের জন্য আলাদা ওয়েলকাম মেসেজ
          const welcomeMsg = isOwner 
            ? `আসসালামু আলাইকুম <b>ইয়াসিন ভাই</b>! 👋\n\nআপনার ওনার প্যানেল অ্যাক্টিভ। আপনি চাইলে সরাসরি AI এর সাথে কথা বলতে পারেন, অথবা ইউজারদের মেসেজে Reply দিতে পারেন।`
            : `আসসালামু আলাইকুম <b>${displayName}</b>! 👋\n\nআমি ইয়াসিন আদনানের অফিশিয়াল বট।\nঅনুগ্রহ করে নিচের মেনু থেকে আপনার কাঙ্ক্ষিত মোডটি নির্বাচন করুন:`;

          return ctxBot.reply(welcomeMsg, { parse_mode: 'HTML', ...MAIN_MENU });
        }

        if (text === 'ℹ️ About') return ctxBot.reply('🤖 এটি ইয়াসিন আদনানের পার্সোনাল AI এবং কন্টাক্ট বট।', MAIN_MENU);

        if (text === '🤖 AI Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'ai');
          return ctxBot.reply('আমি ইয়াসিন আদনানের ব্যক্তিগত Ai 🤖\nআমাকে নির্দ্বিধায় যেকোনো প্রশ্ন করতে পারেন।', MAIN_MENU);
        }

        if (text === '📞 Contact Mode') {
          if (isOwner) return ctxBot.reply('💡 আপনি নিজেই ওনার! আপনার মেসেজ ফরওয়ার্ড করার প্রয়োজন নেই। আপনি সরাসরি AI ব্যবহার করতে পারেন।');
          
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'contact');
          return ctxBot.reply('📞 <b>কন্টাক্ট মোড চালু হয়েছে!</b>\n\nএখানে আপনি যা লিখবেন তা সরাসরি ইয়াসিন ভাইয়ের কাছে চলে যাবে। (আপনার চ্যাট স্ক্রিন পরিষ্কার রাখতে আগের মেসেজ মুছে যাবে)।', { parse_mode: 'HTML', ...MAIN_MENU });
        }

        // ==========================================
        // [C] MESSAGE PROCESSING
        // ==========================================
        
        // ডিফল্ট এআই মোড
        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';
        await ctxBot.sendChatAction('typing');

        // ১. AI MODE (ওনার এবং ইউজার উভয়ের জন্য)
        if (currentMode === 'ai' || isOwner) {
          if (hasMedia) return ctxBot.reply('আমি বর্তমানে শুধু টেক্সট পড়তে পারি।');
          const aiResponse = await getGeminiResponse(env, text);
          return ctxBot.reply(aiResponse);
        }

        // ২. CONTACT MODE (শুধু ইউজারদের জন্য)
        if (currentMode === 'contact') {
          const lastMsgStr = await env.CONTACT_KV.get(`${CONFIG.KV_LAST_MSG}${chatId}`);
          if (lastMsgStr) {
            try {
              const lastMsg = JSON.parse(lastMsgStr);
              await ctxBot.telegram.deleteMessage(chatId, lastMsg.userMsgId).catch(() => {});
              await ctxBot.telegram.deleteMessage(chatId, lastMsg.botReplyId).catch(() => {});
            } catch (err) {}
          }

          let ownerAlertMsg;
          if (hasMedia) {
            ownerAlertMsg = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msg.message_id);
          } else {
            const ownerAlertText = `📩 <b>নতুন কন্টাক্ট মেসেজ!</b>\n👤 <b>নাম:</b> ${displayName}\n💬 <b>মেসেজ:</b>\n${text}`;
            ownerAlertMsg = await ctxBot.telegram.sendMessage(OWNER_ID, ownerAlertText, { parse_mode: 'HTML' });
          }

          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${ownerAlertMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });
          const botReply = await ctxBot.reply('✅ আপনার মেসেজটি সফলভাবে ইয়াসিন ভাইয়ের কাছে পাঠানো হয়েছে।');

          await env.CONTACT_KV.put(`${CONFIG.KV_LAST_MSG}${chatId}`, JSON.stringify({
            userMsgId: msg.message_id,
            botReplyId: botReply.message_id
          }));
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
