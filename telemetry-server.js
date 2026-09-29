const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'runtime-telemetry.log');
const PORT = 3005;

// Scrive l'evento sul file di log locale formattato
function logEvent(event) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${event.type || 'INFO'}] ${event.message || ''} ${event.data ? JSON.stringify(event.data) : ''}\n`;
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error("Error writing to telemetry log:", err);
  });
}

const server = http.createServer((req, res) => {
  // CORS headers per consentire chiamate dall'estensione Chrome
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        logEvent(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running', logFile: LOG_FILE }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[FC Sniper Telemetry Server] In ascolto su http://127.0.0.1:${PORT}`);
  logEvent({ type: 'SERVER_START', message: 'Telemetry server avviato' });
});
