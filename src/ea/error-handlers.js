// Gestione centralizzata errori EA, 401 Session Refresh, CAPTCHA e Pause di Sicurezza
import { botState } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent, stopBot } from '../core/messenger.js';
import { reportTelemetry } from '../core/telemetry.js';
import { sleep, getRandomGaussian } from '../core/utils.js';
import { isRateLimitStatus } from './status-policy.js';

let recovery401Promise = null;
let defaultPostPauseMaintenance = null;

export function setPostPauseMaintenance(fn) {
  defaultPostPauseMaintenance = fn;
}

// Ricarica la scheda della Web App EA e (opzionale) attende un nuovo X-UT-SID diverso da previousToken.
// Usata dal recupero automatico 401 e dal pulsante manuale "Riavvia Web App" della dashboard.
// Ritorna { found: boolean, tokenSynced: boolean }.
export async function reloadWebAppTab({ previousToken = botState.xUtSid, waitForToken = true, maxWaitSeconds = 35 } = {}) {
  try {
    const tabs = await chrome.tabs.query({});
    // Reload limitato alla sola Web App (non tutte le tab ea.com)
    const eaTabs = (tabs || []).filter(t => t.url && t.url.includes("ea-sports-fc/ultimate-team/web-app"));
    if (eaTabs.length === 0) return { found: false, tokenSynced: false };

    for (const tab of eaTabs) {
      chrome.tabs.reload(tab.id);
    }
    if (!waitForToken) return { found: true, tokenSynced: false };

    // Attesa per l'avvio della Web App e l'intercettazione del nuovo token (polling con jitter)
    for (let i = 0; i < maxWaitSeconds; i++) {
      await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.3) * 1000);
      if (botState.xUtSid && botState.xUtSid !== previousToken) {
        return { found: true, tokenSynced: true };
      }
    }
    return { found: true, tokenSynced: false };
  } catch (reloadErr) {
    console.warn("[FC Sniper] Errore durante reload Web App:", reloadErr);
    return { found: false, tokenSynced: false, error: reloadErr?.message || String(reloadErr) };
  }
}

// Gestione centralizzata errore 401 (Sessione scaduta / Unauthorized - con tentativo di recupero token)
export async function handle401Error(context = "") {
  if (recovery401Promise) return recovery401Promise;
  recovery401Promise = doRecover401(context).finally(() => { recovery401Promise = null; });
  return recovery401Promise;
}

export async function doRecover401(context = "") {
  const currentToken = botState.xUtSid;
  const ctxStr = context ? ` (${context})` : "";
  console.warn(`[FC Sniper 401] Ricevuto errore 401 in ${ctxStr}. Tentativo di recupero token fresco dalla Web App...`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[AVVISO 401${ctxStr}] Rilevato token non valido o scaduto. Richiedo sincronizzazione token fresco alla Web App...`
  });

  // 1. Chiede alla Web App aperta di estrarre e inviare il token aggiornato a caldo
  await triggerPinEvent("REQUEST_TOKEN_REFRESH");
  await sleep(2500);

  // Se è arrivato un nuovo token valido diverso da quello che ha fallito:
  if (botState.xUtSid && botState.xUtSid !== currentToken) {
    botState.consecutive401Errors = 0;
    console.log("[FC Sniper 401] Nuovo token EA catturato con successo! Sessione ripristinata.");
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RECUPERO 401 RIUSCITO] Nuovo token EA sincronizzato (${botState.xUtSid.substring(0, 10)}...). Operazioni ripristinate senza interruzione!`
    });
    return true;
  }

  // 2. Se a caldo non si rinnova (sessione JWT Web App scaduta oltre 2.5-3 ore),
  // tentiamo il reload automatico della scheda Web App: grazie ai cookie di sessione EA (SSO/remid),
  // la Web App si riavvia autenticata e genera immediatamente un nuovo X-UT-SID valido!
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[AVVISO 401] Token non rinnovabile a caldo. Ricarico la scheda Web App per rigenerare la sessione via SSO EA...`
  });
  const reloadResult = await reloadWebAppTab({ previousToken: currentToken });
  if (reloadResult.tokenSynced) {
    botState.consecutive401Errors = 0;
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RECUPERO 401 RIUSCITO] Web App ricaricata e nuova sessione catturata (${botState.xUtSid.substring(0, 10)}...). Bot ripristinato!`
    });
    return true;
  }

  // Se il token è ancora lo stesso o la sessione EA è definitivamente chiusa:
  botState.consecutive401Errors = 0;

  try {
    const { sendCycleReport } = await import('../services/telegram-service.js');
    await sendCycleReport(botState.strategyMode || 'lazy', {
      acquistate: botState.carteAcquistate,
      vendute: botState.carteVendute,
      crediti: botState.crediti,
      stato: `Token scaduto / Errore 401${ctxStr} (Sessione chiusa)`
    });
  } catch (_) { }

  await stopBot(`Errore 401${ctxStr}`);

  console.error(`[FC Sniper ABORT 401] Errore 401 Unauthorized confermato${ctxStr}. Arresto del bot.`);
  reportTelemetry('ABORT_401', `Errore 401 Unauthorized${ctxStr}. Arresto immediato.`, { context });

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[ABORT IMMEDIATO - ERRORE 401] Ricevuto errore 401 Unauthorized${ctxStr}. Sessione Web App scaduta o non valida: bot arrestato. Ricarica la Web App (F5) per rinnovare la sessione.`
  });
  return false;
}

// Gestione centralizzata Rate Limit Ricerche (429 Too Many Requests, 426 Upgrade Required, 521, 512)
export async function handleSearchRateLimit(status, context = "Ricerca") {
  botState.consecutiveSearchErrors++;
  console.warn(`[FC Sniper ${context}] Rate limit EA (${status}). Errori consecutivi: ${botState.consecutiveSearchErrors}/3`);

  if (botState.strategyMode === "lazy") {
    // In modalità Lazy, deleghiamo la gestione al ciclo principale per consentire il passaggio fluido a vendita e relist
    return;
  }

  // Implementazione migliorata con circuit breaker e backoff esponenziale
  if (botState.consecutiveSearchErrors >= 3) {
    console.warn(`[FC Sniper] Rilevati ${botState.consecutiveSearchErrors} errori consecutivi di Rate Limit (${status}) in ${context}. Avvio pausa di sicurezza attiva 10 min...`);
    botState.consecutiveSearchErrors = 0;
    await executeSafetyPause(600, `Soft-Ban Ricerche EA (${status}) in ${context}`);
  } else {
    // Implementazione migliore con backoff esponenziale basato su errori consecutivi
    const baseDelay = 25 + (botState.consecutiveSearchErrors * 5); // Delay crescente per ogni errore successivo
    const jitter = getRandomGaussian(0.8, 0.15, 0.6, 1.0);
    
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RATE LIMIT EA ${status}] Rilevato in ${context} (${botState.consecutiveSearchErrors}/3). Raffreddamento preventivo di ${Math.round(baseDelay * jitter)}s per proteggere l'account...`
    });
    await sleep(Math.max(2000, baseDelay * 1000 * jitter));
  }
}

