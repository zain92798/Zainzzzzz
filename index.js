// ╔══════════════════════════════════════════════════════════════════╗
// ║   index.js — سيرفر كاميرا المراقبة + مدير الملفات (Socket.IO)   ║
// ╚══════════════════════════════════════════════════════════════════╝

const express = require('express');
const admin   = require('firebase-admin');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ================================================================
// [1] متغيرات البيئة
// ================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SERVER_URL   = process.env.SERVER_URL   || 'https://zainzzzzz-production.up.railway.app';
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'admin123';
const PORT         = process.env.PORT || 3000;
const TOKEN_FILE   = path.join('/tmp', 'fcm_token.txt');

if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ [STARTUP] Missing TELEGRAM_BOT_TOKEN');
    process.exit(1);
}

// ================================================================
// [2] تهيئة Firebase
// ================================================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
        console.log('✅ [STARTUP] Firebase loaded from Base64 env.');
    } catch (e) {
        console.error('❌ [STARTUP] Base64 decode error:', e.message);
        process.exit(1);
    }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        console.log('✅ [STARTUP] Firebase loaded from JSON env.');
    } catch (e) {
        console.error('❌ [STARTUP] JSON parse error:', e.message);
        process.exit(1);
    }
} else {
    try {
        serviceAccount = require('./service-account-key.json');
        console.log('✅ [STARTUP] Firebase loaded from file.');
    } catch (e) {
        console.error('❌ [STARTUP] No Firebase credentials found.');
        process.exit(1);
    }
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ================================================================
// [3] HTTP Server + Socket.IO
// ================================================================
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 25000,
    pingTimeout: 60000,
    maxHttpBufferSize: 5e6 // 5 MB (للمصغرات)
});

// ================================================================
// [4] حالة النظام
// ================================================================
let fcmToken      = loadToken();
let lastHeartbeat = null;
let webhookActive = true;
let lastChatId    = null;

// pending jobs للملفات (تبقى للتوافق مع الكود القديم)
const pendingJobs = new Map();

// 🆕 خريطة الأجهزة المتصلة عبر Socket.IO
const androidSockets = new Map(); // deviceId → { socket, info }

// 🆕 خريطة الجلسات (web clients)
const webSessions = new Map();    // socket.id → { path, files }

// 🆕 Cache للمصغرات (path → { thumbnail, cachedAt })
const thumbCache = new Map();
const THUMB_CACHE_TTL_MS = 60 * 60 * 1000; // ساعة واحدة

if (fcmToken) console.log(`✅ [STARTUP] FCM Token: ${fcmToken.substring(0,20)}...`);

// ================================================================
// [5] دوال FCM Token
// ================================================================
function saveToken(t) {
    try { fs.writeFileSync(TOKEN_FILE, t, 'utf8'); } catch(e) {}
}
function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const t = fs.readFileSync(TOKEN_FILE,'utf8').trim();
            return t || null;
        }
    } catch(e) {}
    return null;
}

// ================================================================
// [6] Webhook Management
// ================================================================
async function reactivateWebhook() {
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: `${SERVER_URL}/webhook` })
        });
        const d = await r.json();
        if (d.ok) { webhookActive = true; console.log('🔗 [WEBHOOK] Reactivated'); }
        else console.error('❌ [WEBHOOK] Reactivate failed:', d);
    } catch(e) { console.error('❌ [WEBHOOK]', e.message); }
}

async function deleteWebhook() {
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
        const d = await r.json();
        if (d.ok) { webhookActive = false; console.log('🔓 [WEBHOOK] Deleted — Polling active'); }
    } catch(e) { console.error('❌ [WEBHOOK]', e.message); }
}

// ================================================================
// [7] مراقبة حالة التطبيق + تنظيف Cache
// ================================================================
setInterval(async () => {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 90000;
    if (!isAlive && !webhookActive) {
        console.log('💀 [MONITOR] App dead — reactivating webhook...');
        await reactivateWebhook();
        if (lastChatId) await sendTelegramMessage(lastChatId,
            '📵 انقطع الاتصال بالكاميرا\n🔗 Webhook أُعيد تفعيله\nأرسل /wake أو /capture');
    }
}, 60000);

