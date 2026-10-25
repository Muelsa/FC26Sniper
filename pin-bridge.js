// pin-bridge.js - Eseguito nel MAIN world della Web App di EA
// Nota: questo script gira nel contesto della pagina, dove altro codice ostile
// potrebbe osservare window.postMessage. La superficie è ridotta: niente token nei log,
// targetOrigin mai "*", validazione stretta dei messaggi in ingresso.
(function () {
  "use strict";

  if (typeof window.__FC_SNIPER_BRIDGE_CLEANUP__ === "function") {
    try { window.__FC_SNIPER_BRIDGE_CLEANUP__(); } catch (_) {}
  }

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

  let lastPersonaSent = null;

  function sendUserInfo(userInfo) {
    if (!userInfo || typeof userInfo !== "object") return;
    const personaName = userInfo.personaName || "";
    const clubName = userInfo.clubName || "";
    const key = `${personaName}::${clubName}`;
    if (!personaName && !clubName) return;
    if (key === lastPersonaSent) return;
    lastPersonaSent = key;
    try {
      window.postMessage({ origin: "PIN_BRIDGE_USER", personaName, clubName }, ORIGIN);
    } catch (e) {}
  }

  function extractAndSendToken() {
    try {
      const s = window.services;
      let token = null;
      if (s) {
        // 1. Metodo primario e nativo EA: ID di sessione UTAS live (X-UT-SID)
        if (typeof s.Authentication?.getUtasSession === "function") {
          const session = s.Authentication.getUtasSession();
          if (session?.id) {
            token = session.id;
          }
        }

        const userObj = typeof s.User?.getUser === "function" ? s.User.getUser() : null;
        if (userObj) {
          if (!token && userObj.auth?.token) {
            token = userObj.auth.token;
          }

          // Estrazione username direttamente da getSelectedPersona()
          try {
            const persona = typeof userObj.getSelectedPersona === "function" ? userObj.getSelectedPersona() : userObj.selectedPersona;
            const personaName = persona?.name || persona?.personaName || "";
            if (personaName) {
              sendUserInfo({ personaName, clubName: "" });
            }
          } catch (_) {}
        }

        if (!token && s.Network?.client?.defaultHeaders?.['X-UT-SID']) {
          token = s.Network.client.defaultHeaders['X-UT-SID'];
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
  const maxAttempts = 60;
  const timer = setInterval(() => {
    attempts++;
    extractAndSendToken();
    const servicesFound = findEaServices();
    if ((servicesFound && lastPersonaSent) || attempts >= maxAttempts) {
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

  let currentView = "";
  let currentContext = ""; // "market" | "targets" | "tradepile" | "unassigned" | "hub" | ""
  let lastSearchPinAt = 0;
  let lastWatchlistPinAt = 0;
  let lastTradepilePinAt = 0;
  let lastUnassignedPinAt = 0;
  let lastSellPinAt = 0;
  let lastBidBuyPinAt = 0;
  let lastPageViewAt = 0;
  let lastPageViewPgid = "";
  let lastActivityAt = 0;
  let localStepCounter = 0;
  const processedRequestIds = new Set();

  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function emitPageView(pgid, force = false) {
    const pin = getPinService();
    if (!pin) return false;
    const now = Date.now();
    // Coerenza macchina a stati EA: non inviare mai due page_view consecutive con lo stesso identico pgid
    // (nella Web App reale un evento page_view scatta solo al cambio effettivo di schermata/vista)
    if (!force && currentView === pgid) {
      return false;
    }
    if (!force && lastPageViewPgid === pgid && (now - lastPageViewAt < 500)) {
      return false;
    }
    try {
      pin.sendData("page_view", { type: "menu", pgid });
      currentView = pgid;
      lastPageViewPgid = pgid;
      lastPageViewAt = Date.now();
      lastActivityAt = lastPageViewAt;
      localStepCounter++;
      return true;
    } catch (e) {
      logBridge("[FC Sniper PinBridge] Errore sendData:", String(e));
      return false;
    }
  }

  async function emitPageViewSequence(pgids) {
    const sentEvents = [];
    for (let i = 0; i < pgids.length; i++) {
      const pgid = pgids[i];
      if (!pgid || currentView === pgid) continue;
      if (sentEvents.length > 0) {
        // Micro-delay umano tra transizioni consecutive (evita timestamp identici al ms nel batch PIN)
        await sleepMs(jitter(35, 75));
      }
      if (emitPageView(pgid)) {
        sentEvents.push(pgid);
      }
    }
    return sentEvents;
  }

  function getPinStepCounter() {
    const pin = getPinService();
    if (pin) {
      const nativeStep = pin.count ?? pin.step ?? pin.stepCounter ?? pin._stepCounter ?? pin.custom?.step;
      if (nativeStep !== undefined && nativeStep !== null) {
        return nativeStep;
      }
    }
    return localStepCounter || "OK";
  }

  async function processPinEvent(type) {
    const pin = getPinService();
    if (!pin && type !== "REQUEST_TOKEN_REFRESH" && type !== "REQUEST_USER_INFO") {
      return { status: "no_pin_service", events: [], stepCounter: getPinStepCounter() };
    }

    switch (type) {
      case "TRIGGER_PIN_SEARCH": {
        const now = Date.now();
        if (now - lastSearchPinAt < 300) {
          return { status: "throttled", events: [], stepCounter: getPinStepCounter() };
        }
        lastSearchPinAt = now;

        const seq = [];
        // Se non siamo già nel flusso di ricerca mercato, transitiamo da Hub - Transfers
        if (currentContext !== "market" && currentView !== "Hub - Transfers") {
          seq.push("Hub - Transfers");
        }
        // Passaggio dalla schermata filtri di ricerca (esattamente come Back -> Search nella Web App)
        if (currentView !== "Transfer Market Search") {
          seq.push("Transfer Market Search");
        }
        // Apertura risultati di ricerca
        seq.push("Transfer Market Results - List View");

        const sentEvents = await emitPageViewSequence(seq);
        currentContext = "market";
        return {
          status: sentEvents.length > 0 ? "ok" : "already_on_view",
          events: sentEvents,
          stepCounter: getPinStepCounter()
        };
      }

      case "TRIGGER_PIN_WATCHLIST": {
        const now = Date.now();
        if (now - lastWatchlistPinAt < 350) {
          return { status: "throttled", events: [], stepCounter: getPinStepCounter() };
        }
        lastWatchlistPinAt = now;

        const seq = [];
        if (currentContext !== "targets" && currentView !== "Hub - Transfers") {
          seq.push("Hub - Transfers");
        }
        if (currentView !== "Transfer Targets - List View") {
          seq.push("Transfer Targets - List View");
        }

        const sentEvents = await emitPageViewSequence(seq);
        currentContext = "targets";
        return {
          status: sentEvents.length > 0 ? "ok" : "already_on_view",
          events: sentEvents,
          stepCounter: getPinStepCounter()
        };
      }

      case "TRIGGER_PIN_TRADEPILE": {
        const now = Date.now();
        if (now - lastTradepilePinAt < 350) {
          return { status: "throttled", events: [], stepCounter: getPinStepCounter() };
        }
        lastTradepilePinAt = now;

        const seq = [];
        if (currentContext !== "tradepile" && currentView !== "Hub - Transfers") {
          seq.push("Hub - Transfers");
        }
        if (currentView !== "Transfer List - List View") {
          seq.push("Transfer List - List View");
        }

        const sentEvents = await emitPageViewSequence(seq);
        currentContext = "tradepile";
        return {
          status: sentEvents.length > 0 ? "ok" : "already_on_view",
          events: sentEvents,
          stepCounter: getPinStepCounter()
        };
      }

      case "TRIGGER_PIN_UNASSIGNED": {
        const now = Date.now();
        if (now - lastUnassignedPinAt < 350) {
          return { status: "throttled", events: [], stepCounter: getPinStepCounter() };
        }
        lastUnassignedPinAt = now;

        const seq = [];
        if (currentContext !== "unassigned" && currentView !== "Hub - Transfers") {
          seq.push("Hub - Transfers");
        }
        if (currentView !== "Unassigned Items - List View") {
          seq.push("Unassigned Items - List View");
        }

        const sentEvents = await emitPageViewSequence(seq);
        currentContext = "unassigned";
        return {
          status: sentEvents.length > 0 ? "ok" : "already_on_view",
          events: sentEvents,
          stepCounter: getPinStepCounter()
        };
      }

      case "TRIGGER_PIN_SELL": {
        const now = Date.now();
        if (now - lastSellPinAt < 250) {
          return { status: "throttled", events: [], stepCounter: getPinStepCounter() };
        }
        lastSellPinAt = now;

        const seq = [];
        // Se non siamo già su una lista/dettaglio valido (mercato, watchlist, tradepile o unassigned), apriamo la Transfer List
        if (!currentContext) {
          if (currentView !== "Hub - Transfers") {
            seq.push("Hub - Transfers");
          }
          seq.push("Transfer List - List View");
          currentContext = "tradepile";
        }
        if (currentView !== "Item - Detail View") {
          seq.push("Item - Detail View");
        }

        const sentEvents = await emitPageViewSequence(seq);
        return {
          status: sentEvents.length > 0 ? "ok" : "already_on_view",
          events: sentEvents,
          stepCounter: getPinStepCounter()
        };
      }

      case "TRIGGER_PIN_BUY_NOW":
      case "TRIGGER_PIN_BID": {
        const now = Date.now();
        if (now - lastBidBuyPinAt < 250) {
          return { status: "throttled", events: [], stepCounter: getPinStepCounter() };
        }
        lastBidBuyPinAt = now;

        const seq = [];
        if (!currentContext) {
          if (currentView !== "Hub - Transfers") {
            seq.push("Hub - Transfers");
          }
          seq.push("Transfer Market Results - List View");
          currentContext = "market";
        }
        if (currentView !== "Item - Detail View") {
          seq.push("Item - Detail View");
        }

        const sentEvents = await emitPageViewSequence(seq);
        return {
          status: sentEvents.length > 0 ? "ok" : "already_on_view",
          events: sentEvents,
          stepCounter: getPinStepCounter()
        };
      }

      case "REQUEST_TOKEN_REFRESH":
        performNativeWebAppKeepAlive(true);
        extractAndSendToken();
        return { status: "refresh_ok", events: [], stepCounter: getPinStepCounter() };

      case "REQUEST_USER_INFO":
        extractAndSendToken();
        return { status: "user_ok", events: [], stepCounter: getPinStepCounter() };

      default:
        return { status: "ignored", events: [], stepCounter: getPinStepCounter() };
    }
  }

  async function drainQueue() {
    if (pinBusy) return;
    pinBusy = true;
    while (pinQueue.length > 0) {
      const job = pinQueue.shift();
      let res = { status: "ok", detail: "", events: [], stepCounter: "OK" };
      try {
        const out = await processPinEvent(job.type, job.payload);
        if (out) res = Object.assign(res, out);
      } catch (e) {
        res.status = "error";
        res.detail = String(e).slice(0, 200);
      }
      ack(job.requestId, res.status, res.detail, res.events, res.stepCounter);
    }
    pinBusy = false;
  }

  function enqueuePinEvent(requestId, type, payload) {
    if (typeof requestId === "string" && requestId) {
      if (processedRequestIds.has(requestId)) {
        return; // Già ricevuto ed elaborato, non eseguire due volte
      }
      processedRequestIds.add(requestId);
      if (processedRequestIds.size > 300) {
        const first = processedRequestIds.values().next().value;
        processedRequestIds.delete(first);
      }
    }
    if (pinQueue.length >= PIN_QUEUE_MAX) {
      ack(requestId, "dropped_queue_full", "", [], "OK");
      return;
    }
    pinQueue.push({ requestId, type, payload });
    drainQueue();
  }

  function ack(requestId, status, detail, events = [], stepCounter = "OK") {
    try {
      window.postMessage({
        origin: "PIN_BRIDGE_ACK",
        requestId,
        status,
        detail: detail || "",
        events: Array.isArray(events) ? events : [],
        stepCounter: stepCounter !== undefined && stepCounter !== null ? String(stepCounter) : "OK"
      }, ORIGIN);
    } catch (e) {}
  }

  // --- Keep-alive nativo EA ---
  // Solo se c'è stata attività recente (ultimi 15 min), con finestra jittered 8-12 minuti.
  let lastNativeKeepAlive = 0;
  let nextKeepAliveInterval = 0;

  function performNativeWebAppKeepAlive(force = false) {
    const now = Date.now();

    if (!force) {
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

  const keepAliveTimer = setInterval(() => performNativeWebAppKeepAlive(false), 60000);

  const ALLOWED_TYPES = new Set([
    "TRIGGER_PIN_SEARCH",
    "TRIGGER_PIN_BUY_NOW",
    "TRIGGER_PIN_BID",
    "TRIGGER_PIN_WATCHLIST",
    "TRIGGER_PIN_TRADEPILE",
    "TRIGGER_PIN_UNASSIGNED",
    "TRIGGER_PIN_SELL",
    "REQUEST_TOKEN_REFRESH",
    "REQUEST_USER_INFO"
  ]);

  const onWindowMessage = (event) => {
    if (event.source !== window) return;
    if (event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.origin !== "FC_SNIPER_EXTENSION") return;

    const { requestId, type, payload } = data;
    if (typeof requestId !== "string" || typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
      return;
    }

    const safePayload = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : {};
    enqueuePinEvent(requestId, type, safePayload);
  };

  window.addEventListener("message", onWindowMessage);

  window.__FC_SNIPER_BRIDGE_LOADED__ = true;
  window.__FC_SNIPER_BRIDGE_CLEANUP__ = () => {
    try { clearInterval(timer); } catch (_) {}
    try { clearInterval(keepAliveTimer); } catch (_) {}
    try { window.removeEventListener("message", onWindowMessage); } catch (_) {}
    delete window.__FC_SNIPER_BRIDGE_LOADED__;
  };
})();
