const express = require('express');
const admin = require('firebase-admin');
const app = express();

// =============================================
// قراءة المفتاح من متغير البيئة (Base64)
// =============================================
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        // الخطوة 1: فك تشفير Base64 إلى نص JSON
        const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
        // الخطوة 2: تحويل النص إلى كائن JavaScript
        serviceAccount = JSON.parse(decoded);
        console.log('✅ Firebase credentials loaded from Base64 environment variable.');
    } catch (e) {
        console.error('❌ Failed to decode/parse FIREBASE_SERVICE_ACCOUNT:');
        console.error(e.message);
        console.error('   Make sure the variable contains a valid Base64-encoded JSON string.');
        process.exit(1);
    }
} else {
    // احتياطي للمطورين المحليين (استخدام ملف)
    try {
        serviceAccount = require('./service-account-key.json');
        console.log('✅ Using Firebase credentials from local file (fallback).');
    } catch (e) {
        console.error('❌ No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT env var or add service-account-key.json file.');
        process.exit(1);
    }
}

// تهيئة Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

app.use(express.json());

// تخزين FCM Token في الذاكرة (سيُفقد عند إعادة التشغيل)
let fcmToken = null;

// =============================================
// نقطة نهاية لحفظ التوكن من تطبيق Android
// =============================================
app.get('/saveToken', (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(400).send('Missing token');
    }
    fcmToken = token;
    console.log('✅ FCM Token saved:', token);
    res.send('Token saved');
});

// =============================================
// نقطة نهاية Webhook لتلقي أوامر Telegram
// =============================================
app.post('/webhook', async (req, res) => {
    try {
        const message = req.body.message;
        if (!message || !message.text) {
            return res.send('OK');
        }

        const chatId = message.chat.id.toString();
        const text = message.text.toLowerCase().trim();

        // الأمر الخاص بالإيقاظ
        if (text === '/wake' || text === '/start' || text === '/ping') {
            if (!fcmToken) {
                await sendTelegramMessage(chatId, '⚠️ الجهاز غير مسجل. تأكد من فتح التطبيق مرة واحدة.');
                return res.send('OK');
            }

            // إرسال FCM عالي الأولوية للإيقاظ
            await admin.messaging().send({
                token: fcmToken,
                data: { ping: 'true' },
                android: {
                    priority: 'high'
                }
            });

            await sendTelegramMessage(chatId, '⏰ تم إيقاظ التطبيق! يمكنك الآن استخدام الأوامر العادية (/capture, /status).');
        } else {
            // أي أمر آخر، نرد برسالة توجيهية
            await sendTelegramMessage(chatId, '📟 استخدم /wake لإيقاظ التطبيق إذا كان متوقفاً.');
        }

        res.send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Error');
    }
});

// =============================================
// دالة مساعدة لإرسال رسائل إلى Telegram
// =============================================
async function sendTelegramMessage(chatId, text) {
    const BOT_TOKEN = '8902913433:AAEjgK8UvQYlVlygLkgsiCPeee4LmqYdhT0';
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });

        if (!response.ok) {
            console.error('Telegram API error:', await response.text());
        }
    } catch (e) {
        console.error('Failed to send Telegram message:', e);
    }
}

// =============================================
// تشغيل الخادم
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
