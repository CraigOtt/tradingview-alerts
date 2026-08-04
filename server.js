// ═══════════════════════════════════════════════════════════
//  Jarvis Trading Server — v1.1 (August 4, 2026)
//
//  This file had no version header before today. Starting one, same
//  style as the Pine scripts, so the next time something breaks the
//  history is readable.
//
//  v1.1 — FIX #1: THE SERVER NO LONGER LIES TO TRADINGVIEW.
//    Symptom that led here: on July 14, 2026, eight FC V9/V10 SCALE
//    alerts fired, Telegram delivered all eight, TradingView logged
//    "Webhook successfully delivered" on all eight, and not one row
//    reached the Google Sheet. The monthly review could not tell
//    whether the alerts had fired at all.
//
//    Cause: /webhook called res.end('OK') as its FIRST action, before
//    parsing the body, before Telegram, and before the sheet write.
//    TradingView's status column therefore only ever meant "the Node
//    process accepted the TCP request." It could never mean "the row
//    landed." logToSheet() already returns Google's reply — 'OK' on a
//    successful append — and nothing looked at it.
//
//    Changes in v1.1:
//      1. /webhook now responds in a finally block AFTER the work, with
//         502 when the sheet write fails and 500 when the handler throws.
//         The response body names the outcome so the TradingView log
//         becomes readable instead of a wall of identical successes.
//      2. sheetWriteOk() inspects Google's reply. 'OK' and
//         'slippage logged' pass. Everything else fails — including the
//         silent 'NO_URL' when APPS_SCRIPT_URL is unset, and the HTML
//         error page a stale deployment returns. (This also closes fix
//         #2 from the review list.)
//      3. warnSheetFailure() pushes a 🚨 Telegram alarm on any failed
//         write, naming the ticker, signal, price and Google's reply.
//      4. formatTelegram(data) was called OUTSIDE the try block. Any
//         throw in it killed the handler with no log and no response.
//         Now inside.
//      5. logToSheet(): the https request had NO timeout, so a hung
//         Google call would never resolve. Worse, the 301/302 redirect
//         branch had NO 'error' handler at all — an unhandled 'error'
//         event on a ClientRequest throws and can take the process
//         down. Both fixed; both are plausible causes of past restarts.
//      6. sendTelegram(): added a timeout, and it now resolves null on
//         failure instead of rejecting. Since v1.1 waits for both calls
//         before answering, a hanging or rejecting Telegram request
//         would otherwise block the response or mask a sheet write that
//         actually succeeded.
//
//    KNOWN TRADEOFF: waiting for Google means a slow-but-successful
//    write can make TradingView log a failure. That is a false alarm
//    replacing a false all-clear, which is the safer direction to be
//    wrong. Telegram is the reliable channel. If red statuses start
//    appearing while rows are landing, add a bounded wait.
//
//    NOT CHANGED IN v1.1 — see the TODO in handleTelegramReply(). The
//    "SLIPPAGE LOGGED" confirmation is still sent BEFORE the sheet
//    write is awaited, so it has the same problem this version just
//    fixed for /webhook. Left alone deliberately so this deploy tests
//    exactly one thing.
// ═══════════════════════════════════════════════════════════

const http = require('http');
const https = require('https');

// ── Environment variables ─────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;

// ── Timeouts (v1.1) ───────────────────────────
// Nothing outbound was time-bounded before. A hung call used to mean the
// webhook never answered at all.
const SHEET_TIMEOUT_MS    = 10000;
const TELEGRAM_TIMEOUT_MS = 8000;

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
// NOTE: order matters. 'ZS' is checked before the generic 'ES' branch, so
// ZS1! (soybeans, $50/pt) can never fall through to the equity multiplier.
function getMultiplier(ticker) {
  if (ticker.includes('GF')) return 500;
  if (ticker.includes('ZC')) return 50;
  if (ticker.includes('ZS')) return 50;
  if (ticker.includes('MES')) return 5;
  if (ticker.includes('ES') || ticker.includes('SP')) return 50;
  return 1;
}

// Shared emoji resolver — one place, used by both the fill-alert formatter
// and the WATCH formatter.
function marketEmoji(ticker) {
  const t = ticker || '';
  if (t.includes('GF')) return '🐄';
  if (t.includes('ZC')) return '🌽';
  if (t.includes('ZS')) return '🫘';
  if (t.includes('ES') || t.includes('SP') || t.includes('MES')) return '📈';
  return '📊';
}

