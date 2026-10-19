// pin-bridge.js - Eseguito nel MAIN world della Web App di EA
// Nota: questo script gira nel contesto della pagina, dove altro codice ostile
// potrebbe osservare window.postMessage. La superficie è ridotta: niente token nei log,
// targetOrigin mai "*", validazione stretta dei messaggi in ingresso.
(function () {
  "use strict";

  const ORIGIN = window.location.origin;

  function logBridge(msg, extra = null) {
    if (extra !== null) {
      console.log(msg, extra);
    } else {
      console.log(msg);
    }
    try {
      window.postMessage({
        origin: "PIN_BRIDGE_LOG",
        text: String(msg).slice(0, 500),
        extra: extra ? JSON.parse(JSON.stringify(extra)) : null
      }, ORIGIN);
    } catch (e) {}
  }

  let eaPinService = null;
  let eaAppServices = null;

  // Ultimo token inviato: deduplica alla fonte (content.js deduplica comunque)
  let lastTokenSent = null;

  function sendToken(token) {
    if (typeof token !== "string" || !token || token === lastTokenSent) return;
    lastTokenSent = token;
    try {
      window.postMessage({ origin: "PIN_BRIDGE_TOKEN", token }, ORIGIN);
    } catch (e) {}
  }

  // Intercettazione XMLHttpRequest per catturare X-UT-SID
  try {
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      if (header && typeof header === "string" && header.toLowerCase() === "x-ut-sid") {
        sendToken(value);
      }
      return origSetRequestHeader.apply(this, arguments);
    };
  } catch (e) {}

  // Intercettazione window.fetch per catturare X-UT-SID
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (init && init.headers) {
        let token = null;
        if (typeof init.headers.get === "function") {
          token = init.headers.get("x-ut-sid");
        } else if (typeof init.headers === "object") {
          token = init.headers["X-UT-SID"] || init.headers["x-ut-sid"];
        }
        if (token) sendToken(token);
      }
      return origFetch.apply(this, arguments);
    };
  } catch (e) {}

  function extractAndSendToken() {
    try {
      const s = window.services || (typeof window.getAppServices === "function" ? window.getAppServices() : null);
      let token = null;
      if (s) {
        if (s.User?.getUser()?.auth?.token) {
          token = s.User.getUser().auth.token;
        } else if (s.Network?.client?.defaultHeaders?.['X-UT-SID']) {
          token = s.Network.client.defaultHeaders['X-UT-SID'];
        } else if (typeof s.Authentication?.getAuthToken === "function") {
          token = s.Authentication.getAuthToken();
        } else if (s.User?.auth?.token) {
          token = s.User.auth.token;
        }
      }
      if (token) sendToken(token);
    } catch (_) {}
  }

  function findEaServices() {
    try {
      if (window.services && window.services.PIN) {
        eaPinService = window.services.PIN;
        eaAppServices = window.services;
        extractAndSendToken();
        return true;
      }

      if (typeof window.getAppServices === "function") {
        const appServices = window.getAppServices();
        if (appServices) {
          eaAppServices = appServices;
          extractAndSendToken();
          if (typeof appServices.getPinService === "function") {
            eaPinService = appServices.getPinService();
            return true;
          }
        }
      }

      if (window.PIN || window.PinService) {
        eaPinService = window.PIN || window.PinService;
        extractAndSendToken();
        return true;
      }

      const rootEl = document.querySelector("body") || document.documentElement;
      if (window.angular && rootEl) {
        const injector = window.angular.element(rootEl).injector?.();
        if (injector) {
          const pin = injector.get("PIN") || injector.get("PinService");
          if (pin) {
            eaPinService = pin;
            extractAndSendToken();
            return true;
          }
        }
      }
    } catch (e) {
      logBridge("[FC Sniper PinBridge] Errore ricerca servizi EA:", String(e));
    }
    return false;
  }

  let attempts = 0;
  const maxAttempts = 30;
  const timer = setInterval(() => {
    attempts++;
    extractAndSendToken();
    if (findEaServices() || attempts >= maxAttempts) {
      clearInterval(timer);
      extractAndSendToken();
    }
  }, 1500);

  function getPinService() {
    if (window.services && window.services.PIN && typeof window.services.PIN.sendData === "function") {
      eaPinService = window.services.PIN;
      return eaPinService;
    }
    if (eaPinService && typeof eaPinService.sendData === "function") {
      return eaPinService;
    }
    findEaServices();
    return eaPinService;
  }

  // --- Coda PIN bounded: nessuna richiesta scartata per throttle ---
  const PIN_QUEUE_MAX = 50;
  const pinQueue = [];
  let pinBusy = false;

  const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let currentView = "";
  let lastViewChangeAt = 0;
  let lastActivityAt = 0;

  // Emette un page_view solo se diverso dalla vista corrente o mai nello stesso tick
  function emitPageView(pgid, force = false) {
    const pin = getPinService();
    if (!pin) return false;
    const now = Date.now();
    if (!force && currentView === pgid && now - lastViewChangeAt < 50) return true; // no doppie page_view nello stesso tick
    if (!force && currentView === pgid) return true; // deduplica view ripetute
    try {
      pin.sendData("page_view", { type: "menu", pgid });
      currentView = pgid;
      lastViewChangeAt = now;
      lastActivityAt = now;
      return true;
    } catch (e) {
      logBridge("[FC Sniper PinBridge] Errore sendData:", String(e));
      return false;
    }
  }

  // Hub - Transfers -> destinazione, con delay jittered 300-900ms tra i due step
  async function navigateTo(pgid) {
    if (currentView !== "Hub - Transfers" && currentView !== pgid) {
      emitPageView("Hub - Transfers");
      await sleep(jitter(300, 900));
    }
    emitPageView(pgid);
  }

  async function processPinEvent(type, payload) {
    switch (type) {
      case "TRIGGER_PIN_SEARCH":
        await navigateTo("Transfer Market Results - List View");
        break;

      case "TRIGGER_PIN_WATCHLIST":
        await navigateTo("Transfer Targets - List View");
        break;

      case "TRIGGER_PIN_SELL":
        // SELL mappato sulla Transfer List (listaggio da lista trasferimenti)
        await navigateTo("Transfer List - List View");
        break;

      case "TRIGGER_PIN_BUY_NOW":
      case "TRIGGER_PIN_BID": {
        // Sequenza umana: apertura dettaglio -> breve lettura -> conferma
        await navigateTo("Item - Detail View");
        await sleep(jitter(350, 950));
        emitPageView("Item - Detail View", true); // conferma azione sulla stessa vista (forzata, tick diverso)
        lastActivityAt = Date.now();
        break;
      }

      case "REQUEST_TOKEN_REFRESH":
        performNativeWebAppKeepAlive(true);
        extractAndSendToken();
        break;

      default:
        break;
    }
  }

  async function drainQueue() {
    if (pinBusy) return;
    pinBusy = true;
    while (pinQueue.length > 0) {
      const job = pinQueue.shift();
      let status = "ok";
      let detail = "";
      try {
        await processPinEvent(job.type, job.payload);
      } catch (e) {
        status = "error";
        detail = String(e).slice(0, 200);
      }
      ack(job.requestId, status, detail);
    }
    pinBusy = false;
  }

  function enqueuePinEvent(requestId, type, payload) {
    if (pinQueue.length >= PIN_QUEUE_MAX) {
      ack(requestId, "dropped_queue_full", "");
      return;
    }
    pinQueue.push({ requestId, type, payload });
    drainQueue();
  }

  function ack(requestId, status, detail) {
    try {
      window.postMessage({
        origin: "PIN_BRIDGE_ACK",
        requestId,
        status,
        detail: detail || ""
      }, ORIGIN);
    } catch (e) {}
  }

  // --- Keep-alive nativo EA ---
  // Solo se c'è stata attività recente (ultimi 15 min), con finestra jittered 8-12 minuti.
  // Niente eventi mouse sintetici.
  let lastNativeKeepAlive = 0;
  let nextKeepAliveInterval = 0;

  function performNativeWebAppKeepAlive(force = false) {
    const now = Date.now();

    if (!force) {
      // Senza attività recente l'utente è inattivo: non simulare sessione viva
      if (now - lastActivityAt > 15 * 60 * 1000) return;
      if (now - lastNativeKeepAlive < nextKeepAliveInterval) return;
    }

    lastNativeKeepAlive = now;
    nextKeepAliveInterval = jitter(8 * 60 * 1000, 12 * 60 * 1000);

    try {
      const s = window.services || eaAppServices || (typeof window.getAppServices === "function" ? window.getAppServices() : null);
      if (s) {
        if (s.User && typeof s.User.requestCurrencies === "function") {
          s.User.requestCurrencies();
        } else if (s.User && typeof s.User.getUser === "function" && typeof s.User.getUser()?.requestCurrencies === "function") {
          s.User.getUser().requestCurrencies();
        }
        if (s.Authentication && typeof s.Authentication.refreshToken === "function") {
          s.Authentication.refreshToken();
        }
      }
      setTimeout(extractAndSendToken, 1200);
    } catch (e) {
      logBridge("[FC Sniper PinBridge] Errore keep-alive nativo:", String(e));
    }
  }

  // Scheduler: controlla ogni minuto; la funzione decide se agire
  // (solo attività recente + intervallo jittered 8-12 min, mai 8 minuti esatti)
  setInterval(() => performNativeWebAppKeepAlive(false), 60000);

  const ALLOWED_TYPES = new Set([
    "TRIGGER_PIN_SEARCH",
    "TRIGGER_PIN_BUY_NOW",
    "TRIGGER_PIN_BID",
    "TRIGGER_PIN_WATCHLIST",
    "TRIGGER_PIN_SELL",
    "REQUEST_TOKEN_REFRESH"
  ]);

  // Ascolta messaggi inoltrati da content.js
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.origin !== "FC_SNIPER_EXTENSION") return;

    const { requestId, type, payload } = data;
    if (typeof requestId !== "string" || typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
      return; // ignora richieste sconosciute/malformate
    }

    const safePayload = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : {};
    enqueuePinEvent(requestId, type, safePayload);
  });
})();
