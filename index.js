cat > /mnt/user-data/outputs/parental-control/index.js << 'ENDOFFILE'
// ╔══════════════════════════════════════════════════════════════════╗
// ║        index.js — سيرفر كاميرا المراقبة + مدير الملفات          ║
// ╚══════════════════════════════════════════════════════════════════╝

const express = require('express');
const admin   = require('firebase-admin');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ================================================================
// [1] متغيرات البيئة
// ================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SERVER_URL  = process.env.SERVER_URL  || 'https://zainzzzzz-production.up.railway.app';
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'admin123'; // ← غيّره في Railway
const PORT        = process.env.PORT || 3000;
const TOKEN_FILE  = path.join('/tmp', 'fcm_token.txt');

if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ [STARTUP] Missing TELEGRAM_BOT_TOKEN');
    process.exit(1);
}

// ================================================================
// [2] تهيئة Firebase
// ================================================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        console.log('✅ [STARTUP] Firebase loaded from env.');
    } catch (e) {
        console.error('❌ [STARTUP] Firebase parse error:', e.message);
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
// [3] حالة النظام
// ================================================================
let fcmToken      = loadToken();
let lastHeartbeat = null;
let webhookActive = true;
let lastChatId    = null;

// نظام الوظائف (Jobs) — كل طلب للملفات يصبح وظيفة بمعرّف فريد
// البنية: jobId → { status, result, filePath, fileName, mimeType, fileSize, createdAt }
const pendingJobs = new Map();

if (fcmToken) console.log(`✅ [STARTUP] FCM Token: ${fcmToken.substring(0,20)}...`);

// ================================================================
// [4] دوال FCM Token
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
// [5] إدارة Webhook
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

// مراقبة حالة التطبيق كل 60 ثانية
setInterval(async () => {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    if (!isAlive && !webhookActive) {
        console.log('💀 [MONITOR] App dead — reactivating webhook...');
        await reactivateWebhook();
        if (lastChatId) await sendTelegramMessage(lastChatId,
            '📵 انقطع الاتصال بالكاميرا\n🔗 Webhook أُعيد تفعيله\nأرسل /wake أو /capture');
    }
}, 60000);

// ================================================================
// [6] تنظيف وظائف الملفات المنتهية (كل دقيقة)
// ================================================================
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of pendingJobs.entries()) {
        if (now - job.createdAt > 5 * 60 * 1000) { // بعد 5 دقائق
            if (job.filePath) try { fs.unlinkSync(job.filePath); } catch(e) {}
            pendingJobs.delete(jobId);
            console.log(`🗑 [JOBS] Cleaned up job: ${jobId}`);
        }
    }
}, 60000);

// ================================================================
// [7] دالة إنشاء وظيفة جديدة
// ================================================================
function createJob(action, filePath) {
    const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    pendingJobs.set(jobId, {
        action, filePath,
        status: 'pending',
        result: null,
        fileLocalPath: null,
        fileName: null,
        mimeType: null,
        fileSize: 0,
        createdAt: Date.now()
    });
    // timeout تلقائي بعد 30 ثانية
    setTimeout(() => {
        const job = pendingJobs.get(jobId);
        if (job && job.status === 'pending') {
            job.status = 'timeout';
            console.warn(`⏰ [JOBS] Job timeout: ${jobId}`);
        }
    }, 30000);
    return jobId;
}

// ================================================================
// [8] حفظ FCM Token
// ================================================================
app.get('/saveToken', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    fcmToken = token;
    saveToken(token);
    console.log(`📲 [TOKEN] Saved: ${token.substring(0,20)}...`);
    res.json({ success: true });
});

// ================================================================
// [9] Heartbeat
// ================================================================
app.get('/heartbeat', async (req, res) => {
    lastHeartbeat = Date.now();
    if (webhookActive) {
        console.log('💓 [HEARTBEAT] App alive — deleting webhook...');
        await deleteWebhook();
    }
    res.json({ success: true });
});