// ── Send Telegram message — returns message_id, or null ─
// v1.1: time-bounded, and resolves null on failure rather than rejecting.
// A Telegram outage must not block the webhook response or make a
// successful sheet write look like a crash.
function sendTelegram(text, replyToMessageId) {
  return new Promise((resolve) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log('Telegram not configured — skipping');
      resolve(null);
      return;
    }

    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

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
          if (!messageId) console.error('Telegram returned no message_id:', data.slice(0, 200));
          console.log('Telegram sent, message_id:', messageId);
          done(messageId || null);
        } catch (e) {
          console.error('Telegram response (parse error):', data.slice(0, 200));
          done(null);
        }
      });
    });

    req.setTimeout(TELEGRAM_TIMEOUT_MS, () => {
      req.destroy(new Error('Telegram did not respond in ' + TELEGRAM_TIMEOUT_MS + 'ms'));
    });
    req.on('error', (err) => {
      console.error('Telegram error:', err.message);
      done(null);
    });
    req.write(payloadStr);
    req.end();
  });
}

// ── Log to Google Sheet via Apps Script ───────
// Returns Google's raw reply text so callers can verify success.
// v1.1: both the initial request and the redirect follow are now
// time-bounded and both have error handlers. The redirect branch
// previously had neither.
function logToSheet(params) {
  return new Promise((resolve) => {
    if (!APPS_SCRIPT_URL) {
      console.error('Sheet log SKIPPED: APPS_SCRIPT_URL not set');
      resolve('NO_URL');
      return;
    }

    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const url = new URL(APPS_SCRIPT_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'User-Agent': 'Jarvis-Trading-Bot/1.0' }
    };

    const req = https.request(options, (res) => {
      // Apps Script web apps answer with a 302 to script.googleusercontent.com
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume(); // drain the redirect body

        let redirectUrl;
        try {
          redirectUrl = new URL(res.headers.location);
        } catch (e) {
          console.error('Sheet redirect had a bad Location header:', res.headers.location);
          done('ERROR: bad redirect location');
          return;
        }

        const req2 = https.request({
          hostname: redirectUrl.hostname,
          path:     redirectUrl.pathname + redirectUrl.search,
          method:   'GET',
          headers:  { 'User-Agent': 'Jarvis-Trading-Bot/1.0' }
        }, (r2) => {
          let d = '';
          r2.on('data', c => d += c);
          r2.on('end', () => {
            console.log('Sheet log [' + r2.statusCode + ']:', d.slice(0, 200));
            done(d);
          });
        });

        req2.setTimeout(SHEET_TIMEOUT_MS, () => {
          req2.destroy(new Error('Google redirect did not respond in ' + SHEET_TIMEOUT_MS + 'ms'));
        });
        req2.on('error', (err) => {
          console.error('Sheet redirect error:', err.message);
          done('ERROR: ' + err.message);
        });
        req2.end();
        return;
      }

      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('Sheet log [' + res.statusCode + ']:', d.slice(0, 200));
        done(d);
      });
    });

    req.setTimeout(SHEET_TIMEOUT_MS, () => {
      req.destroy(new Error('Google did not respond in ' + SHEET_TIMEOUT_MS + 'ms'));
    });
    req.on('error', (err) => {
      console.error('Sheet error:', err.message);
      done('ERROR: ' + err.message);
    });
    req.end();
  });
}

// ── Did the sheet actually take the row? (v1.1) ────────────
// Apps Script doGet replies with the literal 'OK'. The logSlippage action
// replies 'slippage logged'. A thrown error replies 'Error: ...'. A stale or
// misconfigured deployment returns a Google HTML error page. And logToSheet
// returns 'NO_URL' when the env var is missing. Anything that is not a
// known-good string is a failure.
function sheetWriteOk(reply) {
  const r = (reply || '').toString().trim();
  return /^OK\b/i.test(r) || /^slippage logged$/i.test(r);
}

