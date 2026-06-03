import { Telegraf, Markup } from 'telegraf';

// ==========================================
// 1. CONFIGURATION & MENUS
// ==========================================
const CONFIG = {
  KV_STATE: 'state_',        // ইউজারের বর্তমান মোড (ai বা contact)
  KV_LAST_MSG: 'lastMsg_',   // কন্টাক্ট মোডের আগের মেসেজ মুছে ফেলার জন্য
  KV_TARGET: 'target_',      // ওনারের রিপ্লাই ট্র্যাক করার জন্য
  EXPIRATION_TTL: 7 * 24 * 60 * 60, // ৭ দিন মেমরি থাকবে
};

// মেইন কীবোর্ড মেনু
const MAIN_MENU = Markup.keyboard([
  ['🤖 AI Mode', '📞 Contact Mode'],
  ['🔄 Reset Bot', 'ℹ️ About']
]).resize();

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================
function getDisplayName(from) {
  if (!from) return 'Unknown User';
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || 'User';
}

// ==========================================
// 3. GEMINI AI INTEGRATION
// ==========================================
async function getGeminiResponse(env, userText) {
  if (!env.GEMINI_API_KEY) return "⚠️ API Key পাওয়া যায়নি। ওনারকে চেক করতে বলুন।";

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const systemPrompt = `You are a highly intelligent and polite personal AI assistant for Yasin Adnan. 
  Answer the user's questions clearly and concisely. Respond in the language they use (Bengali or English).`;

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
      console.error("Gemini API Error:", await response.text());
      return "⚠️ AI সার্ভারে সমস্যা হচ্ছে, একটু পর আবার চেষ্টা করুন।";
    }
    
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ আমি বুঝতে পারিনি, আবার বলুন।";
  } catch (error) {
    console.error('Gemini Fetch Error:', error);
    return "⚠️ AI সিস্টেম বর্তমানে কাজ করছে না।";
  }
}

