const http = require('http');
const twilio = require('twilio');
const https = require('https');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const yourNumber = process.env.YOUR_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjOQ20Qv9UosNolCXZwp0gMNGRvc4IKu9L95lyoIupo3DqeLw-VSwe5ymUqiaIVjwH5Q/exec';

function detectAlgo(data) {
  const text = JSON.stringify(data).toLowerCase();
  if (text.includes('zsx') || text.includes('bean') || text.includes('soy')) return 'Jarvis SB V1';
  if (text.includes('gff') || text.includes('cattle') || text.includes('feeder')) return 'FC V8a';
  if (text.includes('zcz') || text.includes('corn')) return 'FC V8c Corn';
  return 'Unknown';
}

async function logToSheet(data) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      ticker: data.ticker || '',
      signal: data.signal || '',
      price: data.price || '',
      algo: data.algo || detectAlgo(data),
      message: data.message || ''
    });

    const urlString = APPS_SCRIPT_URL + '?' + params.toString();
    const url = new URL(urlString);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET'
    };

    const req = require('https').request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const redirectUrl = new URL(res.headers.location);
        const redirectOptions = {
          hostname: redirectUrl.hostname,
          path: redirectUrl.pathname + redirectUrl.search,
          method: 'GET'
        };
        const req2 = require('https').request(redirectOptions, (res2) => {
          let body = '';
          res2.on('data', chunk => body += chunk);
          res2.on('end', () => { console.log('Sheet response:', body); resolve(body); });
        });
        req2.on('error', reject);
        req2.end();
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { console.log('Sheet response:', body); resolve(body); });
    });
    req.on('error', reject);
    req.end();
  });
}

function getEmoji(text) {
  const lower = text.toLowerCase();
  if (lower.includes('corn')) return '🌽';
  if (lower.includes('soybean') || lower.includes('bean')) return '🫘';
  if (lower.includes('cattle') || lower.includes('feeder')) return '🐄';
  return '📊';
}

function formatMessage(body) {
  try {
    const data = JSON.parse(body);
    const emoji = getEmoji(JSON.stringify(data));
    let msg = `${emoji} TRADING ALERT\n`;
    msg += `━━━━━━━━━━━━\n`;
    if (data.ticker)  msg += `Contract: ${data.ticker}\n`;
    if (data.signal)  msg += `Signal: ${data.signal}\n`;
    if (data.price)   msg += `Price: ${data.price}\n`;
    if (data.adx)     msg += `ADX: ${data.adx}\n`;
    if (data.mode)    msg += `Mode: ${data.mode}\n`;
    if (data.message) msg += `${data.message}\n`;
    msg += `Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })} CT`;
    return msg;
  } catch (e) {
    const emoji = getEmoji(body);
    return `${emoji} TRADING ALERT\n━━━━━━━━━━━━\n${body}\nTime: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })} CT`;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('Craig Ottun Alert Server — Online');
    return;
  }
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      console.log('Alert received:', body);
      const message = formatMessage(body);
      let data = {};
      try { data = JSON.parse(body); } catch (e) { data = { message: body }; }
      const [smsResult, sheetResult] = await Promise.allSettled([
        client.messages.create({ body: message, from: twilioNumber, to: `+1${yourNumber}` }),
        logToSheet(data)
      ]);
      if (smsResult.status === 'fulfilled') console.log('SMS sent');
      else console.error('SMS error:', smsResult.reason.message);
      if (sheetResult.status === 'fulfilled') console.log('Sheet logged');
      else console.error('Sheet error:', sheetResult.reason.message);
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
