import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('✅ عميل متصل:', socket.id);
    
    socket.on('pair', async (data) => {
        const phone = data.phone.replace(/\D/g, '');
        console.log('📱 طلب للرقم:', phone);
        
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./auth');
            const sock = makeWASocket({
                auth: state,
                browser: Browsers.ubuntu('Chrome'),
                printQRInTerminal: false
            });
            
            sock.ev.on('creds.update', saveCreds);
            
            // انتظار جاهزية الاتصال
            await new Promise((resolve) => {
                sock.ev.on('connection.update', (update) => {
                    if (update.connection === 'open') resolve();
                });
            });
            
            const code = await sock.requestPairingCode(phone);
            console.log('🔑 الرمز:', code);
            socket.emit('code', { code });
            
        } catch (err) {
            console.error('❌ خطأ:', err);
            socket.emit('error', err.message);
        }
    });
});

// صفحة HTML المدمجة
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>ربط واتساب</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #075E54 0%, #128C7E 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }
            .container {
                background: white;
                border-radius: 30px;
                padding: 35px;
                max-width: 450px;
                width: 100%;
                text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            .icon {
                font-size: 60px;
                margin-bottom: 20px;
            }
            h1 {
                color: #075E54;
                margin-bottom: 10px;
            }
            .subtitle {
                color: #666;
                margin-bottom: 25px;
                font-size: 14px;
            }
            input {
                width: 100%;
                padding: 15px;
                margin: 10px 0;
                border: 2px solid #e0e0e0;
                border-radius: 15px;
                font-size: 16px;
                text-align: left;
                direction: ltr;
                transition: all 0.3s;
            }
            input:focus {
                outline: none;
                border-color: #25D366;
                box-shadow: 0 0 0 3px rgba(37,211,102,0.1);
            }
            button {
                background: #25D366;
                color: white;
                border: none;
                padding: 15px 30px;
                border-radius: 30px;
                font-size: 18px;
                font-weight: bold;
                cursor: pointer;
                width: 100%;
                margin-top: 15px;
                transition: all 0.3s;
            }
            button:hover {
                background: #128C7E;
                transform: translateY(-2px);
            }
            button:disabled {
                background: #ccc;
                cursor: not-allowed;
            }
            .code-box {
                background: linear-gradient(135deg, #075E54 0%, #128C7E 100%);
                padding: 25px;
                border-radius: 20px;
                margin: 25px 0;
            }
            .code-label {
                color: rgba(255,255,255,0.9);
                font-size: 14px;
                margin-bottom: 10px;
            }
            .code-value {
                background: white;
                padding: 20px;
                border-radius: 15px;
                font-family: 'Courier New', monospace;
                font-size: 36px;
                letter-spacing: 8px;
                font-weight: bold;
                color: #075E54;
                text-align: center;
                direction: ltr;
            }
            .instructions {
                text-align: right;
                margin-top: 20px;
                padding: 20px;
                background: #f5f5f5;
                border-radius: 15px;
                font-size: 14px;
            }
            .instructions ol {
                margin-right: 20px;
                margin-top: 10px;
            }
            .instructions li {
                margin: 8px 0;
            }
            .status {
                margin-top: 15px;
                padding: 12px;
                border-radius: 10px;
                display: none;
            }
            .status.info { background: #E3F2FD; color: #1976D2; display: block; }
            .status.error { background: #FFEBEE; color: #C62828; display: block; }
            .status.success { background: #E8F5E9; color: #2E7D32; display: block; }
            .hidden { display: none; }
            .loader {
                display: inline-block;
                width: 18px;
                height: 18px;
                border: 2px solid rgba(255,255,255,0.3);
                border-radius: 50%;
                border-top-color: white;
                animation: spin 1s ease-in-out infinite;
                margin-left: 10px;
                vertical-align: middle;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="icon">💬</div>
            <h1>ربط حساب واتساب</h1>
            <div class="subtitle">أدخل رقم هاتفك لربطه بهذا الجهاز عن بُعد</div>
            
            <input type="tel" id="phone" placeholder="966512345678" dir="ltr">
            <button id="submitBtn" onclick="requestPairing()">🔗 طلب رمز الاقتران</button>
            
            <div id="status" class="status"></div>
            <div id="codeSection" class="hidden">
                <div class="code-box">
                    <div class="code-label">🔐 رمز الاقتران المكون من 8 أرقام</div>
                    <div class="code-value" id="codeDisplay"></div>
                </div>
                <div class="instructions">
                    <strong>📌 كيفية استخدام الرمز:</strong>
                    <ol>
                        <li>افتح تطبيق <strong>واتساب</strong> على هاتفك</li>
                        <li>اذهب إلى <strong>الإعدادات (Settings)</strong> ⚙️</li>
                        <li>اختر <strong>الأجهزة المرتبطة (Linked Devices)</strong></li>
                        <li>اضغط على <strong>ربط جهاز (Link a Device)</strong> 🔗</li>
                        <li>اختر <strong>الربط برقم الهاتف (Link with phone number)</strong></li>
                        <li>أدخل الرمز الظاهر أعلاه واضغط تأكيد</li>
                    </ol>
                </div>
            </div>
        </div>

        <script>
            const socket = io();
            let isProcessing = false;
            
            function showStatus(message, type) {
                const statusDiv = document.getElementById('status');
                statusDiv.textContent = message;
                statusDiv.className = \`status \${type}\`;
            }
            
            function requestPairing() {
                if(isProcessing) return;
                
                const phone = document.getElementById('phone').value.trim();
                if(!phone) {
                    showStatus('❌ يرجى إدخال رقم الهاتف', 'error');
                    return;
                }
                
                const cleanPhone = phone.replace(/[^0-9]/g, '');
                if(cleanPhone.length < 8) {
                    showStatus('❌ رقم الهاتف غير صحيح', 'error');
                    return;
                }
                
                isProcessing = true;
                const btn = document.getElementById('submitBtn');
                btn.disabled = true;
                btn.innerHTML = '<span class="loader"></span> جاري الاتصال...';
                showStatus('⏳ جاري الاتصال بخوادم واتساب...', 'info');
                
                socket.emit('pair', { phone: cleanPhone });
            }
            
            socket.on('code', (data) => {
                isProcessing = false;
                document.getElementById('submitBtn').style.display = 'none';
                document.getElementById('phone').disabled = true;
                
                const codeDiv = document.getElementById('codeSection');
                const codeDisplay = document.getElementById('codeDisplay');
                codeDisplay.innerHTML = data.code;
                codeDiv.classList.remove('hidden');
                
                showStatus('✅ تم إنشاء رمز الاقتران! أدخله في تطبيق واتساب', 'success');
            });
            
            socket.on('error', (msg) => {
                isProcessing = false;
                const btn = document.getElementById('submitBtn');
                btn.disabled = false;
                btn.innerHTML = '🔗 طلب رمز الاقتران';
                showStatus(\`❌ \${msg}\`, 'error');
            });
            
            socket.on('connect_error', () => {
                showStatus('❌ مشكلة في الاتصال بالخادم، يرجى تحديث الصفحة', 'error');
            });
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ════════════════════════════════════════
    🚀 بوت ربط واتساب يعمل على:
    🌐 http://localhost:${PORT}
    
    ✨ انتظر 5 دقائق بعد النشر على Render
    ════════════════════════════════════════
    `);
});
