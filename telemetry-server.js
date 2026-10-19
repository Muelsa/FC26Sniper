const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'runtime-telemetry.log');
const ROTATED_LOG_FILE = path.join(__dirname, 'runtime-telemetry.1.log');
const FODDER_DATA_FILE = path.join(__dirname, 'fodder-data.json');
const PORT = 3000;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024; // 64KB
const MAX_LOG_BYTES = 1024 * 1024; // 1MB -> rotazione su runtime-telemetry.1.log

function isOriginAllowed(origin) {
  if (!origin) return true; // richieste senza Origin (es. curl) consentite
  if (origin.startsWith('chrome-extension://')) return true;
  return origin === 'http://127.0.0.1:3000' || origin === 'http://localhost:3000';
}

// Coda serializzata per le scritture sul file di log (evita interleaving)
let writeQueue = Promise.resolve();
function enqueueLogWrite(line) {
  writeQueue = writeQueue.then(() => writeLogLine(line)).catch((err) => {
    console.error('[Telemetry] Errore scrittura log:', err);
  });
}

async function writeLogLine(line) {
  try {
    const stat = await fs.promises.stat(LOG_FILE).catch(() => null);
    if (stat && stat.size > MAX_LOG_BYTES) {
      // Rotazione semplice per dimensione: il file corrente diventa .1 (sovrascritto ad ogni giro)
      await fs.promises.rename(LOG_FILE, ROTATED_LOG_FILE).catch((err) => {
        console.error('[Telemetry] Errore rotazione log:', err);
      });
    }
    await fs.promises.appendFile(LOG_FILE, line);
  } catch (err) {
    console.error('[Telemetry] Errore append log:', err);
  }
}

// Scrive l'evento sul file di log locale formattato
function logEvent(event) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${event.type || 'INFO'}] ${event.message || ''} ${event.data ? JSON.stringify(event.data) : ''}\n`;
  enqueueLogWrite(line);
}

function isValidEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 100) return false;
  if (typeof event.message !== 'string' || event.message.length > 4000) return false;
  if (event.data !== undefined) {
    try {
      JSON.stringify(event.data);
    } catch (_) {
      return false;
    }
  }
  return true;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function handleEventPost(req, res) {
  let body = '';
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: 'Payload troppo grande (max 64KB)' });
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', () => {
    if (aborted) return;
    try {
      const event = JSON.parse(body || '{}');
      if (!isValidEvent(event)) {
        sendJson(res, 422, { error: 'Schema evento non valido: atteso {type: string, message: string, data?: serializzabile}' });
        return;
      }
      logEvent(event);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: 'Invalid JSON' });
    }
  });

  req.on('error', (err) => {
    console.error('[Telemetry] Errore stream request:', err);
  });
}

function parsePriceToCredits(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return NaN;
  const raw = value.trim().toUpperCase();
  const multiplier = raw.endsWith('M') ? 1000000 : raw.endsWith('K') ? 1000 : 1;
  const numeric = parseFloat(raw.replace(/[KM]$/, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) ? Math.round(numeric * multiplier) : NaN;
}

function handleFodderGet(req, res, url) {
  const ratingParam = url.searchParams.get('rating');
  const rating = ratingParam ? parseInt(ratingParam, 10) : null;
  if (ratingParam && (isNaN(rating) || rating < 1 || rating > 99)) {
    sendJson(res, 400, { error: 'Parametro rating non valido' });
    return;
  }

  fs.readFile(FODDER_DATA_FILE, 'utf8', (err, raw) => {
    if (err) {
      if (err.code !== 'ENOENT') {
        console.error('[Telemetry] Errore lettura fodder-data.json:', err);
      }
      sendJson(res, 503, { error: 'Dati fodder non disponibili: creare un file fodder-data.json locale con una lista di giocatori' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 503, { error: 'Dati fodder non disponibili: fodder-data.json non è un JSON valido' });
      return;
    }

    const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.players) ? parsed.players : []);
    const players = rawList
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const id = item.id ?? item.pid ?? item.assetId ?? item.resourceId ?? item.definitionid;
        const priceRaw = item.price ?? item.bin ?? item.prices?.console?.bin ?? item.prices?.ps?.bin;
        const price = parsePriceToCredits(priceRaw);
        if (!id || !Number.isFinite(price) || price <= 0) return null;
        return {
          id: String(id),
          name: typeof item.name === 'string' ? item.name : '',
          rating: Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
          price: Math.round(price)
        };
      })
      .filter(Boolean)
      .filter((p) => rating === null || p.rating === null || p.rating === rating);

    sendJson(res, 200, { players, source: 'fodder-data.json' });
  });
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    sendJson(res, 403, { error: 'Origin non ammessa' });
    req.destroy();
    return;
  }

  // CORS con allowlist (mai '*'): richieste senza Origin (curl) consentite
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/event') {
    handleEventPost(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    sendJson(res, 200, { status: 'running', logFile: 'runtime-telemetry.log' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/fut/fodder') {
    handleFodderGet(req, res, url);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[FC Sniper Telemetry Server] In ascolto su http://${HOST}:${PORT}`);
  logEvent({ type: 'SERVER_START', message: 'Telemetry server avviato' });
});