// ================================================================
// [10] appAlive — التطبيق استيقظ عبر FCM
// ================================================================
app.get('/appAlive', async (req, res) => {
    lastHeartbeat = Date.now();
    if (webhookActive) {
        console.log('🚀 [APP_ALIVE] Woke via FCM — deleting webhook...');
        await deleteWebhook();
        if (lastChatId) await sendTelegramMessage(lastChatId,
            '✅ تم إيقاظ الكاميرا!\n🔓 Webhook محذوف\n📡 Polling نشط\nيمكنك إرسال /capture أو /status');
    }
    res.json({ success: true });
});

// ================================================================
// [11] Ping
// ================================================================
app.get('/ping', (req, res) => {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    res.json({ status: 'alive', app: isAlive ? '🟢 online' : '🔴 offline', webhookActive, hasToken: !!fcmToken });
});

// ================================================================
// [12] Webhook — أوامر Telegram
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
            await sendTelegramMessage(chatId, '⚠ الجهاز لم يُسجَّل بعد.\nافتح التطبيق مرة واحدة أولاً.');
            return;
        }
        switch(text) {
            case '/wake': case '/start': await handleWake(chatId); break;
            case '/capture': case '/التقط': await handleCapture(chatId); break;
            case '/status': case '/الحالة': await handleStatus(chatId); break;
            case '/help': case '/مساعدة':
                await sendTelegramMessage(chatId,
                    '📋 الأوامر:\n/capture — التقاط صورة\n/wake — إيقاظ الكاميرا\n/status — الحالة\n/help — المساعدة');
                break;
            default:
                await sendTelegramMessage(chatId, '❓ أمر غير معروف. أرسل /help');
        }
    } catch(e) { console.error('❌ [WEBHOOK]', e); }
});

// ================================================================
// [13] معالجة الأوامر
// ================================================================
async function handleWake(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    if (isAlive) { await sendTelegramMessage(chatId, '✅ الكاميرا تعمل بالفعل!'); return; }
    try {
        await admin.messaging().send({ token: fcmToken, data: { action: 'wake' }, android: { priority: 'high' } });
        console.log('📤 [FCM] Sent: wake');
        await sendTelegramMessage(chatId, '⏳ جاري إيقاظ الكاميرا...\nستصلك رسالة تأكيد.');
    } catch(e) { await handleFcmError(chatId, e); }
}

async function handleCapture(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    if (isAlive) return; // يُعالَج بالـ Polling مباشرة
    try {
        await admin.messaging().send({ token: fcmToken, data: { action: 'capture' }, android: { priority: 'high' } });
        console.log('📤 [FCM] Sent: capture');
        await sendTelegramMessage(chatId, '📸 الكاميرا نائمة!\n⏳ جاري الإيقاظ والتقاط الصورة...');
    } catch(e) { await handleFcmError(chatId, e); }
}

async function handleStatus(chatId) {
    const isAlive = lastHeartbeat && (Date.now() - lastHeartbeat) < 60000;
    const seen = lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString('ar-SA') : 'لم يتصل بعد';
    await sendTelegramMessage(chatId, isAlive
        ? `🟢 الكاميرا متصلة\nآخر اتصال: ${seen}\n📡 Polling نشط`
        : `🔴 الكاميرا غير متصلة\nآخر اتصال: ${seen}\n🔗 Webhook نشط\nأرسل /wake`);
}

async function handleFcmError(chatId, e) {
    console.error('❌ [FCM]', e.code, e.message);
    if (e.code === 'messaging/registration-token-not-registered') {
        fcmToken = null; saveToken('');
        await sendTelegramMessage(chatId, '❌ انتهت صلاحية التوكن.\nافتح التطبيق لتجديده.');
    } else {
        await sendTelegramMessage(chatId, '❌ فشل إيقاظ الجهاز. تأكد من الإنترنت.');
    }
}

