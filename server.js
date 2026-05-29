const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    delay 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const SESSIONS_DIR = path.join(__dirname, 'auth_sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const activeSessions = new Map();

async function createWhatsAppSession(socketId, sessionFolder, phoneNumberForPairing = null) {
    console.log(`[${socketId}] جاري إنشاء جلسة جديدة...`);
    
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.macOS('Chrome'),  // 🔑 مهم جدًا للاقتران
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {},
                                },
                                ...message,
                            },
                        },
                    };
                }
                return message;
            },
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // 🔑 الحل السحري: الانتظار حتى يصبح الاتصال جاهزًا قبل طلب الرمز
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`[${socketId}] حالة الاتصال:`, connection);
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode 
                    : null;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[${socketId}] تم تسجيل الخروج`);
                    io.to(socketId).emit('error', 'تم تسجيل الخروج، يرجى إعادة المحاولة');
                    activeSessions.delete(socketId);
                } else {
                    console.log(`[${socketId}] تم قطع الاتصال، إعادة المحاولة...`);
                    setTimeout(() => createWhatsAppSession(socketId, sessionFolder), 3000);
                }
            }
            
            if (connection === 'open') {
                console.log(`[${socketId}] ✅ تم الاتصال بنجاح!`);
                io.to(socketId).emit('connected', {
                    message: 'تم ربط الحساب بنجاح!',
                    sessionId: socketId
                });
            }
            
            // 🔑 الأهم: طلب رمز الاقتران عند وصول حدث 'connecting'
            if (connection === 'connecting' && phoneNumberForPairing && !sock.pairingRequested) {
                sock.pairingRequested = true;
                console.log(`[${socketId}] جاري طلب رمز الاقتران للرقم: ${phoneNumberForPairing}`);
                
                try {
                    // تنظيف رقم الهاتف
                    const cleanNumber = phoneNumberForPairing.replace(/[^0-9]/g, '');
                    const code = await sock.requestPairingCode(cleanNumber);
                    console.log(`[${socketId}] 🔐 رمز الاقتران: ${code}`);
                    
                    io.to(socketId).emit('pairing_code', {
                        code: code,
                        phoneNumber: cleanNumber,
                        message: `رمز الاقتران الخاص بك هو: ${code}`
                    });
                } catch (error) {
                    console.error(`[${socketId}] فشل طلب الرمز:`, error);
                    io.to(socketId).emit('error', 'فشل في طلب رمز الاقتران، تأكد من صحة الرقم وحاول مرة أخرى');
                    sock.pairingRequested = false;
                }
            }
        });
        
        // إذا كان هناك رقم هاتف للاقتران وكانت الجلسة غير مسجلة
        if (phoneNumberForPairing && !state.creds.registered && !sock.pairingRequested) {
            // ننتظر قليلاً حتى يتم تهيئة الاتصال
            setTimeout(async () => {
                if (!sock.pairingRequested) {
                    sock.pairingRequested = true;
                    try {
                        const cleanNumber = phoneNumberForPairing.replace(/[^0-9]/g, '');
                        const code = await sock.requestPairingCode(cleanNumber);
                        console.log(`[${socketId}] 🔐 رمز الاقتران (بعد التأخير): ${code}`);
                        io.to(socketId).emit('pairing_code', {
                            code: code,
                            phoneNumber: cleanNumber,
                            message: `رمز الاقتران الخاص بك هو: ${code}`
                        });
                    } catch (error) {
                        console.error(`[${socketId}] فشل طلب الرمز بعد التأخير:`, error);
                        io.to(socketId).emit('error', 'فشل في طلب رمز الاقتران، تأكد من صحة الرقم وحاول مرة أخرى');
                        sock.pairingRequested = false;
                    }
                }
            }, 3000);
        }
        
        return sock;
        
    } catch (error) {
        console.error(`[${socketId}] خطأ في إنشاء الجلسة:`, error);
        io.to(socketId).emit('error', 'حدث خطأ في الخادم');
        throw error;
    }
}

// Socket.IO events
io.on('connection', (socket) => {
    console.log('🟢 عميل متصل:', socket.id);
    
    const sessionFolder = path.join(SESSIONS_DIR, socket.id);
    if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder);
    
    activeSessions.set(socket.id, { 
        sessionId: socket.id, 
        sock: null, 
        folder: sessionFolder,
        pendingPhone: null
    });
    
    socket.emit('ready', { 
        message: '✅ النظام جاهز! أدخل رقم هاتفك لربط حساب واتساب.',
        sessionId: socket.id
    });
    
    socket.on('request_pairing', async (data) => {
        const { phoneNumber } = data;
        
        if (!phoneNumber || phoneNumber.length < 8) {
            socket.emit('error', 'رقم الهاتف غير صحيح');
            return;
        }
        
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        console.log(`[${socket.id}] 📱 طلب اقتران للرقم: ${cleanNumber}`);
        socket.emit('status', 'جاري الاتصال بخوادم واتساب...');
        
        try {
            const session = activeSessions.get(socket.id);
            
            // حذف المجلد القديم لبدء جلسة نظيفة
            try {
                fs.rmSync(session.folder, { recursive: true, force: true });
            } catch(e) {}
            fs.mkdirSync(session.folder);
            
            // إنشاء جلسة جديدة مع رقم الهاتف
            const sock = await createWhatsAppSession(socket.id, session.folder, cleanNumber);
            session.sock = sock;
            activeSessions.set(socket.id, session);
            
        } catch (error) {
            console.error(`[${socket.id}] خطأ:`, error);
            socket.emit('error', 'حدث خطأ في الخادم، يرجى المحاولة مرة أخرى');
        }
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 عميل قطع الاتصال:', socket.id);
        const session = activeSessions.get(socket.id);
        if (session && session.sock) {
            session.sock.end(new Error('تم قطع الاتصال من قبل العميل'));
        }
        activeSessions.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ═══════════════════════════════════════════════════
    🚀 نظام ربط واتساب عن بُعد يعمل على:
    🌐 http://localhost:${PORT}
    
    📱 شارك هذا الرابط مع العميل لربط حسابه
    ⚡ يستخدم النظام Pairing Code بدون QR كود
    ═══════════════════════════════════════════════════
    `);
}); 
