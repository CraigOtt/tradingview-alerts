const http = require('http');
const https = require('https');

// ── Environment variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;

// ── In-memory signal store ────────────────────
// Maps Telegram message_id → signal data so replies can be matched
const recentSignals = new Map();
const MAX_STORED = 100;

function storeSignal(messageId, data) {
  recentSignals.set(messageId, {
    ticker:    data.ticker  || '',
    signal:    data.signal  || '',
    price:     data.price   || '',
    algo:      data.algo    || '',
    timestamp: Date.now()
  });
  if (recentSignals.size > MAX_STORED) {
    const firstKey = recentSignals.keys().next().value;
    recentSignals.delete(firstKey);
  }
  console.log('Signal stored — message_id:', messageId, 'ticker:', data.ticker, 'price:', data.price);
}

// ── Contract multipliers ──────────────────────
function getMultiplier(ticker) {
  if (ticker.includes('GF')) return 500;  // 1 full point = $500
  if (ticker.includes('ZC')) return 50;   // 1 cent = $50
  if (ticker.includes('ZS')) return 50;   // 1 cent = $50
  return 1;
}

// ── Send Telegram message — returns message_id ─
function sendTelegram(text, replyToMessageId) {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log('Telegram not configured — skipping');
      resolve(null);
      return;
    }
    const payload = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    const payloadStr = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path:     '/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const messageId = parsed.result && parsed.result.message_id;
          console.log('Telegram sent, message_id:', messageId);
          resolve(messageId);
        } catch(e) {
          console.log('Telegram response (parse error):', data);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => { console.error('Telegram error:', err.message); reject(err); });
    req.write(payloadStr);
    req.end();
  });
}

// ── Log to Google Sheet via Apps Script ───────
function logToSheet(params) {
  return new Promise((resolve) => {
    if (!APPS_SCRIPT_URL) { resolve(); return; }
    const url = new URL(APPS_SCRIPT_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'User-Agent': 'Jarvis-Trading-Bot/1.0' }
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = new URL(res.headers.location);
        https.request({ hostname: redirectUrl.hostname, path: redirectUrl.pathname + redirectUrl.search, method: 'GET' }, (r2) => {
          let d = ''; r2.on('data', c => d += c); r2.on('end', () => { console.log('Sheet log:', d); resolve(); });
        }).end();
      } else {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('Sheet log:', d); resolve(); });
      }
    });
    req.on('error', (err) => { console.error('Sheet error:', err.message); resolve(); });
    req.end();
  });
}

// ── Parse incoming alert message ──────────────
function parseAlert(body) {
  try { return JSON.parse(body); } catch(e) { return { raw: body }; }
}

// ── Format Telegram alert message ────────────
function formatTelegram(data) {
  const time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
  const msg      = (data.message || '').toString();
  const ticker   = data.ticker  || '';
  const signal   = (data.signal || '').toUpperCase();
  const price    = data.price   || '';
  const algo     = data.algo    || '';
  const convMatch  = msg.match(/\u2014\s*(PRIME ENTRY|CONFIRMED|MAX ALIGNMENT)/);
  const conviction = convMatch ? convMatch[1] : '';
  const posMatch = msg.match(/POS:\s*(-?\d+)/);
  const pos = posMatch ? parseInt(posMatch[1]) : null;
  let emoji = '📊';
  if (ticker.includes('GF')) emoji = '🐄';
  else if (ticker.includes('ZC')) emoji = '🌽';
  else if (ticker.includes('ZS')) emoji = '🫘';
  let sigEmoji = '';
  if (signal === 'LONG' || signal === 'BUY') sigEmoji = '🟢';
  else if (signal === 'SHORT' || signal === 'SELL') sigEmoji = '🔴';
  else if (signal === 'FLAT') sigEmoji = '⬜';
  else if (signal === 'STOP') sigEmoji = '🛑';
  let text = emoji + ' <b>JARVIS ALERT</b>\n';
  text += '━━━━━━━━━━━━━━━━\n';
  text += sigEmoji + ' <b>' + signal + '</b>  ' + ticker + '\n';
  if (conviction) text += '📈 ' + conviction + '\n';
  if (price)      text += '💰 Price: <b>' + price + '</b>\n';
  if (pos !== null) text += '📦 Position: ' + (pos > 0 ? '+' : '') + pos + ' ct\n';
  text += '⏰ ' + time + ' CT\n';
  if (algo) text += '<i>' + algo + '</i>\n';
  text += '\n<i>Reply "traded 356.50" to log your fill</i>';
  return text;
}

