// offscreen.js - Keep-alive audio per il Service Worker MV3.
// Il documento viene creato dal SW solo a bot attivo; l'audio parte SOLO
// su messaggio esplicito START_KEEP_ALIVE (nessun autostart).
let audioCtx = null;
let oscillator = null;
let gainNode = null;

function startAudioKeepAlive() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    oscillator = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0; // silenzioso
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();
  } catch (e) {
    stopAudioKeepAlive();
  }
}

function stopAudioKeepAlive() {
  try { if (oscillator) oscillator.stop(); } catch (_) {}
  try { if (oscillator) oscillator.disconnect(); } catch (_) {}
  try { if (gainNode) gainNode.disconnect(); } catch (_) {}
  oscillator = null;
  gainNode = null;
  if (audioCtx) {
    const ctx = audioCtx;
    audioCtx = null;
    ctx.close().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'START_KEEP_ALIVE') {
    startAudioKeepAlive();
    sendResponse({ status: 'started' });
    return false;
  }

  if (msg.type === 'STOP_KEEP_ALIVE') {
    stopAudioKeepAlive();
    sendResponse({ status: 'stopped' });
    // Chiusura pulita del documento offscreen dopo lo stop
    setTimeout(() => window.close(), 250);
    return false;
  }

  return false;
});
