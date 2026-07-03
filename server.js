const http = require('http');
const https = require('https');

// ── Environment variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;

// ── Send Telegram message ─────────────────────
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log('Telegram not configured — skipping SMS');
      resolve();
      return;
    }
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Telegram response:', data);
        resolve();
      });
    });
    req.on('error', (err) => {
      console.error('Telegram error:', err.message);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

// ── Log to Google Sheet via Apps Script ───────
function logToSheet(params) {
  return new Promise((resolve) => {
    if (!APPS_SCRIPT_URL) { resolve(); return; }
    const url = new URL(APPS_SCRIPT_URL);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'User-Agent': 'Jarvis-Trading-Bot/1.0' }
    };
    const req = https.request(options, (res) => {
      // Follow redirect if needed
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = new URL(res.headers.location);
        const redirOptions = {
          hostname: redirectUrl.hostname,
          path: redirectUrl.pathname + redirectUrl.search,
          method: 'GET'
        };
        https.request(redirOptions, (r2) => {
          let d = '';
          r2.on('data', c => d += c);
          r2.on('end', () => { console.log('Sheet log:', d); resolve(); });
        }).end();
      } else {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { console.log('Sheet log:', d); resolve(); });
      }
    });
    req.on('error', (err) => {
      console.error('Sheet error:', err.message);
      resolve();
    });
    req.end();
  });
}

// ── Parse incoming alert message ──────────────
function parseAlert(body) {
  try {
    return JSON.parse(body);
  } catch(e) {
    return { raw: body };
  }
}

// ── Format Telegram message ───────────────────
function formatTelegram(data) {
  const time = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit', minute: '2-digit'
  });

  // Parse the message field for conviction label
  const msg     = (data.message || '').toString();
  const ticker  = data.ticker  || '';
  const signal  = (data.signal || '').toUpperCase();
  const price   = data.price   || '';
  const algo    = data.algo    || '';

  // Extract conviction label if present
  const convMatch = msg.match(/—\s*(PRIME ENTRY|CONFIRMED|MAX ALIGNMENT)/);
  const conviction = convMatch ? convMatch[1] : '';

  // Extract position
  const posMatch = msg.match(/POS:\s*(-?\d+)/);
  const pos = posMatch ? parseInt(posMatch[1]) : null;

  // Choose emoji
  let emoji = '📊';
  if (ticker.includes('GF')) emoji = '🐄';
  else if (ticker.includes('ZC')) emoji = '🌽';
  else if (ticker.includes('ZS')) emoji = '🫘';

  // Signal emoji
  let sigEmoji = '';
  if (signal === 'LONG' || signal === 'BUY')   sigEmoji = '🟢';
  else if (signal === 'SHORT' || signal === 'SELL') sigEmoji = '🔴';
  else if (signal === 'FLAT')                   sigEmoji = '⬜';
  else if (signal === 'STOP')                   sigEmoji = '🛑';

  let text = `${emoji} <b>JARVIS ALERT</b>\n`;
  text += `━━━━━━━━━━━━━━━━\n`;
  text += `${sigEmoji} <b>${signal}</b>  ${ticker}\n`;
  if (conviction) text += `📈 ${conviction}\n`;
  if (price)      text += `💰 Price: <b>${price}</b>\n`;
  if (pos !== null) text += `📦 Position: ${pos > 0 ? '+' : ''}${pos} ct\n`;
  text += `⏰ ${time} CT\n`;
  if (algo)       text += `<i>${algo}</i>`;

  return text;
}

// ── HTTP Server ───────────────────────────────
const server = http.createServer((req, res) => {

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('🌽🫘🐄 Jarvis Trading Server — Online');
    return;
  }

  // Webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      console.log('Alert received:', body);
      res.writeHead(200);
      res.end('OK');

      const data = parseAlert(body);
      const telegramMsg = formatTelegram(data);

      // Run in parallel — don't block each other
      try {
        await Promise.all([
          sendTelegram(telegramMsg),
          logToSheet({
            ticker:  data.ticker  || '',
            signal:  data.signal  || '',
            price:   data.price   || '',
            algo:    data.algo    || '',
            message: data.message || body
          })
        ]);
        console.log('Alert processed successfully');
      } catch(err) {
        console.error('Alert processing error:', err.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Jarvis Trading Server running on port ${PORT}`);
});
