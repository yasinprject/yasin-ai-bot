import { Telegraf, Markup } from 'telegraf';

const CONFIG = {
  KV_TARGET_PREFIX: 'target_',
  EXPIRATION_TTL: 30 * 24 * 60 * 60,
};

const KEYBOARD_MENU = Markup.keyboard([
  ['🔄 Reset chat', 'ℹ️ About this bot']
]).resize();

function getDisplayName(from) {
  if (!from) return 'Unknown User';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || from.username || 'Unknown User';
}

async function saveMessageMapping(env, ownerMsgId, userChatId) {
  try {
    await env.CONTACT_KV.put(`${CONFIG.KV_TARGET_PREFIX}${ownerMsgId}`, String(userChatId), { expirationTtl: CONFIG.EXPIRATION_TTL });
  } catch (err) {
    console.error('KV Error:', err);
  }
}

async function getGeminiResponse(env, userText, userName) {
  if (!env.GEMINI_API_KEY) return null;
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const systemPrompt = `You are a highly polite and professional virtual assistant for Yasin.
  Your task is to warmly greet the user, answer general queries, and inform them that their message has been sent to Yasin.
  Do not pretend to be Yasin. Always say you are his AI Assistant. 
  Current User Name: ${userName}. 
  Respond strictly in the language the user uses (Bengali or English). Keep answers concise.`;

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
    if (!response.ok) return null;
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    return null; 
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('🤖 Yasin AI Bot is Running Perfectly on Cloudflare!', { status: 200 });
    }

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

        // ========== OWNER SIDE ==========
        if (isOwner) {
          if (text === '/start' || text === '🔄 Reset chat') {
            return ctxBot.reply('👨‍💻 <b>ওনার প্যানেল অ্যাক্টিভ!</b>\n\nযেকোনো ইউজারের মেসেজে <b>Reply</b> দিলে তা ইউজারের কাছে পৌঁছে যাবে।', { parse_mode: 'HTML', ...KEYBOARD_MENU });
          }
          if (msg.reply_to_message) {
            const repliedId = msg.reply_to_message.message_id;
            const targetUserId = await env.CONTACT_KV.get(`${CONFIG.KV_TARGET_PREFIX}${repliedId}`);
            if (!targetUserId) return ctxBot.reply('⚠️ ইউজারের ডেটা পাওয়া যায়নি।');
            try {
              await ctxBot.telegram.copyMessage(targetUserId, chatId, msg.message_id);
              return ctxBot.reply('✅ রিপ্লাই পাঠানো হয়েছে।');
            } catch (err) {
              return ctxBot.reply('❌ পাঠানো যায়নি। ইউজার হয়তো বট ব্লক করেছেন।');
            }
          }
          return ctxBot.reply('💡 ইউজারকে উত্তর দিতে নির্দিষ্ট মেসেজটি সিলেক্ট করে Reply করুন।');
        }

        // ========== USER SIDE ==========
        if (text === '/start' || text === '🔄 Reset chat') {
          return ctxBot.reply(`আসসালামু আলাইকুম <b>${displayName}</b>! 👋\n\nআমি ইয়াসিন ভাইয়ের AI অ্যাসিস্ট্যান্ট। আমাকে আপনার প্রশ্ন করতে পারেন অথবা মেসেজ লিখে পাঠাতে পারেন।`, { parse_mode: 'HTML', ...KEYBOARD_MENU });
        }
        if (text === 'ℹ️ About this bot') return ctxBot.reply('🤖 এটি ইয়াসিন ভাইয়ের সাথে যোগাযোগের একটি মাধ্যম।');

        await ctxBot.sendChatAction('typing');
        let aiResponse = null;

        if (text) {
          aiResponse = await getGeminiResponse(env, text, displayName);
        } else if (hasMedia) {
          aiResponse = "আমি বর্তমানে কোনো ছবি বা ফাইল দেখতে পারি না। তবে আপনার পাঠানো ফাইলটি ইয়াসিন ভাইয়ের কাছে ফরোয়ার্ড করে দিয়েছি।";
        }

        if (aiResponse) await ctxBot.reply(aiResponse);
        else await ctxBot.reply('✅ আপনার মেসেজটি সফলভাবে ইয়াসিন ভাইয়ের কাছে পাঠানো হয়েছে।');

        // ========== FORWARD TO OWNER ==========
        if (hasMedia) {
          const fwd = await ctxBot.telegram.forwardMessage(OWNER_ID, chatId, msg.message_id);
          await saveMessageMapping(env, fwd.message_id, chatId);
        }

        const ownerAlertText = `📩 <b>নতুন মেসেজ!</b>\n👤 <b>নাম:</b> ${displayName}\n💬 <b>মেসেজ:</b> <i>${text || '[মিডিয়া]'}</i>\n🤖 <b>AI:</b> ${aiResponse || 'No AI Reply'}`;
        const ownerAlertMsg = await ctxBot.telegram.sendMessage(OWNER_ID, ownerAlertText, { parse_mode: 'HTML' });
        await saveMessageMapping(env, ownerAlertMsg.message_id, chatId);
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
