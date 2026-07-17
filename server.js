const http = require('http');
const https = require('https');

// ── Environment variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;

// ── In-memory signal store ────────────────────
const recentSignals = new Map();
const MAX_STORED = 100;

function storeSignal(messageId, data) {
  recentSignals.set(messageId, {
    ticker:    data.ticker  || '',
    signal:    data.signal  || '',
    price:     data.price   || '',
    algo:      data.algo    || '',
    stopLevel: data.stopLevel || null,
    atr:       data.atr || null,
    suggestedMes: data.suggestedMes || null,
    timestamp: Date.now()
  });
  if (recentSignals.size > MAX_STORED) {
    const firstKey = recentSignals.keys().next().value;
    recentSignals.delete(firstKey);
  }
  console.log('Signal stored — message_id:', messageId, 'ticker:', data.ticker, 'price:', data.price, 'stop:', data.stopLevel, 'atr:', data.atr, 'mes:', data.suggestedMes);
}

// ── Contract multipliers ──────────────────────
function getMultiplier(ticker) {
  if (ticker.includes('GF')) return 500;
  if (ticker.includes('ZC')) return 50;
  if (ticker.includes('ZS')) return 50;
  if (ticker.includes('MES')) return 5;
  if (ticker.includes('ES') || ticker.includes('SP')) return 50;
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
// Returns the Apps Script response text so callers can verify success.
function logToSheet(params) {
  return new Promise((resolve) => {
    if (!APPS_SCRIPT_URL) { console.log('Sheet log SKIPPED: APPS_SCRIPT_URL not set'); resolve('NO_URL'); return; }
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
          let d = ''; r2.on('data', c => d += c); r2.on('end', () => { console.log('Sheet log:', d); resolve(d); });
        }).end();
      } else {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('Sheet log:', d); resolve(d); });
      }
    });
    req.on('error', (err) => { console.error('Sheet error:', err.message); resolve('ERROR: ' + err.message); });
    req.end();
  });
}

// ── Parse incoming alert message ──────────────
function parseAlert(body) {
  try { return JSON.parse(body); } catch(e) { return { raw: body }; }
}

// ── Extract fields from message string ────────
function parseField(msg, field) {
  const m = (msg || '').match(new RegExp(field + ':([\\d.\\-]+)'));
  return m ? m[1] : null;
}

