// server.js
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

// -- Auth token para proteger o servidor --
const API_TOKEN = process.env.WWEBJS_API_TOKEN || 'meu-token-secreto-123';
const PORT = process.env.PORT || 3001;

let clientReady = false;
let currentQR = null;
let connectionInfo = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

client.on('qr', async (qr) => {
  console.log('📱 QR Code gerado!');
  currentQR = await qrcode.toDataURL(qr);
});

client.on('ready', () => {
  clientReady = true;
  currentQR = null;
  connectionInfo = { name: client.info.pushname, phone: client.info.wid.user };
  console.log('✅ WhatsApp conectado!');
});

function authMiddleware(req, res, next) {
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== API_TOKEN) return res.status(401).json({ error: 'Token inválido' });
  next();
}

app.get('/status', authMiddleware, (req, res) => {
  res.json({ connected: clientReady, qr: currentQR, info: connectionInfo });
});

app.post('/send', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  try {
    const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    await client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
  client.initialize();
});
