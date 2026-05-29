const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const SESSIONS_DIR = path.join(__dirname, 'auth_sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const activeSessions = new Map();

async function createWhatsAppSession(socketId, sessionFolder, phoneNumber = null) {
    console.log(`[${socketId}] بدء الجلسة...`);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: false,
        patchMessageBeforeSending: (message) => message
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    // انتظار جاهزية الاتصال
    await new Promise((resolve) => {
        const checkReady = (update) => {
            if (update.connection === 'open') {
                sock.ev.off('connection.update', checkReady);
                resolve();
            }
        };
        sock.ev.on('connection.update', checkReady);
    });
    
    // طلب رمز الاقتران إذا تم توفير رقم
    if (phoneNumber && !state.creds.registered) {
        console.log(`[${socketId}] طلب رمز للرقم: ${phoneNumber}`);
        try {
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            const code = await sock.requestPairingCode(cleanNumber);
            console.log(`[${socketId}] ✅ الرمز: ${code}`);
            io.to(socketId).emit('pairing_code', { code, phoneNumber: cleanNumber });
            return { sock, code };
        } catch (error) {
            console.error(`[${socketId}] خطأ:`, error);
            io.to(socketId).emit('error', 'فشل طلب الرمز، تأكد من الرقم واترك 30 ثانية ثم حاول مجدداً');
            throw error;
        }
    }
    
    return { sock };
}

io.on('connection', (socket) => {
    console.log('🟢 متصل:', socket.id);
    
    const sessionFolder = path.join(SESSIONS_DIR, socket.id);
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder);
    
    socket.emit('ready', { message: '✅ النظام جاهز! أدخل رقم هاتفك.' });
    
    socket.on('request_pairing', async (data) => {
        const { phoneNumber } = data;
        const cleanNumber = phoneNumber?.replace(/[^0-9]/g, '');
        
        if (!cleanNumber || cleanNumber.length < 8) {
            socket.emit('error', 'رقم الهاتف غير صحيح');
            return;
        }
        
        console.log(`[${socket.id}] 📱 طلب للرقم: ${cleanNumber}`);
        socket.emit('status', 'جاري الاتصال بخوادم واتساب...');
        
        try {
            // حذف الجلسة القديمة
            try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch(e) {}
            fs.mkdirSync(sessionFolder);
            
            await createWhatsAppSession(socket.id, sessionFolder, cleanNumber);
        } catch (error) {
            console.error(`[${socket.id}] فشل:`, error);
            socket.emit('error', 'فشل الاتصال، حاول مرة أخرى خلال 30 ثانية');
        }
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 قطع:', socket.id);
        activeSessions.delete(socket.id);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 يعمل على: https://y-m.onrender.com`);
}); 