// ── Format Telegram alert message ────────────
function formatTelegram(data) {
  // ★ CHANGED: was toLocaleTimeString (time only). Now toLocaleString with
  // date fields so alerts show the full date + time, both from ONE
  // America/Chicago timestamp (the date can't drift off the time near midnight).
  const time = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const msg      = (data.message || '').toString();
  const ticker   = data.ticker  || '';
  const signal   = (data.signal || '').toUpperCase();
  const price    = data.price   || '';
  const algo     = data.algo    || '';

  // Extract sizing fields from message payload
  const stopLevel = parseField(msg, 'STOP');
  const atr       = parseField(msg, 'ATR');
  const suggestedMes = parseField(msg, 'MES');

  // Store on data object for signal storage
  data.stopLevel = stopLevel;
  data.atr = atr;
  data.suggestedMes = suggestedMes;

  const convMatch  = msg.match(/\u2014\s*(PRIME ENTRY|CONFIRMED|MAX ALIGNMENT)/);
  const conviction = convMatch ? convMatch[1] : '';
  const posMatch = msg.match(/POS:\s*(-?\d+)/);
  const pos = posMatch ? parseInt(posMatch[1]) : null;

  let emoji = '📊';
  if (ticker.includes('GF')) emoji = '🐄';
  else if (ticker.includes('ZC')) emoji = '🌽';
  else if (ticker.includes('ZS')) emoji = '🫘';
  else if (ticker.includes('ES') || ticker.includes('SP') || ticker.includes('MES')) emoji = '📈';

  let sigEmoji = '';
  if (signal === 'LONG' || signal === 'BUY') sigEmoji = '🟢';
  else if (signal === 'SHORT' || signal === 'SELL') sigEmoji = '🔴';
  else if (signal === 'FLAT') sigEmoji = '⬜';
  else if (signal === 'STOP') sigEmoji = '🛑';

  const isV10        = algo.includes('V10');
  const isSP500      = algo.includes('SP500');
  const isPaperFirst = isSP500;

  let text = emoji + ' <b>JARVIS ALERT</b>';
  if (isV10)        text += ' <i>[SHADOW]</i>';
  if (isPaperFirst) text += ' <i>[PAPER]</i>';
  text += '\n━━━━━━━━━━━━━━━━\n';
  text += sigEmoji + ' <b>' + signal + '</b>  ' + ticker + '\n';
  if (conviction) text += '📈 ' + conviction + '\n';
  if (price)      text += '💰 Price: <b>' + price + '</b>\n';

  // Show stop, ATR, and suggested MES on entry signals
  if ((signal === 'LONG' || signal === 'BUY')) {
    if (stopLevel) {
      text += '🛑 Stop: <b>' + stopLevel + '</b>\n';
      const multiplier = getMultiplier(ticker);
      const priceDiff = parseFloat(price) - parseFloat(stopLevel);
      if (!isNaN(priceDiff) && priceDiff > 0) {
        const dollarRisk = (priceDiff * multiplier).toFixed(0);
        text += '💸 Max risk (1 ES): <b>$' + dollarRisk + '</b>\n';
      }
    }
    if (atr) text += '📊 ATR: <b>' + atr + '</b>\n';
    if (suggestedMes) text += '📐 Suggested size: <b>' + suggestedMes + ' MES</b>\n';
  }

  if (pos !== null) text += '📦 Position: ' + (pos > 0 ? '+' : '') + pos + ' ct\n';
  text += '⏰ ' + time + ' CT\n';
  if (algo) text += '<i>' + algo + '</i>\n';

  if (isV10) {
    text += '\n<i>🔬 V10 shadow tracking — no action needed</i>';
  } else if (isPaperFirst) {
    text += '\n<i>📋 Paper — just reply "traded [price]". ATR & size auto-logged.</i>';
  } else {
    // ★ CHANGED: was a hardcoded 'Reply "traded 356.50"' (a corn price that
    // showed up misleadingly on cattle/bean alerts). Now generic.
    text += '\n<i>Reply "traded [your fill price]" to log your fill</i>';
  }

  return text;
}