// تنظيف Cache المصغرات كل 15 دقيقة
setInterval(() => {
    const now = Date.now();
    let deleted = 0;
    for (const [key, val] of thumbCache.entries()) {
        if (now - val.cachedAt > THUMB_CACHE_TTL_MS) {
            thumbCache.delete(key);
            deleted++;
        }
    }
    if (deleted > 0) console.log(`🧹 [CACHE] Cleaned ${deleted} thumbnails`);
}, 15 * 60 * 1000);

// ================================================================
// [8] Socket.IO — Heart of Real-time
// ================================================================
io.on('connection', (socket) => {
    console.log(`🔌 [SOCKET] Client connected: ${socket.id}`);

    // ─── تسجيل جهاز Android ───
    socket.on('android:register', (data) => {
        const deviceId = data.deviceId || socket.id;
        androidSockets.set(deviceId, {
            socket: socket,
            info: {
                deviceId: deviceId,
                deviceName: data.deviceName || 'Unknown',
                sdkVersion: data.sdkVersion || 0,
                connectedAt: Date.now()
            }
        });

        console.log(`✅ [ANDROID] Registered: ${deviceId} (${data.deviceName})`);

        // إرسال تأكيد
        socket.emit('android:registered', {
            status: 'ok',
            serverTime: Date.now(),
            activeSessions: webSessions.size
        });
    });

    // ─── Heartbeat من Android ───
    socket.on('android:heartbeat', (data) => {
        lastHeartbeat = Date.now();
        socket.emit('android:heartbeat-ack', { t: Date.now() });
    });

    // ─── قائمة الملفات من Android ───
    socket.on('android:list-result', (data) => {
        const { reqId, files } = data;
        const session = webSessions.get(reqId);
        if (session) {
            session.files = files;
            session.webSocket.emit('web:list-result', { reqId, files });
            console.log(`📋 [LIST] Sent ${files.length} items to web (reqId=${reqId})`);
        } else {
            console.warn(`⚠️ [LIST] No session for reqId=${reqId}`);
        }
    });

    // ─── دفعة مصغرات من Android ───
    socket.on('android:thumbs-batch', (data) => {
        const { reqId, thumbnails } = data;
        const session = webSessions.get(reqId);
        if (session) {
            // خزّن في Cache
            thumbnails.forEach(t => {
                thumbCache.set(t.path, {
                    thumbnail: t.thumbnail,
                    thumbnailMime: t.thumbnailMime || 'image/jpeg',
                    cachedAt: Date.now()
                });
            });

            // أرسل للواجهة
            session.webSocket.emit('web:thumbs-batch', { reqId, thumbnails });
            console.log(`🖼 [THUMBS] Sent ${thumbnails.length} thumbs (reqId=${reqId})`);
        }
    });

    // ─── ملف جاهز للتنزيل ───
    socket.on('android:file-ready', (data) => {
        const { reqId, downloadUrl, fileName, fileSize, mimeType } = data;
        const session = webSessions.get(reqId);
        if (session) {
            session.webSocket.emit('web:file-ready', {
                reqId, downloadUrl, fileName, fileSize, mimeType
            });
            console.log(`📥 [FILE-READY] ${fileName} (${(fileSize/1024).toFixed(1)} KB)`);
        }
    });

    // ─── خطأ من Android ───
    socket.on('android:error', (data) => {
        const { reqId, error } = data;
        const session = webSessions.get(reqId);
        if (session) {
            session.webSocket.emit('web:error', { reqId, error });
            console.error(`❌ [ERROR] ${error} (reqId=${reqId})`);
        }
    });

    // ─── تسجيل عميل ويب ───
    socket.on('web:register', (data) => {
        console.log(`✅ [WEB] Client registered: ${socket.id}`);
        socket.emit('web:registered', {
            status: 'ok',
            hasAndroid: androidSockets.size > 0,
            androidCount: androidSockets.size
        });
    });

    // ─── طلب قائمة مجلد من الويب ───
    socket.on('web:list', (data) => {
        const { path: reqPath, reqId } = data;

        // تخزين الجلسة
        webSessions.set(reqId, {
            webSocket: socket,
            path: reqPath,
            files: null,
            createdAt: Date.now()
        });

        // إرسال للأندرويد
        const android = getFirstAndroid();
        if (!android) {
            socket.emit('web:error', {
                reqId,
                error: 'لا يوجد جهاز Android متصل'
            });
            return;
        }

        android.socket.emit('web:list', { path: reqPath, reqId });
        console.log(`📂 [WEB→ANDROID] List request: ${reqPath} (reqId=${reqId})`);
    });

    // ─── طلب مصغرات محددة ───
    socket.on('web:thumbs', (data) => {
        const { paths, reqId } = data;
        const android = getFirstAndroid();
        if (android) {
            android.socket.emit('web:thumbs', { paths, reqId });
        }
    });

    // ─── طلب تنزيل ملف ───
    socket.on('web:download', (data) => {
        const { path: filePath, reqId } = data;

        webSessions.set(reqId, {
            webSocket: socket,
            path: filePath,
            type: 'download',
            createdAt: Date.now()
        });

        const android = getFirstAndroid();
        if (!android) {
            socket.emit('web:error', { reqId, error: 'لا يوجد جهاز متصل' });
            return;
        }

        android.socket.emit('web:download', { path: filePath, reqId });
        console.log(`📥 [WEB→ANDROID] Download: ${filePath} (reqId=${reqId})`);
    });

    // ─── فصل العميل ───
    socket.on('disconnect', () => {
        console.log(`🔌 [SOCKET] Client disconnected: ${socket.id}`);

        // حذف من الأجهزة
        for (const [deviceId, entry] of androidSockets.entries()) {
            if (entry.socket === socket) {
                androidSockets.delete(deviceId);
                console.log(`❌ [ANDROID] Unregistered: ${deviceId}`);
            }
        }

        // حذف من جلسات الويب
        for (const [reqId, session] of webSessions.entries()) {
            if (session.webSocket === socket) {
                webSessions.delete(reqId);
            }
        }
    });
});

