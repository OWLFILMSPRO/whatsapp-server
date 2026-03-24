const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

// Log de requisições para debug
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// ── Auth token para proteger o servidor ──
const API_TOKEN = process.env.WWEBJS_API_TOKEN || 'meu-token-secreto-123';
const PORT = process.env.PORT || 3001;

// ── Estado global ──
let clientReady = false;
let currentQR = null;
let connectionInfo = null;

// ── Cliente WhatsApp ──
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--js-flags="--max-old-space-size=512"' // Limita o heap do V8
    ]
  }
});

// ── Eventos do cliente ──
client.on('qr', async (qr) => {
  console.log('\n📱 QR Code gerado! Escaneie com seu WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
  currentQR = await qrcode.toDataURL(qr);
});

client.on('ready', async () => {
  clientReady = true;
  currentQR = null;
  const info = client.info;
  connectionInfo = {
    name: info.pushname,
    phone: info.wid.user,
    platform: info.platform
  };
  console.log(`\n✅ WhatsApp conectado! (${info.pushname} - ${info.wid.user})`);

  // Otimização de memória: Bloqueia recursos pesados (Imagens, CSS, Fonts)
  const page = client.pupPage;
  if (page) {
    try {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });
      console.log('📉 Otimização de recursos ativada (bloqueando imagens/estilos)');
    } catch (err) {
      console.error('⚠️ Erro ao configurar interceptação de recursos:', err);
    }
  }
});

client.on('authenticated', () => {
  console.log('🔐 Autenticado com sucesso!');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falha na autenticação:', msg);
  clientReady = false;
});

client.on('disconnected', (reason) => {
  console.log('📴 Desconectado:', reason);
  clientReady = false;
  connectionInfo = null;
});

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

// Obter QR code como imagem
app.get('/qr', authMiddleware, (req, res) => {
  if (clientReady) return res.json({ connected: true, message: 'Já conectado!' });
  if (!currentQR) return res.json({ connected: false, qr: null, message: 'Aguardando QR...' });
  res.json({ connected: false, qr: currentQR });
});

// Listar grupos
app.get('/groups', authMiddleware, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  console.log('[groups] Iniciando busca de chats...');
  const start = Date.now();
  try {
    const chats = await client.getChats();
    console.log(`[groups] ${chats.length} chats encontrados em ${Date.now() - start}ms`);
    
    const groups = chats
      .filter(chat => chat.isGroup)
      .map(g => ({
        id: g.id._serialized,
        name: g.name,
        participants: g.participants?.length || 0
      }));
    
    console.log(`[groups] ${groups.length} grupos filtrados`);
    res.json(groups);
  } catch (err) {
    console.error('[groups error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem para grupo
app.post('/send-group', authMiddleware, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  const { groupId, message } = req.body;
  if (!groupId || !message) return res.status(400).json({ error: 'groupId e message são obrigatórios' });

  try {
    const chat = await client.getChatById(groupId);
    const sent = await chat.sendMessage(message);
    res.json({ success: true, messageId: sent.id._serialized, timestamp: sent.timestamp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem para número
app.post('/send', authMiddleware, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });

  try {
    const cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '');
    
    // Tenta obter o ID correto do WhatsApp para o número (resolve problemas de 9º dígito e formatação)
    const numberId = await client.getNumberId(cleanPhone);
    
    if (!numberId) {
      return res.status(404).json({ error: 'Número não encontrado no WhatsApp' });
    }

    const sent = await client.sendMessage(numberId._serialized, message);
    res.json({ success: true, messageId: sent.id._serialized });
  } catch (err) {
    console.error('[send error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem em massa para múltiplos grupos
app.post('/send-bulk-groups', authMiddleware, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  const { groupIds, message, delayMs = 2000 } = req.body;
  if (!groupIds?.length || !message) return res.status(400).json({ error: 'groupIds e message são obrigatórios' });

  const results = [];
  for (const gid of groupIds) {
    try {
      const chat = await client.getChatById(gid);
      await chat.sendMessage(message);
      results.push({ groupId: gid, success: true });
    } catch (err) {
      results.push({ groupId: gid, success: false, error: err.message });
    }
    // Delay entre envios para não ser bloqueado
    await new Promise(r => setTimeout(r, delayMs));
  }
  res.json({ results });
});

// Desconectar
app.post('/logout', authMiddleware, async (req, res) => {
  try {
    await client.logout();
    clientReady = false;
    connectionInfo = null;
    currentQR = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Iniciar ──
app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Server rodando na porta ${PORT}`);
  console.log(`🔑 Token: ${API_TOKEN}`);
  console.log('⏳ Iniciando cliente WhatsApp...\n');
  client.initialize();
});