// ── Alarm on a failed write (v1.1) ────────────────────────
// This is the message that did not exist on July 14, 2026.
async function warnSheetFailure(context, reply) {
  const detail = (reply || '(empty)').toString().slice(0, 200);
  console.error('SHEET WRITE FAILED —', context, '→', detail);
  try {
    await sendTelegram(
      '🚨 <b>SHEET WRITE FAILED</b>\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📋 ' + context + '\n' +
      '↩️ Google said: <code>' + detail + '</code>\n\n' +
      '<i>The alert fired. The row did NOT land. Log it by hand.</i>'
    );
  } catch (e) {
    console.error('Could not send the failure warning:', e.message);
  }
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

  const emoji = marketEmoji(ticker);

  let sigEmoji = '';
  if (signal === 'LONG' || signal === 'BUY') sigEmoji = '🟢';
  else if (signal === 'SHORT' || signal === 'SELL') sigEmoji = '🔴';
  else if (signal === 'FLAT') sigEmoji = '⬜';
  else if (signal === 'STOP') sigEmoji = '🛑';

  const isV10        = algo.includes('V10');
  const isSP500      = algo.includes('SP500');
  const isCarryTrend = algo.includes('CarryTrend');
  const isPaperFirst = isSP500 || isCarryTrend;

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
    text += '\n<i>Reply "traded [your fill price]" to log your fill</i>';
  }

  return text;
}

