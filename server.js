const http = require('http');
const twilio = require('twilio');
const { google } = require('googleapis');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const yourNumber = process.env.YOUR_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_KEY_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

let serviceAccountKey;
try {
  serviceAccountKey = JSON.parse(SERVICE_ACCOUNT_KEY_RAW);
} catch (e) {
  console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:', e.message);
}

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    SERVICE_ACCOUNT_EMAIL,
    null,
    serviceAccountKey.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function logToSheet(data) {
  try {
    const sheets = await getSheetsClient();
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const row = [
      timestamp,
      data.ticker || '',
      data.signal || '',
      data.price || '',
      data.algo || detectAlgo(data),
      data.message || '',
      ''
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:G',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    console.log('Logged to Google Sheet:', row);
  } catch (err) {
    console.error('Google Sheets error:', err.message);
  }
}

function detectAlgo(data) {
  const text = JSON.stringify(data).toLowerCase();
  if (text.includes('zsx') || text.includes('zsu') || text.includes('bean') || text.includes('soy')) return 'Jarvis SB V1';
  if (text.includes('gff') || text.includes('gfk') || text.includes('gfu') || text.includes('cattle') || text.includes('feeder')) return 'FC V8a';
  if (text.includes('zcz') || text.includes('zcn') || text.includes('corn')) return 'FC V8c Corn';
  return 'Unknown';
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
