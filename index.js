const express = require('express');
const admin = require('firebase-admin');
const app = express();

// تأكد من أن اسم ملف المفتاح مطابق
const serviceAccount = require('./service-account-key.json');

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
  const BOT_TOKEN = '8902913433:AAEjgK8UvQYlVlygLkgsiCPeee4LmqYdhT0'; // ضع توكنك هنا
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));