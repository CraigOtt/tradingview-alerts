const http = require('http');
const twilio = require('twilio');
const https = require('https');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const yourNumber = process.env.YOUR_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjOQ20Qv9UosNolCXZwp0gMNGRvc4IKu9L95lyoIupo3DqeLw-VSwe5ymUqiaIVjwH5Q/exec';

async function logToSheet(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);

    function makeRequest(urlString) {
      const url = new URL(urlString);
      const lib = require('https');

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          console.log('Redirecting to:', res.headers.location);
          makeRequest(res.headers.location);
          return;
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log('Sheet response:', body);
          resolve(body);
        });
      });

      req.on('error', (e) => {
        console.error('Sheet error:', e.message);
        reject(e);
      });

      req.write(payload);
      req.end();
    }

    makeRequest(APPS_SCRIPT_URL);
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
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
