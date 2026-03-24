const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// Middleware de autenticação
app.use((req, res, next) => {
  const token = req.headers['x-api-token'];
  if (!token || token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--deterministic-fetch',
      '--disable-features=IsolateOrigins',
      '--disable-site-isolation-trials'
    ],
    timeout: 60000
  }
});

let qrCodeData = null;
let isReady = false;

client.on('qr', async (qr) => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('QR Code gerado!');
});

client.on('ready', () => {
  isReady = true;
  qrCodeData = null;
  console.log('✅ WhatsApp conectado!');
});

client.on('disconnected', (reason) => {
  isReady = false;
  console.log('❌ Desconectado:', reason);
  setTimeout(() => client.initialize(), 5000);
});

client.on('auth_failure', (msg) => {
  console.error('Falha de autenticação:', msg);
});

client.on('message', async (msg) => {
  console.log(`Mensagem de ${msg.from}: ${msg.body}`);
});

app.get('/status', (req, res) => {
  res.json({ ready: isReady });
});

app.get('/qr', (req, res) => {
  if (isReady) return res.json({ ready: true });
  if (!qrCodeData) return res.json({ ready: false, qr: null, message: 'Aguardando QR...' });
  res.json({ ready: false, qr: qrCodeData });
});

app.post('/send', async (req, res) => {
  const { number, message } = req.body;
  if (!isReady) return res.status(503).json({ error: 'WhatsApp não está conectado' });
  if (!number || !message) return res.status(400).json({ error: 'number e message são obrigatórios' });
  try {
    const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
    await client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