// ★ NEW: Format the FC V9 Watch heads-up (pre-market cross-confirmed notice).
function formatWatch(data) {
  const wtime = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sig = (data.signal || '').toUpperCase();
  const dir = sig === 'WATCH_LONG' ? '🟢 LONG' : sig === 'WATCH_SHORT' ? '🔴 SHORT' : '👀 WATCH';
  let text = '🐄 <b>FC V9 WATCH — heads-up</b>\n━━━━━━━━━━━━━━━━\n';
  text += dir + '  ' + (data.ticker || '') + '\n';
  if (data.price) text += '💰 Close: <b>' + data.price + '</b>\n';
  if (data.message) text += '📋 ' + data.message + '\n';
  text += '⏰ ' + wtime + ' CT\n';
  text += '<i>Heads-up only — nothing traded, nothing logged. Rest a Market-On-Open order to match the system fill.</i>';
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
  const fillPrice = parseFloat(match[1]);
  const signal    = recentSignals.get(replyToId);
  if (!signal) {
    await sendTelegram('⚠️ <b>Signal not found</b>\nCould not match reply to a stored signal.\nServer may have restarted since the alert fired.', message.message_id);
    return;
  }

  if ((signal.algo || '').includes('V10')) {
    await sendTelegram('⚠️ <b>V10 shadow signal — no slippage logging</b>\nThis was a V10 experimental signal. Only reply "traded" to V9 signals.', message.message_id);
    return;
  }

  const signalPrice     = parseFloat(signal.price);
  const slippagePts     = fillPrice - signalPrice;
  const multiplier      = getMultiplier(signal.ticker);
  const slippageDollars = slippagePts * multiplier;
  const sign = slippageDollars >= 0 ? '+' : '';

  const isShort = (signal.signal || '').toUpperCase() === 'SHORT' ||
                  (signal.signal || '').toUpperCase() === 'SELL';

  const sigThreshold = signal.ticker.includes('GF') ? 500 :
                       signal.ticker.includes('ZC') ? 100 :
                       signal.ticker.includes('ZS') ? 100 :
                       (signal.ticker.includes('ES') || signal.ticker.includes('SP')) ? 500 : 100;

  const verdict = isShort
    ? (slippageDollars >= 0 ? '✅ favorable' :
       Math.abs(slippageDollars) < sigThreshold ? '⚠️ minor adverse' : '🛑 significant adverse')
    : (slippageDollars <= 0 ? '✅ favorable' :
       Math.abs(slippageDollars) < sigThreshold ? '⚠️ minor adverse' : '🛑 significant adverse');

  let confirmMsg =
    '✅ <b>SLIPPAGE LOGGED</b>\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📋 ' + signal.ticker + ' — ' + signal.signal + '\n' +
    '🎯 Signal: <b>' + signal.price + '</b>\n' +
    '💵 Fill:   <b>' + fillPrice + '</b>\n' +
    '📊 Slip: ' + sign + slippagePts.toFixed(4) + ' pts  (' + sign + '$' + slippageDollars.toFixed(2) + ')\n' +
    verdict + '\n';

  // Sizing shadow record confirmation (ES/SP500 only)
  if (signal.atr || signal.suggestedMes) {
    confirmMsg += '━━━━━━━━━━━━━━━━\n';
    if (signal.atr) confirmMsg += '📊 ATR logged: <b>' + signal.atr + '</b>\n';
    if (signal.suggestedMes) confirmMsg += '📐 Vol-scaled size logged: <b>' + signal.suggestedMes + ' MES</b>\n';
  }

  confirmMsg += '<i>' + signal.algo + '</i>';

  await sendTelegram(confirmMsg, message.message_id);
  const sheetResult = await logToSheet({
    action:          'logSlippage',
    ticker:          signal.ticker,
    signal:          signal.signal,
    signalPrice:     signal.price,
    fillPrice:       fillPrice.toString(),
    slippagePts:     slippagePts.toFixed(4),
    slippageDollars: slippageDollars.toFixed(2),
    algo:            signal.algo,
    atr:             signal.atr || '',
    suggestedMes:    signal.suggestedMes || ''
  });
  console.log('Slippage logged:', signal.ticker, 'signal=' + signal.price, 'fill=' + fillPrice, 'slip=$' + slippageDollars.toFixed(2), 'atr=' + signal.atr, 'mes=' + signal.suggestedMes, 'sheet=' + sheetResult);
}

// ★ NEW (July 17, 2026): Handle manual price commands from Telegram.
//   "prices"              → returns the current Prices-tab list
//   "price TICKER VALUE"  → writes/updates one price (e.g. price GFX2026 356.50)
// Uses the SAME logToSheet() path as everything else, so it hits the Apps
// Script updatePrice/getPrices actions on APPS_SCRIPT_URL. Returns true if it
// handled the message (so the caller can stop), false otherwise.
async function handlePriceCommand(update) {
  const message = update.message;
  if (!message) return false;
  const rawText = (message.text || '').trim();

  // "prices" — list everything currently stored
  if (/^prices$/i.test(rawText)) {
    const list = await logToSheet({ action: 'getPrices' });
    await sendTelegram('💲 <b>Current Prices</b>\n━━━━━━━━━━━━━━━━\n' + (list || '(none)'), message.message_id);
    console.log('prices command run →', (list || '').toString().slice(0, 120));
    return true;
  }

  // "price TICKER VALUE" — set/update one contract
  const priceMatch = rawText.match(/^price\s+(\S+)\s+([\d.]+)/i);
  if (priceMatch) {
    const result = await logToSheet({ action: 'updatePrice', ticker: priceMatch[1], price: priceMatch[2] });
    const ok = /^OK/i.test((result || '').toString());
    await sendTelegram((ok ? '✅ ' : '⚠️ ') + result, message.message_id);
    console.log('price command run —', priceMatch[1], priceMatch[2], '→', (result || '').toString().slice(0, 120));
    return true;
  }

  // Started with "price" but the format was wrong — show usage instead of silence
  if (/^price(\s|$)/i.test(rawText)) {
    await sendTelegram('Usage: <code>price TICKER VALUE</code>\nExample: <code>price GFX2026 356.50</code>\nOr text <code>prices</code> to see the full list.', message.message_id);
    return true;
  }

  return false;
}

