const express = require('express');
const cors = require('cors');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── Configurações ──
const API_TOKEN = process.env.WWEBJS_API_TOKEN || 'meu-token-secreto-123';
const PORT = process.env.PORT || 3001;
const AUTH_PATH = path.join(__dirname, 'baileys_auth');

// ── Estado Global ──
let sock = null;
let clientReady = false;
let currentQR = null;
let connectionInfo = null;

// Logger silencioso para economizar processamento
const logger = pino({ level: 'silent' });

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false, 
        markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = await qrcode.toDataURL(qr);
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('📴 Conexão fechada. Motivo:', lastDisconnect?.error || 'Desconhecido');
            clientReady = false;
            connectionInfo = null;
            if (shouldReconnect) {
                console.log('🔄 Reconectando...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            clientReady = true;
            currentQR = null;
            const user = sock.user;
            connectionInfo = {
                name: user.name || 'WhatsApp Business',
                phone: user.id.split(':')[0],
                platform: 'Baileys'
            };
            console.log(`\n✅ WhatsApp conectado via Baileys! (${connectionInfo.phone})`);
        }
    });
}

// ── Middleware de autenticação ──
function authMiddleware(req, res, next) {
    const token = req.headers['x-api-token'] || req.query.token;
    if (token !== API_TOKEN) {
        return res.status(401).json({ error: 'Token inválido' });
    }
    next();
}

// ── Rotas ──

app.get('/status', authMiddleware, (req, res) => {
    res.json({
        connected: clientReady,
        qr: currentQR,
        info: connectionInfo
    });
});

app.get('/groups', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject,
            participants: g.participants?.length || 0
        }));
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: 'Falha ao buscar grupos' });
    }
});

app.post('/send', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    const { phone, message } = req.body;
    try {
        let cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '');
        if (!cleanPhone.includes('@')) {
            cleanPhone = `${cleanPhone}@s.whatsapp.net`;
        }
        const sent = await sock.sendMessage(cleanPhone, { text: message });
        res.json({ success: true, messageId: sent.key.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-bulk-groups', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    const { groupIds, message } = req.body;
    const results = [];
    for (const id of groupIds) {
        try {
            await sock.sendMessage(id, { text: message });
            results.push({ id, success: true });
            await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
            results.push({ id, success: false, error: err.message });
        }
    }
    res.json({ success: true, results });
});

app.post('/logout', authMiddleware, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            if (fs.existsSync(AUTH_PATH)) {
                fs.rmSync(AUTH_PATH, { recursive: true, force: true });
            }
        }
        clientReady = false;
        connectionInfo = null;
        currentQR = null;
        res.json({ success: true });
        setTimeout(() => connectToWhatsApp(), 2000);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Baileys rodando na porta ${PORT}`);
    connectToWhatsApp();
});
