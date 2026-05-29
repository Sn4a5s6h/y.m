const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// تجهيز المجلد العام
app.use(express.static(path.join(__dirname, 'public')));

// تخزين جلسات البوت النشطة
const activeSessions = new Map();

/**
 * إنشاء اتصال واتساب جديد
 * @param {string} sessionId - معرف الجلسة
 * @returns {Promise<Object>}
 */
async function createWhatsAppSession(sessionId, socketId) {
    try {
        // استخدام مجلد منفصل لكل جلسة
        const authFolder = `./auth/${sessionId}`;
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,  // لا نريد QR كود
            browser: ['Chrome', 'Windows', '10.0'],
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });
        
        // حفظ بيانات الاعتماد عند التحديث
        sock.ev.on('creds.update', saveCreds);
        
        // معالجة أحداث الاتصال
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode 
                    : null;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[${sessionId}] تم تسجيل الخروج`);
                    io.to(socketId).emit('error', 'تم تسجيل الخروج، يرجى إعادة المحاولة');
                    activeSessions.delete(sessionId);
                } else {
                    console.log(`[${sessionId}] تم قطع الاتصال، إعادة المحاولة...`);
                    // إعادة إنشاء الجلسة بعد ثانيتين
                    setTimeout(() => createWhatsAppSession(sessionId, socketId), 2000);
                }
            }
            
            if (connection === 'open') {
                console.log(`[${sessionId}] ✅ تم الاتصال بنجاح!`);
                io.to(socketId).emit('connected', {
                    message: 'تم ربط الحساب بنجاح!',
                    sessionId: sessionId
                });
            }
        });
        
        // معالجة رسائل QR (لن تظهر لأننا نستخدم رمز الاقتران)
        sock.ev.on('qr', (qr) => {
            console.log(`[${sessionId}] QR code متاح (لن نستخدمه)`);
        });
        
        // طلب رمز الاقتران
        if (!state.creds.registered) {
            console.log(`[${sessionId}] في انتظار رقم الهاتف...`);
            
            // ننتظر حتى يصبح السوك جاهزاً ثم نستمع لطلب رمز الاقتران
            // سيتم استدعاء هذا من خلال حدث مخصص من العميل
            sock.pairingRequested = false;
            sock.requestPairing = async (phoneNumber) => {
                if (sock.pairingRequested) return;
                sock.pairingRequested = true;
                
                try {
                    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                    console.log(`[${sessionId}] طلب رمز اقتران للرقم: ${cleanNumber}`);
                    const code = await sock.requestPairingCode(cleanNumber);
                    console.log(`[${sessionId}] 🔐 رمز الاقتران: ${code}`);
                    io.to(socketId).emit('pairing_code', {
                        code: code,
                        phoneNumber: cleanNumber,
                        message: `رمز الاقتران الخاص بك هو: ${code}`
                    });
                } catch (error) {
                    console.error(`[${sessionId}] خطأ في طلب رمز الاقتران:`, error);
                    io.to(socketId).emit('error', 'فشل في طلب رمز الاقتران، تأكد من صحة الرقم');
                    sock.pairingRequested = false;
                }
            };
        } else {
            console.log(`[${sessionId}] ✅ جلسة موجودة بالفعل، متصل!`);
            io.to(socketId).emit('connected', {
                message: 'تم الاستعادة من جلسة سابقة!',
                sessionId: sessionId
            });
        }
        
        return sock;
    } catch (error) {
        console.error(`[${sessionId}] خطأ في إنشاء الجلسة:`, error);
        throw error;
    }
}

// Socket.IO - الاتصال المباشر مع العميل
io.on('connection', (socket) => {
    console.log('🟢 عميل جديد متصل:', socket.id);
    
    // إنشاء جلسة جديدة لهذا العميل
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    activeSessions.set(socket.id, { sessionId, sock: null });
    
    // إرسال تأكيد الاتصال
    socket.emit('ready', { 
        message: '✅ جاهز للاتصال! يرجى إدخال رقم هاتفك.',
        sessionId: sessionId
    });
    
    // استقبال رقم الهاتف من العميل
    socket.on('pair_with_number', async (data) => {
        const { phoneNumber } = data;
        
        if (!phoneNumber || phoneNumber.length < 8) {
            socket.emit('error', 'رقم الهاتف غير صحيح');
            return;
        }
        
        console.log(`[${sessionId}] 📱 استلام رقم الهاتف: ${phoneNumber}`);
        socket.emit('status', 'جاري طلب رمز الاقتران...');
        
        try {
            // إنشاء جلسة واتساب
            const session = activeSessions.get(socket.id);
            if (!session.sock) {
                const sock = await createWhatsAppSession(sessionId, socket.id);
                session.sock = sock;
                activeSessions.set(socket.id, session);
            }
            
            // طلب رمز الاقتران
            if (session.sock && session.sock.requestPairing) {
                await session.sock.requestPairing(phoneNumber);
            } else {
                socket.emit('error', 'الجلسة غير جاهزة بعد، يرجى المحاولة مرة أخرى');
            }
        } catch (error) {
            console.error(`[${sessionId}] خطأ:`, error);
            socket.emit('error', 'حدث خطأ في الخادم');
        }
    });
    
    // استقبال طلب إعادة المحاولة
    socket.on('retry', async () => {
        const session = activeSessions.get(socket.id);
        if (session && session.sock && session.sock.requestPairing) {
            session.sock.pairingRequested = false;
            socket.emit('status', 'يمكنك إدخال رقم الهاتف مرة أخرى');
        }
    });
    
    // تنظيف عند قطع الاتصال
    socket.on('disconnect', () => {
        console.log('🔴 عميل قطع الاتصال:', socket.id);
        activeSessions.delete(socket.id);
    });
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ═══════════════════════════════════════════
    🚀 سيرفر ربط واتساب يعمل على:
    🌐 http://localhost:${PORT}
    
    📱 شارك الرابط مع العميل لربط حسابه
    ═══════════════════════════════════════════
    `);
});
