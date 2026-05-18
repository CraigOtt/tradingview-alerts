const http = require('http');
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const yourNumber = process.env.YOUR_PHONE_NUMBER;

const client = twilio(accountSid, authToken);

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
    msg += `Time: ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/Chicago'})} CT`;
    return msg;
  } catch(e) {
    const emoji = getEmoji(body);
    return `${emoji} TRADING ALERT\n━━━━━━━━━━━━\n${body}\nTime: ${new Date().toLocaleTimeString('en-US', {timeZone: 'America/Chicago'})} CT`;
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
      try {
        await client.messages.create({
          body: message,
          from: twilioNumber,
          to: `+1${yourNumber}`
        });
        console.log('SMS sent');
        res.writeHead(200);
        res.end('OK');
      } catch(err) {
        console.error('Error:', err.message);
        res.writeHead(500);
        res.end('Error');
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