// Format the pre-market Watch heads-up (cross-confirmed notice, nothing traded).
function formatWatch(data) {
  const wtime = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sig = (data.signal || '').toUpperCase();
  const dir = sig === 'WATCH_LONG' ? '🟢 LONG' : sig === 'WATCH_SHORT' ? '🔴 SHORT' : '👀 WATCH';
  const emoji = marketEmoji(data.ticker);
  const title = (data.algo || 'WATCH') + ' — heads-up';
  let text = emoji + ' <b>' + title + '</b>\n━━━━━━━━━━━━━━━━\n';
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

  // ⚠️ TODO — FIX #3 FROM THE AUGUST 4 REVIEW LIST, NOT DONE YET.
  // This says "SLIPPAGE LOGGED" BEFORE the write is attempted, which is
  // exactly the lie v1.1 just removed from /webhook. On July 14, 2026 all
  // four of these confirmations arrived and none of the four rows landed.
  // The fix is to await logToSheet first, check it with sheetWriteOk(), and
  // then send either the confirmation or a 🚨 warning. Left as-is on purpose
  // so this deploy changes exactly one thing.
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

// ── Handle manual price commands from Telegram ──
//   "prices"              → returns the current Prices-tab list
//   "price TICKER VALUE"  → writes/updates one price
async function handlePriceCommand(update) {
  const message = update.message;
  if (!message) return false;
  const rawText = (message.text || '').trim();

  if (/^prices$/i.test(rawText)) {
    const list = await logToSheet({ action: 'getPrices' });
    await sendTelegram('💲 <b>Current Prices</b>\n━━━━━━━━━━━━━━━━\n' + (list || '(none)'), message.message_id);
    console.log('prices command run →', (list || '').toString().slice(0, 120));
    return true;
  }

  const priceMatch = rawText.match(/^price\s+(\S+)\s+([\d.]+)/i);
  if (priceMatch) {
    const result = await logToSheet({ action: 'updatePrice', ticker: priceMatch[1], price: priceMatch[2] });
    const ok = /^OK/i.test((result || '').toString());
    await sendTelegram((ok ? '✅ ' : '⚠️ ') + result, message.message_id);
    console.log('price command run —', priceMatch[1], priceMatch[2], '→', (result || '').toString().slice(0, 120));
    return true;
  }

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
    res.end('🌽🫘🐄📈 Jarvis Trading Server v1.1 — Online (verified sheet writes)');
    return;
  }

  // ═══════════════════════════════════════════════════════
  //  /webhook — v1.1: answers TradingView AFTER the work,
  //  with the real outcome.
  // ═══════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      console.log('Alert received:', body);

      let status   = 200;
      let reply    = 'OK';
      let answered = false;

      try {
        const data     = parseAlert(body);
        const sigUpper = (data.signal || '').toUpperCase();

        // WATCH passthrough — pre-market heads-up. Telegram only, no sheet
        // write by design (nothing was traded, so there is nothing to log
        // and nothing to reply "traded" to).
        if (sigUpper === 'WATCH' || sigUpper === 'WATCH_SHORT' || sigUpper === 'WATCH_LONG') {
          await sendTelegram(formatWatch(data));
          reply = 'WATCH forwarded — no sheet write by design';
          console.log('WATCH forwarded:', data.ticker, data.signal, data.algo);

        // SKIP — composite filter suppressed an entry (SP500 V2 dead zone).
        // Logged for the dashboard skip counter, no Telegram ping.
        } else if (sigUpper === 'SKIP') {
          const skipReply = await logToSheet({
            ticker:  data.ticker  || '',
            signal:  data.signal  || '',
            price:   data.price   || '',
            algo:    data.algo    || '',
            message: data.message || body
          });
          if (sheetWriteOk(skipReply)) {
            reply = 'SKIP logged';
          } else {
            status = 502;
            reply  = 'SHEET WRITE FAILED: ' + skipReply;
            await warnSheetFailure('SKIP ' + (data.ticker || '') + ' ' + (data.algo || ''), skipReply);
          }
          console.log('SKIP:', data.ticker, data.price, '→', skipReply);

        // Normal fill alert — Telegram + sheet, then verify the sheet.
        } else {
          const telegramMsg = formatTelegram(data);   // v1.1: inside the try

          const [messageId, sheetReply] = await Promise.all([
            sendTelegram(telegramMsg),
            logToSheet({
              ticker:  data.ticker  || '',
              signal:  data.signal  || '',
              price:   data.price   || '',
              algo:    data.algo    || '',
              message: data.message || body
            })
          ]);

          if (messageId && data.ticker && data.price) storeSignal(messageId, data);

          if (sheetWriteOk(sheetReply)) {
            reply = 'OK — logged ' + (data.ticker || '') + ' ' + (data.signal || '');
            console.log('Alert processed. Sheet reply:', (sheetReply || '').toString().slice(0, 120));
          } else {
            status = 502;
            reply  = 'SHEET WRITE FAILED: ' + sheetReply;
            await warnSheetFailure(
              (data.algo || '') + ' ' + (data.signal || '') + ' ' +
              (data.ticker || '') + ' @ ' + (data.price || ''),
              sheetReply
            );
          }
        }

      } catch (err) {
        status = 500;
        reply  = 'ERROR: ' + err.message;
        console.error('Alert processing error:', err.message);
        try {
          await sendTelegram(
            '🚨 <b>ALERT PROCESSING CRASHED</b>\n' +
            '━━━━━━━━━━━━━━━━\n' +
            '<code>' + err.message + '</code>\n' +
            '<i>Raw payload: ' + body.slice(0, 200) + '</i>'
          );
        } catch (e) { /* nothing left to try */ }

      } finally {
        if (!answered) {
          answered = true;
          res.writeHead(status, { 'Content-Type': 'text/plain' });
          res.end(reply);
        }
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
          // v1.1: same verifier the webhook uses, instead of a loose /OK/ match
          // that an HTML error page containing the word "ok" could satisfy.
          const ok = sheetWriteOk(sheetResult);
          const report =
            (ok ? '✅ <b>TEST PASSED</b>' : '🚨 <b>TEST FAILED</b>') + '\n' +
            '━━━━━━━━━━━━━━━━\n' +
            'APPS_SCRIPT_URL: ' + (APPS_SCRIPT_URL ? '✅ SET' : '❌ MISSING') + '\n' +
            'Telegram: ✅ working (you got this)\n' +
            'Sheet write reply: <code>' + (sheetResult || '(empty)').toString().slice(0, 160) + '</code>\n' +
            '⏰ ' + stamp + ' CT\n\n' +
            (ok
              ? '<i>Now open the log tab — a TEST row should be there. If it is not, the row landed somewhere else (see fix #4, getActiveSheet).</i>'
              : '<i>The write did NOT land. Nothing is being logged right now.</i>');
          await sendTelegram(report, update.message.message_id);
          console.log('TEST command run — sheet result:', (sheetResult || '').toString().slice(0, 160), '| ok:', ok);
          return;
        }

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

// v1.1: last-resort net. An unhandled rejection used to be able to kill the
// process silently, which is one candidate for the restarts seen in July.
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err && err.message ? err.message : err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Jarvis Trading Server v1.1 running on port ' + PORT);
  console.log('Telegram configured:', !!TELEGRAM_BOT_TOKEN, '| Chat ID:', TELEGRAM_CHAT_ID, '| Apps Script URL:', !!APPS_SCRIPT_URL);
});
