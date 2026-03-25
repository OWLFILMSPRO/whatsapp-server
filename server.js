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

// Status da conexão
app.get('/status', authMiddleware, (req, res) => {
    res.json({
        connected: clientReady,
        qr: currentQR,
        info: connectionInfo
    });
});

// Listar grupos
app.get('/groups', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    
    try {
        console.log('[groups] Buscando grupos participando...');
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject,
            participants: g.participants?.length || 0
        }));
        console.log(`[groups] ${list.length} grupos encontrados`);
        res.json(list);
    } catch (err) {
        console.error('[groups error]', err);
        res.status(500).json({ error: 'Falha ao buscar grupos' });
    }
});

// Buscar contatos/conversas
app.get('/contacts', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    if (!store) return res.json([]); // Se o store falhou, retorna vazio mas não quebra

    try {
        const query = (req.query.q || '').toLowerCase();
        
        // Converte os contatos do store em uma lista
        const contacts = Object.values(store.contacts).map(c => ({
            id: c.id,
            name: c.name || c.verifiedName || c.notify || '',
            phone: c.id?.split('@')[0] || ''
        })).filter(c => {
            if (!c.id || !c.id.endsWith('@s.whatsapp.net')) return false; // Apenas contatos individuais
            if (!query) return true;
            return c.name.toLowerCase().includes(query) || c.phone.includes(query);
        });

        // Ordena por nome
        contacts.sort((a, b) => a.name.localeCompare(b.name));

        res.json(contacts.slice(0, 50)); // Retorna top 50 para não sobrecarregar
    } catch (err) {
        console.error('[contacts error]', err);
        res.status(500).json({ error: 'Falha ao buscar contatos' });
    }
});

// Helper para encontrar o JID correto (com ou sem o 9º dígito)
async function getVerifiedJid(id) {
    if (!id || !id.endsWith('@s.whatsapp.net') || !sock || !clientReady) return id;
    
    try {
        const [result] = await sock.onWhatsApp(id);
        if (result && result.exists) {
            if (result.jid !== id) {
                console.log(`[JID Correction] ${id} → ${result.jid}`);
            }
            return result.jid;
        }
    } catch (err) {
        console.error('[Verify JID Error]', err);
    }
    return id;
}

// Enviar mensagem simples
app.post('/send', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    const { phone, message } = req.body;
    
    try {
        let cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '');
        if (!cleanPhone.includes('@')) {
            cleanPhone = `${cleanPhone}@s.whatsapp.net`;
        }

        const realJid = await getVerifiedJid(cleanPhone);
        const sent = await sock.sendMessage(realJid, { text: message }, { linkPreview: true });
        res.json({ success: true, messageId: sent.key.id, verifiedJid: realJid });
    } catch (err) {
        console.error('[send error]', err);
        res.status(500).json({ error: err.message });
    }
});

// Envio em massa para grupos
app.post('/send-bulk-groups', authMiddleware, async (req, res) => {
    if (!clientReady || !sock) return res.status(503).json({ error: 'WhatsApp não conectado' });
    const { groupIds, message } = req.body;

    const results = [];
    for (const id of groupIds) {
        try {
            const realJid = await getVerifiedJid(id);
            await sock.sendMessage(realJid, { text: message }, { linkPreview: true });
            results.push({ id, verifiedJid: realJid, success: true });
            // Pequeno delay entre envios para evitar spam
            await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
            results.push({ id, success: false, error: err.message });
        }
    }
    res.json({ success: true, results });
});

// Logout
app.post('/logout', authMiddleware, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            // Limpa pasta de auth
            if (fs.existsSync(AUTH_PATH)) {
                fs.rmSync(AUTH_PATH, { recursive: true, force: true });
            }
        }
        clientReady = false;
        connectionInfo = null;
        currentQR = null;
        res.json({ success: true });
        // Reinicia para gerar novo QR
        setTimeout(() => connectToWhatsApp(), 2000);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Baileys rodando na porta ${PORT}`);
    connectToWhatsApp();
});