// Gestione centralizzata CAPTCHA 458: stop immediato strategia + stato persistito + notifica UI
export async function handleCaptchaDetected(context = "") {
  const ctxStr = context ? ` (${context})` : "";
  console.warn(`[FC Sniper] CAPTCHA 458 rilevato${ctxStr}!`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
  });
  try {
    const { sendCycleReport } = await import('../services/telegram-service.js');
    await sendCycleReport(botState.strategyMode || 'lazy', {
      acquistate: botState.carteAcquistate,
      vendute: botState.carteVendute,
      crediti: botState.crediti,
      stato: `CAPTCHA 458 rilevato${ctxStr} (Verifica richiesta)`
    });
  } catch (_) {}
  await stopBot(`CAPTCHA 458 rilevato${ctxStr}`);
}

// Handler unico per errori HTTP delle ricerche di mercato: 401, 458, rate-limit (429/426/512/521), altri.
// Ritorna sempre true: il chiamante deve interrompere l'iterazione corrente.
export async function handleSearchHttpError(response, context) {
  const status = response.status;
  if (status === 401) {
    await handle401Error(context);
  } else if (status === 458) {
    await handleCaptchaDetected(context);
  } else if (isRateLimitStatus(status)) {
    await handleSearchRateLimit(status, context);
  } else {
    console.warn(`[FC Sniper ${context}] Errore HTTP ${status}: ${response.statusText}`);
  }
  return true;
}

export async function executeSafetyPause(durationSeconds = 600, reason = "Soft-Ban EA", onPostPauseMaintenance = null) {
  const totalMinutes = Math.round(durationSeconds / 60);
  console.warn(`[FC Sniper] Avvio Pausa di Sicurezza: ${reason}. Durata: ${totalMinutes} minuti (${durationSeconds}s).`);

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[PAUSA DI SICUREZZA] ${reason}. Pausa di ${totalMinutes} min per sbloccare l'account. Silenzio totale verso EA fino allo sblocco.`
  });

  // Silenzio reale: zero richieste UTAS durante il cooldown.
  // Qualsiasi traffico durante il ban resetta i timer di decay EA.
  let remaining = durationSeconds;

  while (remaining > 0 && botState.start === true) {
    await sleep(1000);
    remaining--;

    // Keep-alive Chrome Service Worker ogni 15s per evitare standby
    if (remaining % 15 === 0) {
      try { await chrome.storage.local.get(['keepAliveCheck']); } catch (_) { }
    }

    // Countdown nei log ogni 60 secondi
    if (remaining > 0 && remaining % 60 === 0) {
      const minsLeft = Math.round(remaining / 60);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PAUSA DI SICUREZZA] Sblocco soft-ban in corso... Mancano ${minsLeft} min alla ripresa automatica.`
      });
    }
  }

  // Manutenzione differita: vendite/rilist/crediti SOLO dopo la scadenza del cooldown
  if (botState.start === true) {
    try {
      const maintenanceFn = onPostPauseMaintenance || defaultPostPauseMaintenance;
      if (typeof maintenanceFn === 'function') {
        await maintenanceFn();
      }
    } catch (e) {
      console.warn("[Post-Pausa Maintenance Error]", e);
    }
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[PAUSA DI SICUREZZA TERMINATA] Account raffreddato con successo! Manutenzione eseguita, ripresa delle attività.`
    });
  }
}
