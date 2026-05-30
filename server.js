import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import fs from 'fs';

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

// ========== صفحة HTML المدمجة ==========
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ربط واتساب</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #075E54 0%, #128C7E 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 25px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 30px;
            text-align: center;
        }
        .icon { width: 80px; height: 80px; background: #25D366; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 50px; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37,211,102,0.4); } 70% { transform: scale(1.05); box-shadow: 0 0 0 20px rgba(37,211,102,0); } 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37,211,102,0); } }
        h1 { color: #075E54; margin-bottom: 10px; }
        .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
        input { width: 100%; padding: 15px; border: 2px solid #ddd; border-radius: 12px; font-size: 16px; direction: ltr; text-align: left; margin-bottom: 15px; }
        input:focus { outline: none; border-color: #25D366; }
        button { width: 100%; padding: 15px; background: #25D366; color: white; border: none; border-radius: 12px; font-size: 18px; font-weight: bold; cursor: pointer; }
        button:hover { background: #128C7E; }
        button:disabled { background: #ccc; }
        .status { margin-top: 20px; padding: 15px; border-radius: 12px; display: none; }
        .status.info { background: #E3F2FD; color: #1976D2; display: block; }
        .status.error { background: #FFEBEE; color: #C62828; display: block; }
        .status.success { background: #E8F5E9; color: #2E7D32; display: block; }
        .code-box { background: #f5f5f5; padding: 20px; border-radius: 12px; margin: 20px 0; font-family: monospace; font-size: 32px; letter-spacing: 5px; font-weight: bold; color: #075E54; text-align: center; }
        .instructions { text-align: right; margin-top: 20px; padding: 15px; background: #f9f9f9; border-radius: 12px; font-size: 14px; }
        .instructions ol { margin-right: 20px; margin-top: 10px; }
        .instructions li { margin: 10px 0; }
        .hidden { display: none; }
        .loader { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: white; animation: spin 1s ease-in-out infinite; margin-left: 10px; vertical-align: middle; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">💬</div>
        <h1>ربط حساب واتساب</h1>
        <div class="subtitle">أدخل رقم هاتفك لربطه بهذا الجهاز عن بُعد</div>
        <input type="tel" id="phone" placeholder="مثال: 966512345678" dir="ltr">
        <button id="submitBtn" onclick="requestPairing()">🔗 طلب رمز الاقتران</button>
        <div id="status" class="status"></div>
        <div id="codeSection" class="hidden">
            <div class="code-box" id="codeDisplay"></div>
            <div class="instructions">
                <strong>📌 كيفية استخدام الرمز:</strong>
                <ol>
                    <li>افتح تطبيق <strong>واتساب</strong> على هاتفك</li>
                    <li>اذهب إلى <strong>الإعدادات</strong> → <strong>الأجهزة المرتبطة</strong></li>
                    <li>اضغط على <strong>ربط جهاز</strong> → <strong>الربط برقم الهاتف</strong></li>
                    <li>أدخل الرمز الظاهر أعلاه</li>
                </ol>
            </div>
        </div>
    </div>
    <script>
        const socket = io();
        function showStatus(msg, type) {
            const div = document.getElementById('status');
            div.textContent = msg;
            div.className = 'status ' + type;
        }
        function requestPairing() {
            const phone = document.getElementById('phone').value.trim().replace(/[^0-9]/g, '');
            if (!phone || phone.length < 8) {
                showStatus('❌ رقم الهاتف غير صحيح', 'error');
                return;
            }
            const btn = document.getElementById('submitBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="loader"></span> جاري الطلب...';
            showStatus('⏳ جاري الاتصال بخوادم واتساب...', 'info');
            socket.emit('pair', { phone });
        }
        socket.on('code', (data) => {
            document.getElementById('submitBtn').style.display = 'none';
            document.getElementById('phone').disabled = true;
            document.getElementById('codeDisplay').innerHTML = data.code;
            document.getElementById('codeSection').classList.remove('hidden');
            showStatus('✅ تم إنشاء الرمز! أدخله في واتساب', 'success');
        });
        socket.on('error', (msg) => {
            const btn = document.getElementById('submitBtn');
            btn.disabled = false;
            btn.innerHTML = '🔗 طلب رمز الاقتران';
            showStatus('❌ ' + msg, 'error');
        });
        socket.on('connect', () => showStatus('✅ جاهز! أدخل رقم هاتفك', 'success'));
        socket.on('disconnect', () => showStatus('❌ انقطع الاتصال، جاري إعادة المحاولة...', 'error'));
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));

// ========== منطق البوت ==========
io.on('connection', (socket) => {
    console.log('🟢 عميل متصل:', socket.id);
    
    socket.on('pair', async (data) => {
        const phone = data.phone.replace(/\D/g, '');
        console.log(`📱 [${socket.id}] طلب ربط للرقم: ${phone}`);
        
        // مجلد مؤقت للجلسة
        const sessionDir = `/tmp/auth_${socket.id}`;
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });
        
        try {
            // الحصول على أحدث إصدار من البروتوكول
            const { version } = await fetchLatestBaileysVersion();
            
            // تحميل حالة المصادقة
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            
            // إنشاء العميل
            const sock = makeWASocket({
                version,
                auth: state,
                browser: Browsers.macOS('Chrome'),
                printQRInTerminal: false,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000
            });
            
            // حفظ بيانات الاعتماد عند التحديث
            sock.ev.on('creds.update', saveCreds);
            
            // مراقبة حالة الاتصال
            sock.ev.on('connection.update', async (update) => {
                console.log(`[${socket.id}] حالة الاتصال:`, update.connection);
                
                // عندما يكون الاتصال في حالة "connecting" أو "open"
                if (update.connection === 'open' && !sock.authState.creds.registered) {
                    console.log(`[${socket.id}] طلب رمز الاقتران...`);
                    try {
                        const code = await sock.requestPairingCode(phone);
                        console.log(`[${socket.id}] 🔐 رمز الاقتران: ${code}`);
                        socket.emit('code', { code });
                    } catch (err) {
                        console.error(`[${socket.id}] فشل طلب الرمز:`, err);
                        socket.emit('error', err.message || 'فشل طلب الرمز');
                    }
                }
                
                // إذا حدث خطأ في الاتصال
                if (update.connection === 'close') {
                    console.log(`[${socket.id}] تم قطع الاتصال`);
                    socket.emit('error', 'انقطع الاتصال، حاول مرة أخرى');
                }
            });
            
            // معالجة الأخطاء العامة
            sock.ev.on('error', (err) => {
                console.error(`[${socket.id}] خطأ في الجلسة:`, err);
                socket.emit('error', err.message);
            });
            
        } catch (err) {
            console.error(`[${socket.id}] خطأ عام:`, err);
            socket.emit('error', err.message || 'حدث خطأ في الخادم');
        }
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 عميل قطع الاتصال:', socket.id);
        // تنظيف مجلد الجلسة
        const sessionDir = `/tmp/auth_${socket.id}`;
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ════════════════════════════════════════
    🚀 بوت ربط واتساب يعمل على:
    🌐 http://localhost:${PORT}
    
    ✨ انتظر 30-60 ثانية عند أول طلب
    ════════════════════════════════════════
    `);
});