// ── HTTP Server ───────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('🌽🫘🐄📈 Jarvis Trading Server — Online (Slippage + Sizing Shadow Active)');
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
      const sigUpper = (data.signal || '').toUpperCase();

      // ★ NEW: WATCH passthrough — FC V9 Watch heads-up. Send a Telegram
      // notification ONLY. No Sheet write, no stored signal (nothing was
      // traded, so there's nothing to reply "traded" to). Must come BEFORE
      // the normal alert path so it never lands a junk row in the log.
      if (sigUpper === 'WATCH' || sigUpper === 'WATCH_SHORT' || sigUpper === 'WATCH_LONG') {
        await sendTelegram(formatWatch(data));
        console.log('WATCH forwarded (no log, no store):', data.ticker, data.signal);
        return;
      }

      // SKIP = composite filter suppressed an entry (SP500 V2 dead-zone).
      // Log to the sheet for the dashboard skip counter, but no Telegram
      // ping and no stored signal — nothing was traded, so there's nothing
      // to reply "traded" to. Prevents noise pings and bogus slippage logs.
      if (sigUpper === 'SKIP') {
        await logToSheet({ ticker: data.ticker || '', signal: data.signal || '', price: data.price || '', algo: data.algo || '', message: data.message || body });
        console.log('SKIP logged (no Telegram, no store):', data.ticker, data.price);
        return;
      }

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

        // ── TEST command — exercises the full Sheet-write chain on demand ──
        // Text "test" to the bot to verify logging end-to-end. It performs a
        // real write to the Sheet (a TEST row), then reports the actual result
        // back to you — including whether APPS_SCRIPT_URL is even loaded.
        // This is the same logToSheet() path the live alerts use, so if this
        // succeeds, real signals will log too.
        const incomingText = (update.message && update.message.text || '').trim().toLowerCase();
        if (incomingText === 'test') {
          const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
          const sheetResult = await logToSheet({
            ticker:  'TEST',
            signal:  'TEST',
            price:   '0',
            algo:    'SYSTEM TEST',
            message: 'connectivity test ' + stamp
          });
          const ok = /OK/i.test(sheetResult);
          const report =
            (ok ? '✅ <b>TEST PASSED</b>' : '❌ <b>TEST — check result</b>') + '\n' +
            '━━━━━━━━━━━━━━━━\n' +
            'APPS_SCRIPT_URL: ' + (APPS_SCRIPT_URL ? '✅ SET' : '❌ MISSING') + '\n' +
            'Telegram: ✅ working (you got this)\n' +
            'Sheet write reply: <code>' + (sheetResult || '(empty)').toString().slice(0, 120) + '</code>\n' +
            '⏰ ' + stamp + ' CT\n\n' +
            '<i>Now open Sheet1 — a TEST row should appear. If it did, logging is fully live.</i>';
          await sendTelegram(report, update.message.message_id);
          console.log('TEST command run — sheet result:', sheetResult);
          return;
        }

        // ★ NEW: price / prices commands. Check before the "traded" reply
        // handler — a price command is a fresh message, not a reply, so it
        // wouldn't be caught there anyway, but handling it explicitly and
        // returning keeps the paths clean.
        const handledPrice = await handlePriceCommand(update);
        if (handledPrice) return;

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