// ================================================================
// [14] ═══════════════ مدير الملفات ═══════════════
// ================================================================

// دالة مساعدة: إرسال FCM لطلب ملفات مع jobId
async function sendFileRequest(action, filePath, jobId) {
    await admin.messaging().send({
        token: fcmToken,
        data: { action, path: filePath, jobId },
        android: { priority: 'high' }
    });
    console.log(`📤 [FILES] FCM sent: action=${action} path=${filePath} job=${jobId}`);
}

// ─────────────────────────────────────────────
// واجهة الويب — صفحة مدير الملفات
// ─────────────────────────────────────────────
app.get('/files', (req, res) => {
    const pwd = req.query.pwd;
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

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>مدير الملفات</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f23;color:#e0e0e0;font-family:system-ui;direction:rtl}
.header{background:#1a1a3e;padding:16px;display:flex;align-items:center;gap:12px;
position:sticky;top:0;z-index:10;border-bottom:1px solid #2a2a5e}
.header h1{font-size:18px;color:#7c83fd}
.breadcrumb{background:#13132b;padding:10px 16px;font-size:13px;
display:flex;gap:4px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #2a2a5e}
.breadcrumb span{color:#7c83fd;cursor:pointer;text-decoration:underline}
.breadcrumb span:hover{color:#a0a7ff}
.sep{color:#555}
.loading{text-align:center;padding:60px;color:#7c83fd;font-size:18px}
.error{text-align:center;padding:40px;color:#ff6b6b}
.file-list{padding:8px}
.file-item{display:flex;align-items:center;gap:12px;padding:12px 16px;
border-radius:10px;cursor:pointer;transition:background .15s;margin:2px 0}
.file-item:hover{background:#1a1a3e}
.icon{font-size:24px;width:36px;text-align:center;flex-shrink:0}
.info{flex:1;min-width:0}
.name{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis;color:#e0e0e0}
.meta{font-size:12px;color:#777;margin-top:2px}
.dl-btn{background:#7c83fd;color:#fff;border:none;border-radius:6px;
padding:6px 12px;cursor:pointer;font-size:12px;flex-shrink:0;white-space:nowrap}
.dl-btn:hover{background:#a0a7ff}
.dl-btn:disabled{background:#444;cursor:not-allowed}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #fff;
border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.status-bar{background:#13132b;padding:8px 16px;font-size:12px;color:#777;
border-top:1px solid #2a2a5e;position:fixed;bottom:0;width:100%}
.empty{text-align:center;padding:60px;color:#555;font-size:16px}
</style></head><body>

<div class="header">
  <span style="font-size:24px">📁</span>
  <h1>مدير الملفات</h1>
  <span id="app-status" style="margin-right:auto;font-size:12px;color:#777">جاري الاتصال...</span>
</div>

<div class="breadcrumb" id="breadcrumb"></div>

<div id="content"><div class="loading">⏳ جاري تحميل الملفات...</div></div>

<div class="status-bar" id="status-bar">جاهز</div>

<script>
const PWD = '${pwd}';
let currentPath = '/sdcard';
let pathHistory = [];

// ─── فحص حالة التطبيق ───
async function checkAppStatus() {
    try {
        const r = await fetch('/ping');
        const d = await r.json();
        const el = document.getElementById('app-status');
        el.textContent = d.app + (d.webhookActive ? ' • Webhook' : ' • Polling');
    } catch(e) {}
}
checkAppStatus();
setInterval(checkAppStatus, 15000);

// ─── التنقل ───
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
        html += '<span onclick="navigate(\\'' + captured + '\\')">' + p + '</span>';
    }
    el.innerHTML = html;
}

// ─── تحميل قائمة الملفات ───
async function loadFiles(dirPath) {
    setContent('<div class="loading">⏳ جاري طلب القائمة من الجهاز...</div>');
    setStatus('إرسال أمر لـ Android...');
    try {
        // 1. اطلب من السيرفر إرسال FCM
        const r = await fetch('/api/fm/ls?path=' + encodeURIComponent(dirPath) + '&pwd=' + encodeURIComponent(PWD));
        if (!r.ok) { setError('فشل طلب القائمة: ' + r.status); return; }
        const { jobId, error } = await r.json();
        if (error) { setError(error); return; }

        setStatus('في انتظار رد الجهاز... (jobId: ' + jobId + ')');

        // 2. استطلع النتيجة
        const result = await pollJob(jobId, 'قائمة الملفات');
        if (!result) return;

        renderFiles(result);
    } catch(e) { setError('خطأ: ' + e.message); }
}

// ─── استطلاع نتيجة الوظيفة ───
async function pollJob(jobId, label) {
    const timeout = Date.now() + 30000;
    while (Date.now() < timeout) {
        await sleep(1200);
        try {
            const r = await fetch('/api/fm/poll/' + jobId);
            const job = await r.json();
            if (job.status === 'done') return job.result;
            if (job.status === 'timeout') { setError('انتهت مهلة الانتظار — الجهاز لا يستجيب'); return null; }
            if (job.status === 'error')   { setError('خطأ من الجهاز: ' + job.result); return null; }
            setStatus('انتظار ' + label + '... ' + Math.round((timeout - Date.now()) / 1000) + 'ث');
        } catch(e) {}
    }
    setError('انتهت مهلة الانتظار');
    return null;
}

// ─── عرض الملفات ───
function renderFiles(files) {
    if (!files || files.length === 0) {
        setContent('<div class="empty">📂 المجلد فارغ</div>');
        setStatus('جاهز — ' + currentPath);
        return;
    }

    const sorted = [...files].sort((a,b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
    });

    let html = '<div class="file-list">';
    if (pathHistory.length > 0 || currentPath !== '/sdcard') {
        html += '<div class="file-item" onclick="goBack()"><div class="icon">⬅</div>'
              + '<div class="info"><div class="name">رجوع</div></div></div>';
    }
    for (const f of sorted) {
        const icon = f.isDir ? '📁' : getIcon(f.name, f.mimeType);
        const meta = f.isDir ? (f.children + ' عنصر') : formatSize(f.size);
        const fullPath = currentPath.replace(/\\/+$/, '') + '/' + f.name;
        const escapedPath = fullPath.replace(/'/g, "\\'");
        const escapedName = f.name.replace(/'/g, "\\'");

        if (f.isDir) {
            html += '<div class="file-item" onclick="navigate(\\'' + escapedPath + '\\')">'
                  + '<div class="icon">' + icon + '</div>'
                  + '<div class="info"><div class="name">' + esc(f.name) + '</div>'
                  + '<div class="meta">' + meta + '</div></div></div>';
        } else {
            html += '<div class="file-item">'
                  + '<div class="icon">' + icon + '</div>'
                  + '<div class="info"><div class="name">' + esc(f.name) + '</div>'
                  + '<div class="meta">' + meta + '</div></div>'
                  + '<button class="dl-btn" id="dl-' + esc(f.name) + '" onclick="downloadFile(\\'' + escapedPath + '\\', \\'' + escapedName + '\\', this)">⬇ تنزيل</button>'
                  + '</div>';
        }
    }
    html += '</div>';
    setContent(html);
    setStatus('✅ ' + files.length + ' عنصر في ' + currentPath);
}

// ─── تنزيل ملف ───
async function downloadFile(filePath, fileName, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    setStatus('طلب تنزيل: ' + fileName + '...');
    try {
        const r = await fetch('/api/fm/download?path=' + encodeURIComponent(filePath) + '&pwd=' + encodeURIComponent(PWD));
        if (!r.ok) { alert('فشل الطلب'); btn.disabled=false; btn.textContent='⬇ تنزيل'; return; }
        const { jobId, error } = await r.json();
        if (error) { alert(error); btn.disabled=false; btn.textContent='⬇ تنزيل'; return; }

        setStatus('في انتظار رفع الملف من الجهاز...');
        const result = await pollJob(jobId, 'تنزيل الملف');
        if (!result) { btn.disabled=false; btn.textContent='⬇ تنزيل'; return; }

        // تنزيل الملف من السيرفر
        const a = document.createElement('a');
        a.href = '/api/fm/serve/' + jobId + '?pwd=' + encodeURIComponent(PWD);
        a.download = fileName;
        a.click();
        setStatus('✅ تم تنزيل: ' + fileName);
        btn.disabled=false; btn.textContent='⬇ تنزيل';
    } catch(e) {
        alert('خطأ: ' + e.message);
        btn.disabled=false; btn.textContent='⬇ تنزيل';
    }
}

// ─── دوال مساعدة ───
function setContent(html) { document.getElementById('content').innerHTML = html; }
function setStatus(msg)   { document.getElementById('status-bar').textContent = msg; }
function setError(msg) {
    setContent('<div class="error">⚠ ' + msg + '<br><br><button onclick="loadFiles(currentPath)" style="background:#7c83fd;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer">إعادة المحاولة</button></div>');
    setStatus('خطأ: ' + msg);
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B','KB','MB','GB'];
    let i = 0; let b = bytes;
    while(b >= 1024 && i < units.length-1) { b /= 1024; i++; }
    return b.toFixed(1) + ' ' + units[i];
}
function getIcon(name, mime) {
    const ext = name.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) return '🖼';
    if (['mp4','mkv','avi','mov','3gp','webm'].includes(ext)) return '🎬';
    if (['mp3','aac','ogg','wav','flac','m4a'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📄';
    if (['doc','docx'].includes(ext)) return '📝';
    if (['xls','xlsx','csv'].includes(ext)) return '📊';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return '🗜';
    if (['apk'].includes(ext)) return '📦';
    if (['txt','log'].includes(ext)) return '📃';
    return '📄';
}

// ─── تحميل أولي ───
updateBreadcrumb();
loadFiles(currentPath);
</script></body></html>`);
});

// ─────────────────────────────────────────────
// API: طلب قائمة الملفات → إرسال FCM للجهاز
// ─────────────────────────────────────────────
app.get('/api/fm/ls', async (req, res) => {
    const { path: reqPath, pwd } = req.query;
    if (pwd !== WEB_PASSWORD) return res.status(403).json({ error: 'كلمة المرور خاطئة' });
    if (!fcmToken) return res.status(503).json({ error: 'الجهاز لم يُسجَّل بعد' });
    if (!reqPath) return res.status(400).json({ error: 'المسار مطلوب' });

    const jobId = createJob('ls', reqPath);
    try {
        await sendFileRequest('ls', reqPath, jobId);
        console.log(`📂 [FILES] LS request: ${reqPath} → job ${jobId}`);
        res.json({ jobId });
    } catch(e) {
        pendingJobs.delete(jobId);
        console.error('❌ [FILES] FCM send failed:', e.message);
        res.status(500).json({ error: 'فشل إرسال الأمر للجهاز: ' + e.message });
    }
});

// ─────────────────────────────────────────────
// API: طلب تنزيل ملف → إرسال FCM للجهاز
// ─────────────────────────────────────────────
app.get('/api/fm/download', async (req, res) => {
    const { path: reqPath, pwd } = req.query;
    if (pwd !== WEB_PASSWORD) return res.status(403).json({ error: 'كلمة المرور خاطئة' });
    if (!fcmToken) return res.status(503).json({ error: 'الجهاز لم يُسجَّل بعد' });
    if (!reqPath) return res.status(400).json({ error: 'المسار مطلوب' });

    const jobId = createJob('download', reqPath);
    try {
        await sendFileRequest('download', reqPath, jobId);
        console.log(`📥 [FILES] Download request: ${reqPath} → job ${jobId}`);
        res.json({ jobId });
    } catch(e) {
        pendingJobs.delete(jobId);
        res.status(500).json({ error: 'فشل إرسال الأمر للجهاز: ' + e.message });
    }
});

// ─────────────────────────────────────────────
// API: استطلاع نتيجة الوظيفة (المتصفح يستطلع هنا)
// ─────────────────────────────────────────────
app.get('/api/fm/poll/:jobId', (req, res) => {
    const job = pendingJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ status: 'not_found' });
    res.json({ status: job.status, result: job.result });
});

// ─────────────────────────────────────────────
// API: Android يرسل قائمة الملفات (JSON)
// ─────────────────────────────────────────────
app.post('/api/fm/result/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = pendingJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    job.status = 'done';
    job.result = req.body; // مصفوفة JSON بالملفات
    console.log(`✅ [FILES] LS result received for job ${jobId}: ${Array.isArray(req.body) ? req.body.length : '?'} items`);
    res.json({ success: true });
});

// ─────────────────────────────────────────────
// API: Android يرفع الملف (Binary)
//      Android يرسل الملف كـ raw binary مع headers:
//      Content-Type: application/octet-stream
//      X-File-Name: اسم الملف
//      X-File-Mime: نوع الملف
// ─────────────────────────────────────────────
app.post('/api/fm/upload/:jobId',
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    (req, res) => {
        const { jobId } = req.params;
        const job = pendingJobs.get(jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const fileName = req.headers['x-file-name'] || 'file';
        const mimeType = req.headers['x-file-mime'] || 'application/octet-stream';
        const fileLocalPath = path.join('/tmp', `fm_${jobId}_${fileName}`);

        try {
            fs.writeFileSync(fileLocalPath, req.body);
            job.status        = 'done';
            job.result        = { ready: true };
            job.fileLocalPath = fileLocalPath;
            job.fileName      = fileName;
            job.mimeType      = mimeType;
            job.fileSize      = req.body.length;

            console.log(`✅ [FILES] Upload received: ${fileName} (${(req.body.length/1024).toFixed(1)} KB) job=${jobId}`);
            res.json({ success: true });
        } catch(e) {
            job.status = 'error';
            job.result = e.message;
            console.error('❌ [FILES] Upload write error:', e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────
// API: المتصفح يحمّل الملف من السيرفر
// ─────────────────────────────────────────────
app.get('/api/fm/serve/:jobId', (req, res) => {
    const { pwd } = req.query;
    if (pwd !== WEB_PASSWORD) return res.status(403).send('Unauthorized');

    const job = pendingJobs.get(req.params.jobId);
    if (!job || !job.fileLocalPath) return res.status(404).send('File not found or expired');
    if (!fs.existsSync(job.fileLocalPath)) return res.status(404).send('File expired');

    res.setHeader('Content-Disposition', `attachment; filename="${job.fileName}"`);
    res.setHeader('Content-Type', job.mimeType || 'application/octet-stream');
    res.sendFile(job.fileLocalPath);
});

// ================================================================
// [15] دالة إرسال رسائل Telegram
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
// [16] تشغيل السيرفر
// ================================================================
app.listen(PORT, async () => {
    console.log('══════════════════════════════════════════');
    console.log(`✅ Server on port ${PORT}`);
    console.log(`🌐 ${SERVER_URL}`);
    console.log(`📁 File Manager: ${SERVER_URL}/files`);
    console.log(`📡 Webhook: ${SERVER_URL}/webhook`);
    console.log(`💓 Heartbeat: ${SERVER_URL}/heartbeat`);
    console.log('══════════════════════════════════════════');
    console.log('🔄 Activating webhook on startup...');
    await reactivateWebhook();
});
ENDOFFILE
echo "Done index.js"