// دالة مساعدة: أول جهاز أندرويد متصل
function getFirstAndroid() {
    for (const entry of androidSockets.values()) {
        if (entry.socket.connected) return entry;
    }
    return null;
}

// ================================================================
// [9] REST Endpoints
// ================================================================

// حفظ FCM Token
app.get('/saveToken', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    fcmToken = token;
    saveToken(token);
    console.log(`📲 [TOKEN] Saved: ${token.substring(0,20)}...`);
    res.json({ success: true });
});

// Heartbeat (HTTP — fallback)
app.get('/heartbeat', async (req, res) => {
    lastHeartbeat = Date.now();
    if (webhookActive) await deleteWebhook();
    res.json({ success: true });
});

// App alive (FCM wake)
app.get('/appAlive', async (req, res) => {
    lastHeartbeat = Date.now();
    if (webhookActive) {
        console.log('🚀 [APP_ALIVE] Deleting webhook...');
        await deleteWebhook();
        if (lastChatId) await sendTelegramMessage(lastChatId,
            '✅ تم إيقاظ الكاميرا!\n📡 Polling + WebSocket نشط');
    }
    res.json({ success: true });
});

// Ping
app.get('/ping', (req, res) => {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 90000;
    res.json({
        status: 'alive',
        app: isAlive ? '🟢 online' : '🔴 offline',
        webhookActive,
        hasToken: !!fcmToken,
        androidConnected: androidSockets.size,
        webSessions: webSessions.size,
        thumbCacheSize: thumbCache.size
    });
});