// ==========================================
// 4. MAIN WORKER LOGIC
// ==========================================
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('🤖 Yasin AI & Contact Bot is Running!', { status: 200 });
    }

    try {
      const bot = new Telegraf(env.BOT_TOKEN);
      const OWNER_ID = String(env.OWNER_ID);

      bot.on('message', async (ctxBot) => {
        const msg = ctxBot.message;
        const chat = msg.chat;
        const from = msg.from;
        
        if (chat.type !== 'private') return; // শুধু ইনবক্সে কাজ করবে
        
        const chatId = String(chat.id);
        const text = msg.text || '';
        const isOwner = (chatId === OWNER_ID);
        const hasMedia = !!(msg.photo || msg.video || msg.document || msg.audio || msg.voice);
        const displayName = getDisplayName(from);

        // ==========================================
        // [A] OWNER REPLY LOGIC (Always Active)
        // ==========================================
        if (isOwner && msg.reply_to_message) {
          const repliedId = msg.reply_to_message.message_id;
          const targetUserId = await env.CONTACT_KV.get(`${CONFIG.KV_TARGET}${repliedId}`);
          
          if (!targetUserId) {
            return ctxBot.reply('⚠️ ইউজারের ডেটা পাওয়া যায়নি বা মেসেজটি অনেক পুরোনো।');
          }
          try {
            await ctxBot.telegram.copyMessage(targetUserId, chatId, msg.message_id);
            return ctxBot.reply('✅ রিপ্লাই ইউজারের কাছে পাঠানো হয়েছে।');
          } catch (err) {
            return ctxBot.reply('❌ পাঠানো যায়নি। ইউজার হয়তো বট ব্লক করেছেন।');
          }
        }

        // ==========================================
        // [B] MENU & COMMANDS
        // ==========================================
        if (text === '/start' || text === '🔄 Reset Bot') {
          // রিসেট করলে ইউজারের সব ক্যাশ ডিলিট করে দেওয়া হবে
          await env.CONTACT_KV.delete(`${CONFIG.KV_STATE}${chatId}`);
          await env.CONTACT_KV.delete(`${CONFIG.KV_LAST_MSG}${chatId}`);
          
          return ctxBot.reply(
            `আসসালামু আলাইকুম <b>${displayName}</b>! 👋\n\nআমি ইয়াসিন আদনানের অফিশিয়াল বট।\nঅনুগ্রহ করে নিচের মেনু থেকে আপনার কাঙ্ক্ষিত মোডটি নির্বাচন করুন:`, 
            { parse_mode: 'HTML', ...MAIN_MENU }
          );
        }

        if (text === 'ℹ️ About') {
          return ctxBot.reply('🤖 এটি ইয়াসিন আদনানের পার্সোনাল AI এবং কন্টাক্ট বট।', MAIN_MENU);
        }

        if (text === '🤖 AI Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'ai');
          return ctxBot.reply(
            'আমি ইয়াসিন আদনানের ব্যক্তিগত Ai 🤖\nআমাকে নির্দ্বিধায় যেকোনো প্রশ্ন করতে পারেন।', 
            MAIN_MENU
          );
        }

        if (text === '📞 Contact Mode') {
          await env.CONTACT_KV.put(`${CONFIG.KV_STATE}${chatId}`, 'contact');
          return ctxBot.reply(
            '📞 <b>কন্টাক্ট মোড চালু হয়েছে!</b>\n\nএখানে আপনি যা লিখবেন তা সরাসরি ইয়াসিন ভাইয়ের কাছে চলে যাবে। (আপনার চ্যাট স্ক্রিন পরিষ্কার রাখতে আগের মেসেজ মুছে যাবে)।', 
            { parse_mode: 'HTML', ...MAIN_MENU }
          );
        }

        // ==========================================
        // [C] MESSAGE PROCESSING (Based on Mode)
        // ==========================================
        
        // বর্তমান মোড চেক করা (ডিফল্ট AI মোড ধরা হলো)
        const currentMode = await env.CONTACT_KV.get(`${CONFIG.KV_STATE}${chatId}`) || 'ai';

        await ctxBot.sendChatAction('typing');

        // --- 1. AI MODE ---
        if (currentMode === 'ai') {
          if (hasMedia) {
            return ctxBot.reply('আমি বর্তমানে শুধু টেক্সট পড়তে পারি। কোনো ছবি বা ফাইল পাঠাতে চাইলে "📞 Contact Mode" এ গিয়ে ইয়াসিন ভাইকে পাঠান।');
          }
          const aiResponse = await getGeminiResponse(env, text);
          return ctxBot.reply(aiResponse);
        }

        // --- 2. CONTACT MODE ---
        if (currentMode === 'contact') {
          // আগের মেসেজ মুছে ফেলার লজিক (Auto Delete)
          const lastMsgStr = await env.CONTACT_KV.get(`${CONFIG.KV_LAST_MSG}${chatId}`);
          if (lastMsgStr) {
            try {
              const lastMsg = JSON.parse(lastMsgStr);
              await ctxBot.telegram.deleteMessage(chatId, lastMsg.userMsgId).catch(() => {});
              await ctxBot.telegram.deleteMessage(chatId, lastMsg.botReplyId).catch(() => {});
            } catch (err) {
              console.error('Delete Message Error', err);
            }
          }

          // ওনারের কাছে মেসেজ ফরওয়ার্ড করা
          let ownerAlertMsg;
          if (hasMedia) {
            ownerAlertMsg = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msg.message_id);
          } else {
            const ownerAlertText = `📩 <b>নতুন কন্টাক্ট মেসেজ!</b>\n👤 <b>নাম:</b> ${displayName}\n💬 <b>মেসেজ:</b>\n${text}`;
            ownerAlertMsg = await ctxBot.telegram.sendMessage(OWNER_ID, ownerAlertText, { parse_mode: 'HTML' });
          }

          // ওনার যেন রিপ্লাই দিতে পারে সেজন্য সেভ করা
          await env.CONTACT_KV.put(`${CONFIG.KV_TARGET}${ownerAlertMsg.message_id}`, chatId, { expirationTtl: CONFIG.EXPIRATION_TTL });

          // ইউজারকে রিপ্লাই দেওয়া
          const botReply = await ctxBot.reply('✅ আপনার মেসেজটি সফলভাবে ইয়াসিন ভাইয়ের কাছে পাঠানো হয়েছে।');

          // নতুন মেসেজগুলোর আইডি সেভ করে রাখা (যাতে পরে ডিলিট করা যায়)
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
      console.error('Bot Error:', error);
      return new Response('Error', { status: 500 });
    }
  }
};
