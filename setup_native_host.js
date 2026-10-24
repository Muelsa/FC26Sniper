#!/usr/bin/env node
/**
 * Setup Cross-Platform per Chrome Native Messaging Host
 * Configura com.fc26sniper.updater.json su macOS, Linux e Windows.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

const HOST_NAME = 'com.fc26sniper.updater';
const PROJECT_DIR = path.resolve(__dirname);
const FIXED_EXTENSION_ID = 'omnaoogbggapphajhlkjnedcljihpdhe';

function getHostExecutablePath() {
  if (process.platform === 'win32') {
    return path.join(PROJECT_DIR, 'updater_host.bat');
  }
  return path.join(PROJECT_DIR, 'updater_host.sh');
}

function buildManifest(extensionIds = [FIXED_EXTENSION_ID]) {
  const allowedOrigins = extensionIds.map(id => `chrome-extension://${id}/`);
  return {
    name: HOST_NAME,
    description: 'FC Sniper & Trader Native Auto-Updater Host',
    path: getHostExecutablePath(),
    type: 'stdio',
    allowed_origins: allowedOrigins
  };
}

function installOnUnix(targetDirs, manifest) {
  for (const dir of targetDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const manifestPath = path.join(dir, `${HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      console.log(`[Setup Host] Manifest registrato con successo in: ${manifestPath}`);
    } catch (err) {
      console.warn(`[Setup Host] Avviso scrittura in ${dir}:`, err.message);
    }
  }

  // Assicura permessi di esecuzione sullo script shell e su node
  try {
    fs.chmodSync(path.join(PROJECT_DIR, 'updater_host.sh'), 0o755);
    fs.chmodSync(path.join(PROJECT_DIR, 'updater_host.js'), 0o755);
  } catch (_) {}
}

function installOnWindows(manifest) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const hostDir = path.join(localAppData, 'FC26Sniper', 'NativeMessagingHosts');
  fs.mkdirSync(hostDir, { recursive: true });

  const manifestPath = path.join(hostDir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[Setup Host] Manifest Windows salvato in: ${manifestPath}`);

  // Registrazione nel Registro di Windows (HKCU per non richiedere privilegi di amministratore)
  const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  const regCmd = `reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`;
  try {
    child_process.execSync(regCmd, { stdio: 'inherit' });
    console.log(`[Setup Host] Chiave Registro Windows configurata: ${regKey}`);
  } catch (err) {
    console.error(`[Setup Host] Errore configurazione registro Windows:`, err.message);
  }
}

function main() {
  const customId = process.argv[2];
  const extensionIds = [FIXED_EXTENSION_ID];
  if (customId && !extensionIds.includes(customId)) {
    extensionIds.push(customId);
  }

  const manifest = buildManifest(extensionIds);
  console.log(`[Setup Host] Configurazione host ${HOST_NAME} su piattaforma: ${process.platform}`);

  if (process.platform === 'darwin') {
    const home = os.homedir();
    const dirs = [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts')
    ];
    installOnUnix(dirs, manifest);
  } else if (process.platform === 'linux') {
    const home = os.homedir();
    const dirs = [
      path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      path.join(home, '.config', 'chromium', 'NativeMessagingHosts')
    ];
    installOnUnix(dirs, manifest);
  } else if (process.platform === 'win32') {
    installOnWindows(manifest);
  } else {
    console.error(`[Setup Host] Piattaforma non supportata: ${process.platform}`);
    process.exit(1);
  }

  console.log('[Setup Host] Configurazione completata con successo!');
}

main();
