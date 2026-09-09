// ╔══════════════════════════════════════════════════════════════╗
// ║           index.js — سيرفر كاميرا المراقبة                  ║
// ║                                                              ║
// ║  المنطق الأساسي:                                             ║
// ║  • التطبيق حي  → يرسل Heartbeat كل 30ث → Polling نشط        ║
// ║  • التطبيق مات → لا heartbeat لـ 60ث  → Webhook يتفعّل       ║
// ║  • المستخدم يرسل أمراً → السيرفر يرسل FCM → يوقظ التطبيق    ║
// ║  • التطبيق يستيقظ → يرسل /appAlive → Webhook يُحذف           ║
// ╚══════════════════════════════════════════════════════════════╝

const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ================================================================
// [1] متغيرات البيئة — يجب إضافتها في Railway Dashboard
// ================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SERVER_URL = process.env.SERVER_URL || 'https://zainzzzzz-production.up.railway.app';
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = path.join('/tmp', 'fcm_token.txt');

if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ [STARTUP] Missing TELEGRAM_BOT_TOKEN environment variable');
    process.exit(1);
}
if (!process.env.SERVER_URL) {
    console.warn('⚠️ [STARTUP] SERVER_URL not set, using default:', SERVER_URL);
}

// ================================================================
// [2] تهيئة Firebase Admin SDK
// ================================================================
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        // إصلاح \n داخل private_key (بعض لوحات الاستضافة تحوّلها لنص حرفي)
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        console.log('✅ [STARTUP] Firebase credentials loaded from environment variable.');
    } catch (e) {
        console.error('❌ [STARTUP] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
        process.exit(1);
    }
} else {
    try {
        serviceAccount = require('./service-account-key.json');
        console.log('✅ [STARTUP] Firebase credentials loaded from local file (fallback).');
    } catch (e) {
        console.error('❌ [STARTUP] No Firebase credentials found. Add FIREBASE_SERVICE_ACCOUNT_JSON or service-account-key.json');
        process.exit(1);
    }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ================================================================
// [3] حالة النظام — تُتتبّع في الذاكرة
// ================================================================
let fcmToken      = loadToken(); // توكن FCM للجهاز المراقِب
let lastHeartbeat = null;        // آخر وقت وصلنا فيه heartbeat من التطبيق
let webhookActive = true;        // هل Webhook مفعّل الآن؟ (نفترض نعم عند بدء السيرفر)
let lastChatId    = null;        // آخر chat_id أرسل لنا رسالة (لإرسال الإشعارات له)

if (fcmToken) {
    console.log(`✅ [STARTUP] FCM Token loaded: ${fcmToken.substring(0, 20)}...`);
} else {
    console.warn('⚠️ [STARTUP] No FCM Token found. App needs to register first.');
}

// ================================================================
// [4] دوال حفظ وتحميل FCM Token من ملف
//     (يحتفظ بالتوكن حتى بعد إعادة تشغيل السيرفر)
// ================================================================
function saveToken(token) {
    try {
        fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    } catch (e) {
        console.error('⚠️ [TOKEN] Could not save token to file:', e.message);
    }
}

function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
            return t || null;
        }
    } catch (e) {
        console.error('⚠️ [TOKEN] Could not load token from file:', e.message);
    }
    return null;
}

// ================================================================
// [5] إدارة Webhook تلقائياً
// ================================================================

// تفعيل Webhook — يُستدعى عندما يموت التطبيق
async function reactivateWebhook() {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: `${SERVER_URL}/webhook` })
        });
        const data = await response.json();
        if (data.ok) {
            webhookActive = true;
            console.log('🔗 [WEBHOOK] Reactivated — server is now listening for Telegram commands');
        } else {
            console.error('❌ [WEBHOOK] Failed to reactivate:', JSON.stringify(data));
        }
    } catch (e) {
        console.error('❌ [WEBHOOK] reactivateWebhook error:', e.message);
    }
}

