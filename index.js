const express = require('express');
const admin = require('firebase-admin');
const app = express();

// =============================================
// قراءة المفتاح من متغير البيئة (الأكثر أماناً)
// =============================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('✅ Using Firebase credentials from Environment Variable');
    } catch (e) {
        console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
        process.exit(1);
    }
} else {
    // احتياطي للمطورين المحليين (إذا لم تجد المتغير)
    try {
        serviceAccount = require('./service-account-key.json');
        console.log('✅ Using Firebase credentials from file (fallback)');
    } catch (e) {
        console.error('❌ No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT env var.');
        process.exit(1);
    }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

app.use(express.json());

let fcmToken = null;

// نقطة نهاية لحفظ التوكن من التطبيق
app.get('/saveToken', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Missing token');
  fcmToken = token;
  console.log('✅ FCM Token saved:', token);
  res.send('Token saved');
});

// نقطة نهاية Webhook لتلقي أوامر Telegram
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.send('OK');

    const chatId = message.chat.id.toString();
    const text = message.text.toLowerCase().trim();

    if (text === '/wake' || text === '/start' || text === '/ping') {
      if (!fcmToken) {
        await sendTelegramMessage(chatId, '⚠️ الجهاز غير مسجل. افتح التطبيق.');
        return res.send('OK');
      }

      await admin.messaging().send({
        token: fcmToken,
        data: { ping: 'true' },
        android: { priority: 'high' }
      });

      await sendTelegramMessage(chatId, '⏰ تم إيقاظ التطبيق! أرسل /capture الآن.');
    } else {
      await sendTelegramMessage(chatId, '📟 أرسل /wake لإيقاظ التطبيق.');
    }
    res.send('OK');
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Error');
  }
});

async function sendTelegramMessage(chatId, text) {
  const BOT_TOKEN = '8902913433:AAEjgK8UvQYlVlygLkgsiCPeee4LmqYdhT0';
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (e) {
    console.error('Failed to send Telegram message:', e);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
