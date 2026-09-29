// pin-bridge.js - Eseguito nel MAIN world della Web App di EA
(function () {
  function logBridge(msg, extra = null) {
    if (extra !== null) {
      console.log(msg, extra);
    } else {
      console.log(msg);
    }
    try {
      window.postMessage({
        origin: "PIN_BRIDGE_LOG",
        text: msg,
        extra: extra ? JSON.parse(JSON.stringify(extra)) : null
      }, "*");
    } catch (e) {}
  }

  logBridge("[FC Sniper PinBridge] Inizializzazione modulo nel contesto MAIN...");

  let eaPinService = null;
  let eaAppServices = null;

  // Intercettazione nativa di XMLHttpRequest nel contesto MAIN per catturare l'header X-UT-SID in tempo reale
  try {
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      if (header && typeof header === "string" && header.toLowerCase() === "x-ut-sid" && value) {
        window.postMessage({
          origin: "PIN_BRIDGE_TOKEN",
          token: value
        }, "*");
      }
      return origSetRequestHeader.apply(this, arguments);
    };
  } catch (e) {}

  // Intercettazione nativa di window.fetch per catturare X-UT-SID
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
        if (token) {
          window.postMessage({
            origin: "PIN_BRIDGE_TOKEN",
            token: token
          }, "*");
        }
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
        }
      }
      if (token) {
        logBridge("[FC Sniper PinBridge] Token x-ut-sid estratto da window.services!");
        window.postMessage({ origin: "PIN_BRIDGE_TOKEN", token }, "*");
        return token;
      }
    } catch (_) {}
    return null;
  }

  function inspectWindowGlobals() {
    try {
      const matchingKeys = Object.keys(window).filter(k => /service|ea|pin|ut|app/i.test(k));
      logBridge("[FC Sniper PinBridge] Chiavi rilevate su window:", matchingKeys);
    } catch (e) {}
  }

  // Tentativi periodici per agganciare il servizio nativo di EA
  function findEaServices() {
    try {
      if (window.services && window.services.PIN) {
        eaPinService = window.services.PIN;
        eaAppServices = window.services;
        logBridge("[FC Sniper PinBridge] Agganciato window.services.PIN con successo!");
        return true;
      }

      if (typeof window.getAppServices === "function") {
        const appServices = window.getAppServices();
        if (appServices) {
          eaAppServices = appServices;
          if (typeof appServices.getPinService === "function") {
            eaPinService = appServices.getPinService();
            logBridge("[FC Sniper PinBridge] Agganciato via getAppServices().getPinService()!");
            return true;
          }
        }
      }

      // Ricerca tra proprietà di window
      if (window.PIN || window.PinService) {
        eaPinService = window.PIN || window.PinService;
        logBridge("[FC Sniper PinBridge] Agganciato window.PIN / window.PinService!");
        return true;
      }

      // Ricerca fallback tra i controller radice dell'app Angular di EA
      const rootEl = document.querySelector("body") || document.documentElement;
      if (window.angular && rootEl) {
        const injector = window.angular.element(rootEl).injector?.();
        if (injector) {
          const pin = injector.get("PIN") || injector.get("PinService");
          if (pin) {
            eaPinService = pin;
            logBridge("[FC Sniper PinBridge] Agganciato PinService via Angular injector!");
            return true;
          }
        }
      }
    } catch (e) {
      logBridge("[FC Sniper PinBridge] Errore durante la ricerca dei servizi EA:", String(e));
    }
    return false;
  }

  // Polling per trovare i servizi EA se non sono ancora pronti
  let attempts = 0;
  const maxAttempts = 30; // 30 tentativi a intervalli di 1.5s (~45 secondi max)
  const timer = setInterval(() => {
    attempts++;
    if (attempts === 1 || attempts === 5) {
      inspectWindowGlobals();
    }
    if (findEaServices() || attempts >= maxAttempts) {
      clearInterval(timer);
      if (!eaPinService && attempts >= maxAttempts) {
        logBridge("[FC Sniper PinBridge] Servizio PIN non ancora rilevato dopo tentativi massimi, rimarrà in ascolto degli eventi.");
      }
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

  let lastSearchPin = 0;

  // Metodi dedicati ai PIN per le azioni critiche
  function handlePinSearch() {
    const now = Date.now();
    if (now - lastSearchPin < 500) return; // evita flood ravvicinati
    lastSearchPin = now;

    const pin = getPinService();
    if (pin) {
      try {
        pin.sendData("page_view", { type: "menu", pgid: "Transfer Market Results - List View" });
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Transfer Market Results - List View (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData search:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Search inviato (in attesa del servizio PIN nativo)");
    }
  }

  function handlePinBuyNow(itemInfo) {
    const pin = getPinService();
    if (pin) {
      try {
        pin.sendData("page_view", { type: "menu", pgid: "Item - Detail View" });
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Item - Detail View (Buy Now) (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData buy now:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Buy Now inviato (in attesa del servizio PIN nativo)");
    }
  }

  function handlePinBid(itemInfo) {
    const pin = getPinService();
    if (pin) {
      try {
        pin.sendData("page_view", { type: "menu", pgid: "Item - Detail View" });
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Item - Detail View (Bid) (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData bid:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Bid inviato (in attesa del servizio PIN nativo)");
    }
  }

  function handlePinWatchlist() {
    const pin = getPinService();
    if (pin) {
      try {
        pin.sendData("page_view", { type: "menu", pgid: "Hub - Transfers" });
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Hub - Transfers (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData watchlist:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Watchlist inviato (in attesa del servizio PIN nativo)");
    }
  }

  function handlePinSell(itemInfo) {
    const pin = getPinService();
    if (pin) {
      try {
        pin.sendData("page_view", { type: "menu", pgid: "Item - Detail View" });
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Item - Detail View (Sell) (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData sell:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Sell inviato (in attesa del servizio PIN nativo)");
    }
  }

  // Ascolta messaggi inoltrati da content.js (tramite window.postMessage)
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.origin !== "FC_SNIPER_EXTENSION") {
      return;
    }

    const { type, payload } = event.data;
    if (type === "TRIGGER_PIN_SEARCH") {
      handlePinSearch();
    } else if (type === "TRIGGER_PIN_BUY_NOW") {
      handlePinBuyNow(payload);
    } else if (type === "TRIGGER_PIN_BID") {
      handlePinBid(payload);
    } else if (type === "TRIGGER_PIN_WATCHLIST") {
      handlePinWatchlist();
    } else if (type === "TRIGGER_PIN_SELL") {
      handlePinSell(payload);
    } else if (type === "REQUEST_TOKEN_REFRESH") {
      extractAndSendToken();
    }
  });
})();