// حذف Webhook — يُستدعى عندما يكون التطبيق حياً ويتولّى Polling
async function deleteWebhook() {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`;
        const response = await fetch(url, { method: 'POST' });
        const data = await response.json();
        if (data.ok) {
            webhookActive = false;
            console.log('🔓 [WEBHOOK] Deleted — app is alive, Polling is now active');
        } else {
            console.error('❌ [WEBHOOK] Failed to delete:', JSON.stringify(data));
        }
    } catch (e) {
        console.error('❌ [WEBHOOK] deleteWebhook error:', e.message);
    }
}

// ================================================================
// [6] مراقبة حالة التطبيق كل 60 ثانية
//     إذا لم يصل heartbeat منذ 60 ثانية → التطبيق مات → فعّل Webhook
// ================================================================
setInterval(async () => {
    const now = Date.now();
    const isAlive = lastHeartbeat && (now - lastHeartbeat) < 60000;

    if (!isAlive && !webhookActive) {
        // التطبيق مات ولم يُفعَّل Webhook بعد
        console.log('💀 [MONITOR] No heartbeat for 60s — app is dead, reactivating webhook...');
        await reactivateWebhook();

        // إشعار المستخدم أن الكاميرا انقطعت
        if (lastChatId) {
            await sendTelegramMessage(lastChatId,
                '📵 انقطع الاتصال بالكاميرا تلقائياً\n' +
                '🔗 Webhook أُعيد تفعيله\n' +
                'أرسل /wake لإيقاظها أو /capture لالتقاط صورة'
            );
        }
    }
}, 60000);

// ================================================================
// [7] Endpoint: حفظ FCM Token من تطبيق Android
//     يُستدعى من MainActivity عند بدء الخدمة
// ================================================================
app.get('/saveToken', (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(400).json({ error: 'Missing token parameter' });
    }
    fcmToken = token;
    saveToken(token);
    console.log(`📲 [TOKEN] New FCM Token saved: ${token.substring(0, 20)}...`);
    res.json({ success: true, message: 'Token saved' });
});

// ================================================================
// [8] Endpoint: Heartbeat — التطبيق يرسله كل 30 ثانية
//     يثبت أن التطبيق حي → إذا كان Webhook مفعّلاً يُحذف
// ================================================================
app.get('/heartbeat', async (req, res) => {
    const wasFirstHeartbeat = !lastHeartbeat;
    lastHeartbeat = Date.now();

    console.log(`💓 [HEARTBEAT] App is alive | webhookActive: ${webhookActive}`);

    // إذا كان Webhook مفعّلاً → التطبيق عاد للحياة → احذف Webhook
    if (webhookActive) {
        console.log('🔄 [HEARTBEAT] Webhook was active, deleting it now...');
        await deleteWebhook();
    }

    res.json({ success: true, timestamp: new Date().toISOString() });
});

// ================================================================
// [9] Endpoint: إشعار فوري بأن التطبيق استيقظ عبر FCM
//     يُستدعى من TelegramPollingService مباشرة بعد بدء التشغيل
// ================================================================
app.get('/appAlive', async (req, res) => {
    lastHeartbeat = Date.now();

    console.log(`🚀 [APP_ALIVE] App woke up via FCM | webhookActive: ${webhookActive}`);

    if (webhookActive) {
        await deleteWebhook();

        // إشعار المستخدم أن التطبيق استيقظ وجاهز
        if (lastChatId) {
            await sendTelegramMessage(lastChatId,
                '✅ تم إيقاظ الكاميرا بنجاح!\n' +
                '🔓 تم فك الارتباط مع Webhook\n' +
                '📡 الأوامر تعمل الآن عبر Polling مباشرةً\n' +
                'يمكنك الآن إرسال /capture أو /status'
            );
        }
    }

    res.json({ success: true });
});

// ================================================================
// [10] Endpoint: Ping — يُستخدم بـ cron-job.org لمنع النوم
// ================================================================
app.get('/ping', (req, res) => {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    console.log(`🏓 [PING] Server alive | app: ${isAlive ? 'online' : 'offline'} | webhook: ${webhookActive}`);
    res.json({
        status: 'server_alive',
        appStatus: isAlive ? '🟢 online' : '🔴 offline',
        webhookActive,
        hasToken: !!fcmToken,
        lastHeartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
        timestamp: new Date().toISOString()
    });
});

// ================================================================
// [11] Webhook — يستقبل أوامر Telegram عندما التطبيق ميت
// ================================================================
app.post('/webhook', async (req, res) => {
    // نرد فوراً لتيليجرام (يجب أن يصل الرد خلال 5 ثوانٍ)
    res.send('OK');

    try {
        const message = req.body.message;
        if (!message || !message.text) return;

        const chatId = message.chat.id.toString();
        const text = message.text.toLowerCase().trim();
        lastChatId = chatId; // حفظ chat_id لإرسال الإشعارات لاحقاً

        console.log(`📨 [WEBHOOK] Command: "${text}" | from: ${chatId}`);

        // التحقق من وجود توكن FCM
        if (!fcmToken && text !== '/status' && text !== '/الحالة' && text !== '/help' && text !== '/مساعدة') {
            await sendTelegramMessage(chatId,
                '⚠️ الجهاز لم يُسجَّل بعد.\n' +
                'افتح تطبيق المراقبة مرة واحدة على الهاتف الآخر أولاً.'
            );
            return;
        }

        // توجيه الأوامر
        switch (text) {
            case '/wake':
            case '/start':
                await handleWake(chatId);
                break;

            case '/capture':
            case '/التقط':
                await handleCapture(chatId);
                break;

            case '/status':
            case '/الحالة':
                await handleStatus(chatId);
                break;

            case '/help':
            case '/مساعدة':
                await sendTelegramMessage(chatId,
                    '📋 الأوامر المتاحة:\n' +
                    '/capture — التقاط صورة فورية\n' +
                    '/wake    — إيقاظ الكاميرا يدوياً\n' +
                    '/status  — حالة الجهاز\n' +
                    '/help    — قائمة الأوامر'
                );
                break;

            default:
                await sendTelegramMessage(chatId,
                    '❓ أمر غير معروف.\nأرسل /help لقائمة الأوامر.'
                );
        }

    } catch (error) {
        console.error('❌ [WEBHOOK] Processing error:', error);
    }
});

// ================================================================
// [12] معالجة أمر /wake
// ================================================================
async function handleWake(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;

    if (isAlive) {
        console.log(`[WAKE] App already alive`);
        await sendTelegramMessage(chatId, '✅ الكاميرا تعمل بالفعل!\nاستخدم /capture أو /status');
        return;
    }

    try {
        await admin.messaging().send({
            token: fcmToken,
            data: { action: 'wake' },
            android: { priority: 'high' }
        });
        console.log('📤 [FCM] Sent — action: wake');
        await sendTelegramMessage(chatId,
            '⏳ جاري إيقاظ الكاميرا...\n' +
            'ستصلك رسالة تأكيد خلال ثوانٍ عند استيقاظها.'
        );
    } catch (fcmError) {
        await handleFcmError(chatId, fcmError);
    }
}

// ================================================================
// [13] معالجة أمر /capture
// ================================================================
async function handleCapture(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;

    if (isAlive) {
        // التطبيق حي → الأمر يُعالَج عبر Polling مباشرةً، لا عمل للسيرفر هنا
        console.log(`[CAPTURE] App is alive, command handled by Polling`);
        return;
    }

    // التطبيق ميت → أرسل FCM مع أمر capture ليستيقظ وينفّذه فوراً
    try {
        await admin.messaging().send({
            token: fcmToken,
            data: { action: 'capture' },
            android: { priority: 'high' }
        });
        console.log('📤 [FCM] Sent — action: capture');
        await sendTelegramMessage(chatId,
            '📸 الكاميرا كانت نائمة!\n' +
            '⏳ جاري إيقاظها والتقاط الصورة...\n' +
            'ستصلك الصورة خلال ثوانٍ.'
        );
    } catch (fcmError) {
        await handleFcmError(chatId, fcmError);
    }
}

// ================================================================
// [14] معالجة أمر /status
// ================================================================
async function handleStatus(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    const lastSeen = lastHeartbeat
        ? `آخر اتصال: ${new Date(lastHeartbeat).toLocaleTimeString('ar-SA')}`
        : 'لم يتصل بعد';

    if (isAlive) {
        await sendTelegramMessage(chatId,
            '🟢 الكاميرا متصلة وتعمل\n' +
            `${lastSeen}\n` +
            '📡 Polling نشط — الأوامر تصل مباشرةً'
        );
    } else {
        await sendTelegramMessage(chatId,
            '🔴 الكاميرا غير متصلة\n' +
            `${lastSeen}\n` +
            '🔗 Webhook نشط\n' +
            'أرسل /wake لإيقاظها أو /capture لالتقاط صورة'
        );
    }
}

// ================================================================
// [15] معالجة أخطاء FCM
// ================================================================
async function handleFcmError(chatId, fcmError) {
    console.error('❌ [FCM] Error:', fcmError.code, '—', fcmError.message);

    if (fcmError.code === 'messaging/registration-token-not-registered') {
        // التوكن انتهت صلاحيته → احذفه
        fcmToken = null;
        saveToken('');
        console.log('🗑️ [FCM] Expired token removed');
        await sendTelegramMessage(chatId,
            '❌ انتهت صلاحية توكن الجهاز.\n' +
            'افتح التطبيق على هاتف المراقبة لتجديده.'
        );
    } else {
        await sendTelegramMessage(chatId,
            '❌ فشل إيقاظ الجهاز.\n' +
            'تأكد من اتصاله بالإنترنت وحاول مرة أخرى.'
        );
    }
}

// ================================================================
// [16] دالة إرسال رسائل Telegram
// ================================================================
async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });
        if (!response.ok) {
            console.error('❌ [TELEGRAM] API error:', await response.text());
        }
    } catch (e) {
        console.error('❌ [TELEGRAM] Failed to send message:', e.message);
    }
}

// ================================================================
// [17] تشغيل السيرفر
// ================================================================
app.listen(PORT, async () => {
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Server URL: ${SERVER_URL}`);
    console.log(`📡 Webhook: ${SERVER_URL}/webhook`);
    console.log(`💓 Heartbeat: ${SERVER_URL}/heartbeat`);
    console.log(`🚀 App Alive: ${SERVER_URL}/appAlive`);
    console.log(`🔔 Save Token: ${SERVER_URL}/saveToken`);
    console.log(`🏓 Ping: ${SERVER_URL}/ping`);
    console.log('══════════════════════════════════════════');

    // عند بدء السيرفر نفترض أن التطبيق ميت → فعّل Webhook
    console.log('🔄 [STARTUP] Activating webhook (assuming app is offline)...');
    await reactivateWebhook();
});
