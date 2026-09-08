// index.js - النسخة المصححة
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// =============================================
// 1. التحقق من متغيرات البيئة المطلوبة
// =============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = path.join('/tmp', 'fcm_token.txt');

if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN environment variable');
    process.exit(1);
}

// =============================================
// 2. تهيئة Firebase (JSON مباشر بدون Base64)
// =============================================
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

        // ✅ الإصلاح الجوهري: بعض لوحات الاستضافة تحوّل الأسطر الحقيقية
        // داخل private_key إلى نص حرفي \n — هذا السطر يعيدها أسطراً حقيقية
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

        console.log('✅ Firebase credentials loaded from JSON environment variable.');
    } catch (e) {
        console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
        process.exit(1);
    }
} else {
    try {
        serviceAccount = require('./service-account-key.json');
        console.log('✅ Using Firebase credentials from local file (fallback).');
    } catch (e) {
        console.error('❌ No Firebase credentials found.');
        process.exit(1);
    }
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// =============================================
// 3. FCM Token — حفظ في ملف لبقائه بعد الريستارت
// =============================================
function saveToken(token) {
    try {
        fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    } catch (e) {
        console.error('⚠️ Could not save token to file:', e.message);
    }
}

function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        }
    } catch (e) {
        console.error('⚠️ Could not load token from file:', e.message);
    }
    return null;
}

let fcmToken = loadToken();
if (fcmToken) {
    console.log('✅ FCM Token loaded from file:', fcmToken.substring(0, 20) + '...');
}

// =============================================
// 4. حفظ FCM Token من تطبيق Android
// =============================================
app.get('/saveToken', (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(400).json({ error: 'Missing token parameter' });
    }
    fcmToken = token;
    saveToken(token);
    console.log('✅ FCM Token saved:', token.substring(0, 20) + '...');
    res.json({ success: true, message: 'Token saved' });
});

// =============================================
// 5. Ping endpoint — يمنع نوم السيرفر على Render
// =============================================
app.get('/ping', (req, res) => {
    res.json({
        status: 'alive',
        hasToken: !!fcmToken,
        timestamp: new Date().toISOString()
    });
});

// =============================================
// 6. Webhook لأوامر Telegram
// =============================================
app.post('/webhook', async (req, res) => {
    res.send('OK');

    try {
        const message = req.body.message;
        if (!message || !message.text) return;

        const chatId = message.chat.id.toString();
        const text = message.text.toLowerCase().trim();

        if (text === '/wake' || text === '/start' || text === '/ping') {
            if (!fcmToken) {
                await sendTelegramMessage(chatId,
                    '⚠️ الجهاز غير مسجل بعد.\n' +
                    'تأكد من فتح تطبيق المراقبة مرة واحدة على الهاتف الآخر أولاً.'
                );
                return;
            }

            try {
                await admin.messaging().send({
                    token: fcmToken,
                    data: { action: 'wake' },
                    android: { priority: 'high' }
                });
                await sendTelegramMessage(chatId,
                    '✅ تم إيقاظ كاميرا المراقبة!\n' +
                    'يمكنك الآن استخدام /capture أو /status'
                );
            } catch (fcmError) {
                console.error('❌ FCM send error:', fcmError.message);
                if (fcmError.code === 'messaging/registration-token-not-registered') {
                    fcmToken = null;
                    saveToken('');
                    await sendTelegramMessage(chatId,
                        '❌ انتهت صلاحية توكن الجهاز.\n' +
                        'افتح التطبيق على هاتف المراقبة لتجديده.'
                    );
                } else {
                    await sendTelegramMessage(chatId, '❌ فشل إيقاظ الجهاز. تأكد من اتصاله بالإنترنت.');
                }
            }

        } else if (text === '/status') {
            const status = fcmToken
                ? '🟢 كاميرا المراقبة مسجلة وجاهزة\nاستخدم /wake لإيقاظها'
                : '🔴 كاميرا المراقبة غير مسجلة\nافتح التطبيق على الهاتف الآخر أولاً';
            await sendTelegramMessage(chatId, status);

        } else {
            await sendTelegramMessage(chatId,
                '📋 الأوامر المتاحة:\n' +
                '/wake — إيقاظ كاميرا المراقبة\n' +
                '/status — حالة الجهاز\n' +
                '/capture — التقاط صورة'
            );
        }

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
    }
});

// =============================================
// 7. دالة إرسال رسائل Telegram
// =============================================
async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });
        if (!response.ok) {
            const errText = await response.text();
            console.error('❌ Telegram API error:', errText);
        }
    } catch (e) {
        console.error('❌ Failed to send Telegram message:', e.message);
    }
}

// =============================================
// 8. تشغيل السيرفر
// =============================================
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 Webhook ready at /webhook`);
    console.log(`🔔 Token endpoint ready at /saveToken`);
    console.log(`🏓 Ping endpoint ready at /ping`);
});