// ================================================================
// [10] Telegram Webhook (أوامر /wake وغيرها)
// ================================================================
app.post('/webhook', async (req, res) => {
    res.send('OK');
    try {
        const message = req.body.message;
        if (!message || !message.text) return;
        const chatId = message.chat.id.toString();
        const text   = message.text.toLowerCase().trim();
        lastChatId   = chatId;
        console.log(`📨 [WEBHOOK] "${text}" from ${chatId}`);

        if (!fcmToken && text !== '/status' && text !== '/help') {
            await sendTelegramMessage(chatId, '⚠ الجهاز لم يُسجَّل بعد.');
            return;
        }
        switch(text) {
            case '/wake': case '/start': await handleWake(chatId); break;
            case '/capture': case '/التقط': await handleCapture(chatId); break;
            case '/status': case '/الحالة': await handleStatus(chatId); break;
            case '/help': case '/مساعدة':
                await sendTelegramMessage(chatId,
                    '📋 الأوامر:\n/capture — التقاط صورة\n/wake — إيقاظ الكاميرا\n/status — الحالة');
                break;
        }
    } catch(e) { console.error('❌ [WEBHOOK]', e); }
});

// ================================================================
// [11] معالجة أوامر Telegram
// ================================================================
async function handleWake(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 90000;
    if (isAlive) {
        await sendTelegramMessage(chatId, '✅ الكاميرا تعمل بالفعل!');
        return;
    }
    try {
        await admin.messaging().send({
            token: fcmToken,
            data: { action: 'wake' },
            android: { priority: 'high' }
        });
        console.log('📤 [FCM] Sent: wake');
        await sendTelegramMessage(chatId, '⏳ جاري إيقاظ الكاميرا...');
    } catch(e) { await handleFcmError(chatId, e); }
}

async function handleCapture(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 90000;
    if (isAlive) return;
    try {
        await admin.messaging().send({
            token: fcmToken,
            data: { action: 'capture' },
            android: { priority: 'high' }
        });
        console.log('📤 [FCM] Sent: capture');
        await sendTelegramMessage(chatId, '📸 الكاميرا نائمة! جاري الإيقاظ...');
    } catch(e) { await handleFcmError(chatId, e); }
}

async function handleStatus(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 90000;
    const seen = lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString('ar-SA') : 'لم يتصل بعد';
    await sendTelegramMessage(chatId, isAlive
        ? `🟢 الكاميرا متصلة\nآخر اتصال: ${seen}\n📡 Polling + WebSocket نشط`
        : `🔴 الكاميرا غير متصلة\nآخر اتصال: ${seen}`);
}

async function handleFcmError(chatId, e) {
    console.error('❌ [FCM]', e.code, e.message);
    if (e.code === 'messaging/registration-token-not-registered') {
        fcmToken = null; saveToken('');
        await sendTelegramMessage(chatId, '❌ انتهت صلاحية التوكن.\nافتح التطبيق لتجديده.');
    } else {
        await sendTelegramMessage(chatId, '❌ فشل إيقاظ الجهاز.');
    }
}