// ── Handle Telegram reply for slippage ────────
async function handleTelegramReply(update) {
  const message = update.message;
  if (!message || !message.reply_to_message) return;
  const text      = (message.text || '').trim();
  const replyToId = message.reply_to_message.message_id;
  const match = text.match(/^traded\s+([\d.]+)/i);
  if (!match) return;
  const fillPrice   = parseFloat(match[1]);
  const signal      = recentSignals.get(replyToId);
  if (!signal) {
    await sendTelegram('⚠️ <b>Signal not found</b>\nCould not match reply to a stored signal.\nServer may have restarted since the alert fired.', message.message_id);
    return;
  }
  const signalPrice     = parseFloat(signal.price);
  const slippagePts     = fillPrice - signalPrice;
  const multiplier      = getMultiplier(signal.ticker);
  const slippageDollars = slippagePts * multiplier;
  const sign    = slippageDollars >= 0 ? '+' : '';
const isShort = (signal.signal || '').toUpperCase() === 'SHORT' || 
                (signal.signal || '').toUpperCase() === 'SELL';
const verdict = isShort
  ? (slippageDollars >= 0 ? '✅ favorable' : 
     Math.abs(slippageDollars) < 50 ? '⚠️ minor adverse' : '🛑 significant adverse')
  : (slippageDollars <= 0 ? '✅ favorable' : 
     Math.abs(slippageDollars) < 50 ? '⚠️ minor adverse' : '🛑 significant adverse');
  const confirmMsg =
    '✅ <b>SLIPPAGE LOGGED</b>\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📋 ' + signal.ticker + ' — ' + signal.signal + '\n' +
    '🎯 Signal: <b>' + signal.price + '</b>\n' +
    '💵 Fill:   <b>' + fillPrice + '</b>\n' +
    '📊 Slip: ' + sign + slippagePts.toFixed(4) + ' pts  (' + sign + '$' + slippageDollars.toFixed(2) + ')\n' +
    verdict + '\n' +
    '<i>' + signal.algo + '</i>';
  await sendTelegram(confirmMsg, message.message_id);
  await logToSheet({
    action:          'logSlippage',
    ticker:          signal.ticker,
    signal:          signal.signal,
    signalPrice:     signal.price,
    fillPrice:       fillPrice.toString(),
    slippagePts:     slippagePts.toFixed(4),
    slippageDollars: slippageDollars.toFixed(2),
    algo:            signal.algo
  });
  console.log('Slippage logged:', signal.ticker, 'signal=' + signal.price, 'fill=' + fillPrice, 'slip=$' + slippageDollars.toFixed(2));
}

// ── HTTP Server ───────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('🌽🫘🐄 Jarvis Trading Server — Online (Slippage Tracker Active)');
    return;
  }
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      console.log('Alert received:', body);
      res.writeHead(200);
      res.end('OK');
      const data = parseAlert(body);
      const telegramMsg = formatTelegram(data);
      try {
        const [messageId] = await Promise.all([
          sendTelegram(telegramMsg),
          logToSheet({ ticker: data.ticker || '', signal: data.signal || '', price: data.price || '', algo: data.algo || '', message: data.message || body })
        ]);
        if (messageId && data.ticker && data.price) storeSignal(messageId, data);
        console.log('Alert processed successfully');
      } catch(err) {
        console.error('Alert processing error:', err.message);
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/telegram') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      res.writeHead(200);
      res.end('OK');
      try {
        const update = JSON.parse(body);
        console.log('Telegram update:', JSON.stringify(update).slice(0, 300));
        await handleTelegramReply(update);
      } catch(err) {
        console.error('Telegram webhook error:', err.message);
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Jarvis Trading Server running on port ' + PORT);
  console.log('Telegram configured:', !!TELEGRAM_BOT_TOKEN, '| Chat ID:', TELEGRAM_CHAT_ID);
});
