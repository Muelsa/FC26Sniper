#!/usr/bin/env node
/**
 * FC Sniper & Trader - Native Messaging Host Updater
 * Protocollo Chrome Native Messaging (stdin/stdout con prefisso 4-byte little endian).
 * Multipiattaforma: macOS, Windows, Linux.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const child_process = require('child_process');

const PROJECT_DIR = path.resolve(__dirname);

// File e cartelle locali protetti (NON sovrascritti durante gli aggiornamenti)
const PRESERVED_ITEMS = new Set([
  '.git',
  '.DS_Store',
  'runtime-telemetry.log',
  'runtime-telemetry.1.log',
  'fodder-data.json',
  '.env',
  'node_modules'
]);

function log(...args) {
  // Tutti i log dell'host nativo devono andare su stderr per non corrompere stdout
  console.error('[FC Sniper Native Updater]', ...args);
}

// Invia un messaggio JSON conforme a Chrome Native Messaging su stdout
function sendNativeMessage(msg) {
  try {
    const jsonStr = JSON.stringify(msg);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(jsonBuf.length, 0);
    process.stdout.write(Buffer.concat([lenBuf, jsonBuf]));
  } catch (err) {
    log('Errore invio messaggio nativo:', err);
  }
}

// Download HTTP/HTTPS con gestione automatica dei redirect (301, 302, 307, 308)
function downloadFile(fileUrl, destPath, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Troppi redirect durante il download'));
    }

    const client = fileUrl.startsWith('https:') ? https : http;
    const req = client.get(fileUrl, {
      headers: {
        'User-Agent': 'FC26Sniper-Native-Updater',
        'Accept': 'application/octet-stream, application/zip, */*'
      }
    }, (res) => {
      // Gestione redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
          const parsed = new URL(fileUrl);
          redirectUrl = new URL(redirectUrl, parsed.origin).href;
        }
        res.resume(); // drena il corpo
        return resolve(downloadFile(redirectUrl, destPath, maxRedirects - 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download fallito con status HTTP ${res.statusCode}`));
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve(destPath));
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });

    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Timeout durante il download della release (60s)'));
    });
  });
}

// Estrazione cross-platform (macOS, Linux, Windows) senza dipendenze npm
function extractZipCrossPlatform(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  log(`Estrazione archivio ${zipPath} in ${destDir} (piattaforma: ${process.platform})`);

  if (process.platform === 'win32') {
    // Windows 10/11 include tar.exe in System32
    try {
      child_process.execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { stdio: 'pipe' });
      return;
    } catch (_) {
      // Fallback universale PowerShell
      const psCmd = `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force"`;
      child_process.execSync(psCmd, { stdio: 'pipe' });
      return;
    }
  }

  // macOS & Linux
  try {
    child_process.execSync(`unzip -q -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
  } catch (_) {
    child_process.execSync(`tar -xf "${zipPath}" -C "${destDir}"`, { stdio: 'pipe' });
  }
}

// Trova la cartella effettiva del repository all'interno dell'archivio estratto
function resolveExtractedSourceDir(extractRoot) {
  const entries = fs.readdirSync(extractRoot, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const candidate = path.join(extractRoot, entries[0].name);
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(extractRoot, entry.name);
      if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
        return candidate;
      }
    }
  }
  return extractRoot;
}

// Copia ricorsiva sicura dei file aggiornati escludendo i dati protetti
function applyUpdateFiles(sourceDir, targetDir) {
  log(`Sostituzione file da ${sourceDir} a ${targetDir}...`);
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const relative = path.relative(sourceDir, src);
      if (!relative) return true; // root
      const rootSegment = relative.split(path.sep)[0];
      if (PRESERVED_ITEMS.has(rootSegment)) {
        log(`Preservo elemento locale: ${rootSegment}`);
        return false;
      }
      return true;
    }
  });
}

// Gestione dell'aggiornamento
async function handleUpdateAction(payload) {
  const { zipUrl, tag } = payload;
  if (!zipUrl) {
    throw new Error('URL del file zip non fornito');
  }

  const tempId = `fc26_update_${Date.now()}`;
  const tempZipPath = path.join(os.tmpdir(), `${tempId}.zip`);
  const tempExtractDir = path.join(os.tmpdir(), tempId);

  try {
    log(`Inizio download release [${tag || 'latest'}] da: ${zipUrl}`);
    await downloadFile(zipUrl, tempZipPath);
    log(`Download completato (${fs.statSync(tempZipPath).size} bytes).`);

    extractZipCrossPlatform(tempZipPath, tempExtractDir);

    const sourceDir = resolveExtractedSourceDir(tempExtractDir);
    log(`Directory sorgente identificata: ${sourceDir}`);

    if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
      throw new Error("L'archivio scaricato non contiene un manifest.json valido.");
    }

    applyUpdateFiles(sourceDir, PROJECT_DIR);
    log('Aggiornamento file completato con successo!');

    // Assicura che manifest.json e package.json siano allineati alla versione del tag scaricato
    if (tag) {
      const cleanTag = String(tag).trim().replace(/^v/i, '');
      try {
        const manifestPath = path.join(PROJECT_DIR, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          manifestContent.version = cleanTag;
          fs.writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2), 'utf8');
          log(`manifest.json sincronizzato alla versione v${cleanTag}`);
        }
        const pkgPath = path.join(PROJECT_DIR, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkgContent = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          pkgContent.version = cleanTag;
          fs.writeFileSync(pkgPath, JSON.stringify(pkgContent, null, 2), 'utf8');
        }
      } catch (e) {
        log('Avviso sincronizzazione versione post-update:', e.message);
      }
    }

    return {
      success: true,
      version: tag || 'nuova versione',
      message: 'Aggiornamento completato con successo. Riavvio in corso...'
    };
  } finally {
    // Pulizia file temporanei
    try {
      if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
      if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log('Avviso pulizia temp:', cleanupErr.message);
    }
  }
}

// Buffer per i messaggi in ingresso da Chrome Native Messaging
let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) {
      // In attesa del resto del messaggio
      break;
    }

    const msgBuf = inputBuffer.slice(4, 4 + msgLen);
    inputBuffer = inputBuffer.slice(4 + msgLen);

    let message;
    try {
      message = JSON.parse(msgBuf.toString('utf8'));
    } catch (err) {
      log('Errore parsing JSON da stdin:', err);
      sendNativeMessage({ success: false, error: 'Messaggio JSON non valido' });
      continue;
    }

    log('Messaggio nativo ricevuto:', message.action || message.type);

    try {
      if (message.action === 'PING' || message.type === 'PING') {
        let currentVer = '2.8.2';
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'manifest.json'), 'utf8'));
          currentVer = manifest.version || currentVer;
        } catch (_) {}
        sendNativeMessage({
          ok: true,
          action: 'PONG',
          version: currentVer,
          platform: process.platform,
          projectDir: PROJECT_DIR
        });
      } else if (message.action === 'UPDATE' || message.type === 'UPDATE') {
        const result = await handleUpdateAction(message);
        sendNativeMessage(result);
      } else {
        sendNativeMessage({
          success: false,
          error: `Azione non riconosciuta: ${message.action || message.type}`
        });
      }
    } catch (err) {
      log('Errore elaborazione richiesta nativa:', err);
      sendNativeMessage({
        success: false,
        error: err.message || String(err)
      });
    }
  }
});

process.stdin.on('end', () => {
  log('Stdin chiuso da Chrome. Host terminato.');
  process.exit(0);
});

log('Native Messaging Host avviato e in ascolto.');