// ================================================================
// [12] رفع الملفات (HTTP POST من الأندرويد)
// ================================================================
app.post('/api/fm/upload/:reqId',
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    (req, res) => {
        const { reqId } = req.params;
        const fileName = decodeURIComponent(req.headers['x-file-name'] || 'file');
        const mimeType = req.headers['x-file-mime'] || 'application/octet-stream';
        const fileLocalPath = path.join('/tmp', `fm_${reqId}_${fileName}`);

        try {
            fs.writeFileSync(fileLocalPath, req.body);

            // خزّن للاستخدام
            if (!pendingJobs.has(reqId)) {
                pendingJobs.set(reqId, {});
            }
            const job = pendingJobs.get(reqId);
            job.fileLocalPath = fileLocalPath;
            job.fileName = fileName;
            job.mimeType = mimeType;
            job.fileSize = req.body.length;
            job.createdAt = Date.now();

            console.log(`✅ [UPLOAD] ${fileName} (${(req.body.length/1024).toFixed(1)} KB)`);
            res.json({ success: true });
        } catch(e) {
            console.error('❌ [UPLOAD]', e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

// ================================================================
// [13] تنزيل الملفات (HTTP GET)
// ================================================================
app.get('/api/fm/serve/:reqId', (req, res) => {
    const { pwd, inline } = req.query;
    if (pwd !== WEB_PASSWORD) return res.status(403).send('Unauthorized');

    const job = pendingJobs.get(req.params.reqId);
    if (!job || !job.fileLocalPath) return res.status(404).send('File not found');
    if (!fs.existsSync(job.fileLocalPath)) return res.status(404).send('File expired');

    const disposition = inline === '1' ? 'inline' : 'attachment';
    const safeFileName = encodeURIComponent(job.fileName);
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${safeFileName}`);
    res.setHeader('Content-Type', job.mimeType || 'application/octet-stream');
    res.sendFile(job.fileLocalPath, (err) => {
        // حذف بعد 30 ثانية (نافذة إضافية للمتصفح)
        setTimeout(() => {
            try { fs.unlinkSync(job.fileLocalPath); } catch(e) {}
            pendingJobs.delete(req.params.reqId);
        }, 30000);
    });
});

// ================================================================
// [14] Telegram Helper
// ================================================================
async function sendTelegramMessage(chatId, text) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
        });
        if (!r.ok) console.error('❌ [TELEGRAM]', await r.text());
    } catch(e) { console.error('❌ [TELEGRAM]', e.message); }
}

// ================================================================
// [15] صفحة الويب الرئيسية
// ================================================================
app.get('/files', (req, res) => {
    const pwd = req.query.pwd;

    // صفحة تسجيل الدخول
    if (pwd !== WEB_PASSWORD) {
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>تسجيل الدخول</title>
<style>body{background:#0f0f23;color:#fff;font-family:system-ui;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#1a1a3e;padding:32px;border-radius:16px;text-align:center;width:90%;max-width:360px}
h2{margin:0 0 24px;color:#7c83fd}input{width:100%;padding:12px;border-radius:8px;
border:1px solid #444;background:#0f0f23;color:#fff;font-size:16px;box-sizing:border-box}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#7c83fd;
color:#fff;font-size:16px;cursor:pointer;margin-top:12px}
</style></head><body><div class="box"><h2>🔒 مدير الملفات</h2>
<form onsubmit="login(event)">
<input type="password" id="pwd" placeholder="كلمة المرور" autofocus>
<button type="submit">دخول</button></form></div>
<script>function login(e){e.preventDefault();
const p=document.getElementById('pwd').value;
window.location.href='/files?pwd='+encodeURIComponent(p);}</script>
</body></html>`);
    }

    // الصفحة الرئيسية
    res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>مدير الملفات</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f23;color:#e0e0e0;font-family:system-ui,sans-serif}
.header{background:#1a1a3e;padding:16px;display:flex;align-items:center;gap:12px;
position:sticky;top:0;z-index:100;border-bottom:1px solid #2a2a5e}
.header h1{font-size:18px;color:#7c83fd;flex:1}
.status-badge{font-size:12px;padding:4px 10px;border-radius:12px;background:#333}
.status-badge.online{background:#1B5E20;color:#4CAF50}
.status-badge.offline{background:#B71C1C;color:#FF5252}
.breadcrumb{background:#13132b;padding:10px 16px;font-size:13px;
display:flex;gap:4px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #2a2a5e}
.breadcrumb span{color:#7c83fd;cursor:pointer;text-decoration:underline}
.breadcrumb span:hover{color:#a0a7ff}
.sep{color:#555}

.content{padding:16px}
.file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}

.card{background:#1a1a3e;border-radius:10px;overflow:hidden;
transition:transform .15s,box-shadow .15s;cursor:pointer}
.card:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(124,131,253,.3)}
.card .thumb{width:100%;aspect-ratio:1;background:#13132b;
display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.card .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.card .thumb .placeholder{font-size:48px;color:#444}
.card .thumb .loading{position:absolute;inset:0;display:flex;align-items:center;
justify-content:center;background:#13132b}
.spinner{width:24px;height:24px;border:3px solid #333;border-top-color:#7c83fd;
border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.card .info{padding:8px 10px}
.card .name{font-size:12px;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis;color:#e0e0e0;margin-bottom:4px}
.card .meta{font-size:11px;color:#777}
.card .actions{display:flex;gap:4px;padding:0 10px 10px}
.card button{flex:1;background:#7c83fd;color:#fff;border:none;
padding:6px;border-radius:6px;cursor:pointer;font-size:11px}
.card button:hover{background:#a0a7ff}
.card button.dl{background:#4CAF50}
.card button.dl:hover{background:#66BB6A}
.card.folder .thumb{background:linear-gradient(135deg,#1a1a3e,#2a2a5e)}
.card.folder .thumb .placeholder{color:#7c83fd}

/* Lightbox */
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.95);
display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}
.lightbox.active{display:flex}
.lightbox img{max-width:100%;max-height:90vh;border-radius:8px;
box-shadow:0 10px 50px rgba(0,0,0,.5)}
.lightbox .close{position:absolute;top:20px;left:20px;background:#fff;
color:#000;border:none;width:40px;height:40px;border-radius:50%;
cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center}
.lightbox .dl-full{position:absolute;bottom:30px;left:50%;transform:translateX(-50%);
background:#4CAF50;color:#fff;border:none;padding:12px 24px;
border-radius:25px;cursor:pointer;font-size:14px;display:flex;gap:8px;align-items:center}
.lightbox .dl-full:hover{background:#66BB6A}

.status-bar{position:fixed;bottom:0;left:0;right:0;background:#13132b;
padding:8px 16px;font-size:12px;color:#777;border-top:1px solid #2a2a5e;z-index:50}
.loading-overlay{text-align:center;padding:60px;color:#7c83fd}
.empty{text-align:center;padding:60px;color:#555;font-size:16px}
.error-msg{text-align:center;padding:40px;color:#ff6b6b}
</style></head><body>

<div class="header">
  <span style="font-size:24px">📁</span>
  <h1>مدير الملفات</h1>
  <span class="status-badge" id="statusBadge">جاري الاتصال...</span>
</div>

<div class="breadcrumb" id="breadcrumb"></div>
<div class="content" id="content">
  <div class="loading-overlay">⏳ جاري التحميل...</div>
</div>

<div class="status-bar" id="statusBar">جاهز</div>

<!-- Lightbox -->
<div class="lightbox" id="lightbox" onclick="if(event.target.id==='lightbox')closeLightbox()">
  <button class="close" onclick="closeLightbox()">✕</button>
  <img id="lightboxImg" src="" alt="preview">
  <button class="dl-full" id="lightboxDl">⬇ تنزيل بالحجم الكامل</button>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const PWD = '${pwd}';
const SERVER_URL = window.location.origin;

let currentPath = '/sdcard';
let pathHistory = [];
let currentFiles = []; // الملفات الحالية
let socket = null;

// ═══════════════════════════════════════════════
// Socket.IO
// ═══════════════════════════════════════════════
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('✅ WebSocket connected');
        socket.emit('web:register', {});
    });

    socket.on('web:registered', (data) => {
        updateStatusBadge(data.hasAndroid);
    });

    socket.on('disconnect', () => {
        console.log('❌ WebSocket disconnected');
        updateStatusBadge(false);
    });

    socket.on('web:list-result', (data) => {
        if (data.reqId === currentReqId) {
            currentFiles = data.files;
            renderFiles(data.files);
        }
    });

    socket.on('web:thumbs-batch', (data) => {
        // تحديث المصغرات في البطاقات
        data.thumbnails.forEach(t => {
            const img = document.querySelector(\`img[data-path="\${CSS.escape(t.path)}"]\`);
            if (img) {
                img.src = \`data:\${t.thumbnailMime};base64,\${t.thumbnail}\`;
                img.classList.add('loaded');
                // إزالة الـ spinner
                const loading = img.parentElement.querySelector('.loading');
                if (loading) loading.remove();
            }
        });
    });

    socket.on('web:file-ready', (data) => {
        // افتح التنزيل
        const a = document.createElement('a');
        a.href = \`\${data.downloadUrl}?pwd=\${encodeURIComponent(PWD)}\`;
        a.download = data.fileName;
        a.click();
        setStatus(\`✅ تم تجهيز: \${data.fileName}\`);
    });

    socket.on('web:error', (data) => {
        setError(data.error);
    });

    // فحص الحالة كل 15 ثانية
    setInterval(checkStatus, 15000);
}

function updateStatusBadge(isOnline) {
    const badge = document.getElementById('statusBadge');
    if (isOnline) {
        badge.textContent = '🟢 متصل';
        badge.className = 'status-badge online';
    } else {
        badge.textContent = '🔴 غير متصل';
        badge.className = 'status-badge offline';
    }
}

async function checkStatus() {
    try {
        const r = await fetch('/ping');
        const d = await r.json();
        updateStatusBadge(d.androidConnected > 0);
    } catch(e) {}
}

// ═══════════════════════════════════════════════
// التنقل
// ═══════════════════════════════════════════════
function navigate(p) {
    if (currentPath !== p) pathHistory.push(currentPath);
    currentPath = p;
    updateBreadcrumb();
    loadFiles(p);
}

function goBack() {
    if (pathHistory.length > 0) {
        currentPath = pathHistory.pop();
        updateBreadcrumb();
        loadFiles(currentPath);
    }
}

function updateBreadcrumb() {
    const el = document.getElementById('breadcrumb');
    const parts = currentPath.split('/').filter(Boolean);
    let html = '<span onclick="navigate(\\'/sdcard\\')">🏠 الرئيسية</span>';
    let built = '';
    for(const p of parts) {
        built += '/' + p;
        const captured = built;
        html += '<span class="sep"> › </span>';
        html += \`<span onclick="navigate('\${captured}')">\${p}</span>\`;
    }
    el.innerHTML = html;
}

// ═══════════════════════════════════════════════
// تحميل القائمة
// ═══════════════════════════════════════════════
let currentReqId = null;

function loadFiles(dirPath) {
    if (!socket || !socket.connected) {
        setError('لا يوجد اتصال بالسيرفر');
        return;
    }

    const reqId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    currentReqId = reqId;

    setContent('<div class="loading-overlay">⏳ جاري طلب القائمة من الجهاز...</div>');
    setStatus('إرسال الطلب...');

    socket.emit('web:list', { path: dirPath, reqId });
}

// ═══════════════════════════════════════════════
// عرض الملفات
// ═══════════════════════════════════════════════
function renderFiles(files) {
    if (!files || files.length === 0) {
        setContent('<div class="empty">📂 المجلد فارغ</div>');
        setStatus('فارغ');
        return;
    }

    const sorted = [...files].sort((a,b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
    });

    let html = '<div class="file-grid">';

    // زر رجوع
    if (currentPath !== '/sdcard' && pathHistory.length > 0) {
        html += \`<div class="card folder" onclick="goBack()">
            <div class="thumb"><div class="placeholder">⬅</div></div>
            <div class="info"><div class="name">رجوع</div>
            <div class="meta">المجلد السابق</div></div>
        </div>\`;
    }

    for (const f of sorted) {
        const fullPath = currentPath.replace(/\\/+$/, '') + '/' + f.name;
        const escapedPath = fullPath.replace(/'/g, "\\\\'");
        const escapedPathAttr = fullPath.replace(/"/g, '&quot;');

        if (f.isDir) {
            html += \`<div class="card folder" onclick="navigate('\${escapedPath}')">
                <div class="thumb"><div class="placeholder">📁</div></div>
                <div class="info">
                    <div class="name" title="\${escAttr(f.name)}">\${esc(f.name)}</div>
                    <div class="meta">\${f.children || 0} عنصر</div>
                </div>
            </div>\`;
        } else if (f.isImage) {
            html += \`<div class="card">
                <div class="thumb" onclick="openLightbox('\${escapedPath}')">
                    <div class="loading"><div class="spinner"></div></div>
                    <img data-path="\${escAttr(fullPath)}" src="" alt="\${escAttr(f.name)}" style="display:none" onload="this.style.display='block'">
                </div>
                <div class="info">
                    <div class="name" title="\${escAttr(f.name)}">\${esc(f.name)}</div>
                    <div class="meta">\${formatSize(f.size)}</div>
                </div>
                <div class="actions">
                    <button onclick="event.stopPropagation();downloadFile('\${escapedPath}','\${escAttr(f.name)}')">⬇ تنزيل</button>
                </div>
            </div>\`;
        } else {
            html += \`<div class="card">
                <div class="thumb"><div class="placeholder">📄</div></div>
                <div class="info">
                    <div class="name" title="\${escAttr(f.name)}">\${esc(f.name)}</div>
                    <div class="meta">\${formatSize(f.size)}</div>
                </div>
                <div class="actions">
                    <button class="dl" onclick="downloadFile('\${escapedPath}','\${escAttr(f.name)}')">⬇ تنزيل</button>
                </div>
            </div>\`;
        }
    }

    html += '</div>';
    setContent(html);
    setStatus(\`✅ \${files.length} عنصر\`);
}

// ═══════════════════════════════════════════════
// Lightbox
// ═══════════════════════════════════════════════
let currentLightboxPath = null;
let currentLightboxName = null;

function openLightbox(path) {
    const img = document.querySelector(\`img[data-path="\${CSS.escape(path)}"]\`);
    if (!img || !img.src || !img.src.startsWith('data:')) {
        alert('المصغرة لم تُحمَّل بعد');
        return;
    }

    document.getElementById('lightboxImg').src = img.src;
    document.getElementById('lightbox').classList.add('active');

    currentLightboxPath = path;
    currentLightboxName = path.split('/').pop();

    document.getElementById('lightboxDl').onclick = () => {
        downloadFile(path, currentLightboxName);
        closeLightbox();
    };
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
    document.getElementById('lightboxImg').src = '';
}

// ═══════════════════════════════════════════════
// تنزيل ملف
// ═══════════════════════════════════════════════
function downloadFile(path, name) {
    if (!socket || !socket.connected) {
        alert('لا يوجد اتصال');
        return;
    }

    const reqId = 'dl_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    setStatus(\`📥 جاري تجهيز: \${name}...\`);
    socket.emit('web:download', { path, reqId });
}

// ═══════════════════════════════════════════════
// دوال مساعدة
// ═══════════════════════════════════════════════
function setContent(html) { document.getElementById('content').innerHTML = html; }
function setStatus(msg)   { document.getElementById('statusBar').textContent = msg; }
function setError(msg) {
    setContent(\`<div class="error-msg">⚠ \${msg}<br><br>
        <button onclick="loadFiles(currentPath)"
        style="background:#7c83fd;color:#fff;border:none;padding:8px 16px;
        border-radius:8px;cursor:pointer">إعادة المحاولة</button></div>\`);
    setStatus('خطأ');
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B','KB','MB','GB'];
    let i = 0; let b = bytes;
    while(b >= 1024 && i < units.length-1) { b /= 1024; i++; }
    return b.toFixed(1) + ' ' + units[i];
}

// ═══════════════════════════════════════════════
// بدء التشغيل
// ═══════════════════════════════════════════════
initSocket();
updateBreadcrumb();
setTimeout(() => loadFiles(currentPath), 800);
</script>
</body></html>`);
});

// ================================================================
// [16] تشغيل السيرفر
// ================================================================
server.listen(PORT, async () => {
    console.log('══════════════════════════════════════════');
    console.log(`✅ Server + Socket.IO on port ${PORT}`);
    console.log(`🌐 ${SERVER_URL}`);
    console.log(`📁 File Manager: ${SERVER_URL}/files`);
    console.log(`📡 Webhook: ${SERVER_URL}/webhook`);
    console.log('══════════════════════════════════════════');
    console.log('🔄 Activating webhook on startup...');
    await reactivateWebhook();
});
