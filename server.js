import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { makeWASocket, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import fs from 'fs';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ========== صفحة HTML (مختصرة وجميلة) ==========
const HTML_PAGE = `<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>ربط واتساب</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #075E54 0%, #128C7E 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; margin: 0; }
        .container { background: white; border-radius: 25px; max-width: 500px; width: 100%; padding: 30px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        .icon { width: 80px; height: 80px; background: #25D366; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 50px; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37,211,102,0.4); } 70% { transform: scale(1.05); box-shadow: 0 0 0 20px rgba(37,211,102,0); } 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37,211,102,0); } }
        h1 { color: #075E54; }
        input { width: 100%; padding: 15px; border: 2px solid #ddd; border-radius: 12px; font-size: 16px; text-align: left; direction: ltr; margin: 15px 0; box-sizing: border-box; }
        button { width: 100%; padding: 15px; background: #25D366; color: white; border: none; border-radius: 12px; font-size: 18px; font-weight: bold; cursor: pointer; }
        button:disabled { background: #ccc; }
        .status { margin-top: 20px; padding: 15px; border-radius: 12px; display: none; }
        .status.info { background: #E3F2FD; color: #1976D2; display: block; }
        .status.error { background: #FFEBEE; color: #C62828; display: block; }
        .status.success { background: #E8F5E9; color: #2E7D32; display: block; }
        .code-box { background: #f5f5f5; padding: 20px; border-radius: 12px; margin: 20px 0; font-family: monospace; font-size: 32px; letter-spacing: 5px; font-weight: bold; color: #075E54; }
        .hidden { display: none; }
        .loader { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: white; animation: spin 1s ease-in-out infinite; margin-left: 10px; vertical-align: middle; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">💬</div>
        <h1>ربط حساب واتساب</h1>
        <input type="tel" id="phone" placeholder="مثال: 966512345678" dir="ltr">
        <button id="submitBtn">🔗 طلب رمز الاقتران</button>
        <div id="status" class="status"></div>
        <div id="codeSection" class="hidden"><div class="code-box" id="codeDisplay"></div><div class="instructions">✨ أدخل هذا الرمز في واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</div></div>
    </div>
    <script>
        const socket = io();
        const btn = document.getElementById('submitBtn');
        const phoneInput = document.getElementById('phone');
        const statusDiv = document.getElementById('status');
        const codeSection = document.getElementById('codeSection');
        const codeDisplay = document.getElementById('codeDisplay');

        function showStatus(msg, type) { statusDiv.textContent = msg; statusDiv.className = 'status ' + type; }
        btn.onclick = () => {
            const phone = phoneInput.value.trim().replace(/[^0-9]/g, '');
            if (!phone || phone.length < 8) return showStatus('❌ رقم غير صحيح', 'error');
            btn.disabled = true; btn.innerHTML = '<span class="loader"></span> جاري الطلب...';
            showStatus('⏳ جاري التجهيز... قد يستغرق 30 ثانية', 'info');
            socket.emit('pair', { phone });
        };
        socket.on('code', (data) => { btn.style.display = 'none'; phoneInput.disabled = true; codeDisplay.innerHTML = data.code; codeSection.classList.remove('hidden'); showStatus('✅ تم! أدخل الرمز', 'success'); });
        socket.on('error', (msg) => { btn.disabled = false; btn.innerHTML = '🔗 طلب رمز الاقتران'; showStatus('❌ '+msg, 'error'); });
        socket.on('connect', () => showStatus('✅ جاهز! أدخل رقم هاتفك', 'success'));
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));

// ========== منطق البوت المبسط والقوي ==========
io.on('connection', (socket) => {
    console.log('🟢 متصل:', socket.id);

    socket.on('pair', async ({ phone }) => {
        const cleanPhone = phone.replace(/\D/g, '');
        console.log(`📱 طلب للرقم: ${cleanPhone}`);
        
        // استخدم مجلدًا مؤقتًا لكل جلسة
        const sessionDir = `/tmp/wa_auth_${socket.id}`;
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir);

        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const sock = makeWASocket({
                auth: state,
                browser: Browsers.macOS('Chrome'),
                printQRInTerminal: false,
                // إعدادات أساسية فقط للتجنب التعقيد
                defaultQueryTimeoutMs: 30000,
                keepAliveIntervalMs: 30000
            });

            sock.ev.on('creds.update', saveCreds);
            
            let pairingRequested = false;
            sock.ev.on('connection.update', async (update) => {
                console.log(`🔵 حالة الاتصال: ${update.connection}`);
                // نطلب الرمز بمجرد أن يكون الاتصال جاهزًا أو مفتوحًا
                if ((update.connection === 'open' || update.connection === 'connecting') && !pairingRequested && !state.creds.registered) {
                    pairingRequested = true;
                    try {
                        const code = await sock.requestPairingCode(cleanPhone);
                        console.log(`✅ رمز الاقتران لـ ${cleanPhone}: ${code}`);
                        socket.emit('code', { code });
                    } catch (err) {
                        console.error(`❌ فشل طلب الرمز: ${err.message}`);
                        socket.emit('error', 'فشل طلب الرمز. تأكد من الرقم واتصل بالإنترنت.');
                    }
                } else if (update.connection === 'close') {
                    socket.emit('error', 'انقطع الاتصال، حاول مرة أخرى.');
                }
            });
        } catch (err) {
            console.error(`🔥 خطأ عام: ${err.message}`);
            socket.emit('error', 'خطأ في الخادم، يرجى المحاولة لاحقًا.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 يعمل على المنفذ ${PORT}`)); 
