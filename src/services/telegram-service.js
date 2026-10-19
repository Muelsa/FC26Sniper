// Servizio di notifica Telegram: invia un report a fine di ogni ciclo di trading
// (lazy, sniping o bidding) con carte acquistate, carte vendute e crediti posseduti.

import { getTelegramChatId, getUserProfile } from '../core/storage.js';

// Token del bot Telegram (hard-coded)
const TELEGRAM_BOT_TOKEN = "8874144943:AAFHn9wUkuF5GVmFwdCmWzZOcc6oQA0gLZk"; // <- INSERISCI QUI IL TOKEN DEL BOT

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// Ultimo timestamp di invio: evita di intasare l'API se i cicli si susseguono troppo velocemente
const MIN_INTERVAL_MS = 5000;
let lastSendTimestamp = 0;

/**
 * Invia un messaggio di testo al chat ID configurato nella UI (o specificato come override).
 * Silenzioso in caso di errore: non deve mai fermare il ciclo di trading.
 * @param {string} text
 * @param {string} [targetChatId]
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendTelegramMessage(text, targetChatId = null) {
  try {
    const chatId = (targetChatId || await getTelegramChatId()).trim();
    if (!chatId) {
      return { success: false, error: 'Chat ID non inserito' };
    }
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.startsWith('_')) {
      return { success: false, error: 'Token Bot Telegram non configurato' };
    }

    // Throttle leggero anti-spam (applicato solo agli invii automatici, se targetChatId è nullo)
    if (!targetChatId) {
      const now = Date.now();
      const elapsed = now - lastSendTimestamp;
      if (elapsed > 0 && elapsed < MIN_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
      }
      lastSendTimestamp = Date.now();
    }

    const response = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`[Telegram] Invio fallito (${response.status}): ${body}`);
      let desc = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed.description) desc = parsed.description;
      } catch (_) {}
      return { success: false, error: desc };
    }
    return { success: true };
  } catch (e) {
    console.warn('[Telegram] Errore invio messaggio:', e);
    return { success: false, error: e?.message || 'Errore di connessione' };
  }
}

/**
 * Report di fine ciclo: carte acquistate, carte vendute (se il conteggio è
 * stato effettuato) e crediti posseduti.
 * @param {string} strategy - "lazy" | "sniping" | "bidding"
 * @param {{acquistate: number, vendute: number|null, crediti: number}} data
 */
export async function sendCycleReport(strategy, { acquistate, vendute, crediti }) {
  const label = strategy === 'lazy' ? 'Lazy Trading' : strategy === 'bidding' ? 'Bidding' : 'Sniping';
  let text = `⚡ <b>Fine Ciclo - ${label}</b>\n`;

  // Info account / username per distinguere account multipli
  try {
    const { personaName } = await getUserProfile();
    if (personaName) {
      text += `👤 Account: <b>${personaName}</b>\n`;
    }
  } catch (_) {}

  text += `🛒 Carte acquistate: <b>${acquistate}</b>\n`;

  // Carte vendute: mostrata solo se il conteggio è stato effettuato in questo ciclo
  if (vendute !== null && vendute !== undefined) {
    text += `💰 Carte vendute: <b>${vendute}</b>\n`;
  }
  text += `💳 Crediti posseduti: <b>${typeof crediti === 'number' ? crediti.toLocaleString('it-IT') : crediti}</b>`;

  return sendTelegramMessage(text);
}
