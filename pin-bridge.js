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
        } else if (s.User?.auth?.token) {
          token = s.User.auth.token;
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
        extractAndSendToken();
        logBridge("[FC Sniper PinBridge] Agganciato window.services.PIN con successo!");
        return true;
      }

      if (typeof window.getAppServices === "function") {
        const appServices = window.getAppServices();
        if (appServices) {
          eaAppServices = appServices;
          extractAndSendToken();
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
        extractAndSendToken();
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
            extractAndSendToken();
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
    extractAndSendToken();
    if (attempts === 1 || attempts === 5) {
      inspectWindowGlobals();
    }
    if (findEaServices() || attempts >= maxAttempts) {
      clearInterval(timer);
      extractAndSendToken();
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
  let currentView = "";

  // Metodi dedicati ai PIN per le azioni critiche
  function handlePinSearch() {
    const now = Date.now();
    if (now - lastSearchPin < 500) return; // evita flood ravvicinati
    lastSearchPin = now;

    const pin = getPinService();
    if (pin) {
      try {
        // Se arriviamo da un'altra sezione (es. Watchlist o Item Detail), transitiamo dall'Hub prima di entrare nei risultati
        if (currentView && currentView !== "Transfer Market Results - List View") {
          pin.sendData("page_view", { type: "menu", pgid: "Hub - Transfers" });
        }
        pin.sendData("page_view", { type: "menu", pgid: "Transfer Market Results - List View" });
        currentView = "Transfer Market Results - List View";
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
        currentView = "Item - Detail View";
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
        currentView = "Item - Detail View";
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Item - Detail View (Bid) (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData bid:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Bid inviato (in attesa del servizio PIN nativo)");
    }
  }

  let lastNativeKeepAlive = 0;

  // Mantiene viva la sessione OAuth/UTAS nativa della Web App di EA (previene il 401 allo scoccare delle 3 ore)
  function performNativeWebAppKeepAlive(force = false) {
    const now = Date.now();
    // Esegue il refresh nativo al massimo 1 volta ogni 8 minuti (oppure sempre se forzato da refresh/401)
    if (!force && (now - lastNativeKeepAlive < 8 * 60 * 1000)) {
      return;
    }
    lastNativeKeepAlive = now;

    try {
      // 1. Simula micro-attività utente locale nel DOM (non invia alcuna richiesta di rete a EA!)
      const evt = new MouseEvent("mousemove", {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: Math.floor(100 + Math.random() * 400),
        clientY: Math.floor(100 + Math.random() * 300)
      });
      document.dispatchEvent(evt);
    } catch (_) {}

    try {
      // 2. Invoca il servizio nativo della Web App (window.services) così il client interno di EA
      // controlla e rinnova automaticamente il token OAuth2 / X-UT-SID prima della scadenza delle 3 ore
      const s = window.services || eaAppServices || (typeof window.getAppServices === "function" ? window.getAppServices() : null);
      if (s) {
        if (s.User && typeof s.User.requestCurrencies === "function") {
          s.User.requestCurrencies();
          logBridge("[FC Sniper PinBridge] Keep-Alive nativo Web App eseguito (User.requestCurrencies)");
        } else if (s.User && typeof s.User.getUser === "function" && typeof s.User.getUser()?.requestCurrencies === "function") {
          s.User.getUser().requestCurrencies();
          logBridge("[FC Sniper PinBridge] Keep-Alive nativo Web App eseguito (getUser.requestCurrencies)");
        }
        if (s.Authentication && typeof s.Authentication.refreshToken === "function") {
          s.Authentication.refreshToken();
          logBridge("[FC Sniper PinBridge] Keep-Alive nativo Web App eseguito (Authentication.refreshToken)");
        }
      }
      // 3. Estrae e sincronizza eventuale nuovo token X-UT-SID appena rinnovato dalla Web App
      setTimeout(extractAndSendToken, 1200);
    } catch (e) {
      logBridge("[FC Sniper PinBridge] Errore in performNativeWebAppKeepAlive:", String(e));
    }
  }

  function handlePinWatchlist() {
    const pin = getPinService();
    if (pin) {
      try {
        // Navigazione coerente verso la Watchlist: dall'Hub agli Obiettivi di mercato
        pin.sendData("page_view", { type: "menu", pgid: "Hub - Transfers" });
        pin.sendData("page_view", { type: "menu", pgid: "Transfer Targets - List View" });
        currentView = "Transfer Targets - List View";
        logBridge(`[FC Sniper PinBridge] Emulato PIN: Hub - Transfers -> Transfer Targets - List View (stepCounter: ${pin.stepCounter})`);
      } catch (e) {
        logBridge("[FC Sniper PinBridge] Errore sendData watchlist:", e);
      }
    } else {
      logBridge("[FC Sniper PinBridge] Segnale PIN Watchlist inviato (in attesa del servizio PIN nativo)");
    }
    // Controlla se sono passati almeno 15 minuti dall'ultimo keep-alive nativo
    performNativeWebAppKeepAlive();
  }

  function handlePinSell(itemInfo) {
    const pin = getPinService();
    if (pin) {
      try {
        pin.sendData("page_view", { type: "menu", pgid: "Item - Detail View" });
        currentView = "Item - Detail View";
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
      performNativeWebAppKeepAlive(true);
      extractAndSendToken();
    }
  });
})();
