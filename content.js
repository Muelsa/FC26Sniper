// content.js - Bridge ISOLATED <-> MAIN world tra Service Worker (fc26.js) e pin-bridge.js
(function () {
  "use strict";

  // Idempotenza rigorosa: impedisce doppie registrazioni di listener o script in caso di re-iniezione a caldo
  if (window.__FC_SNIPER_CONTENT_INJECTED__) {
    return;
  }
  window.__FC_SNIPER_CONTENT_INJECTED__ = true;

  // --- Protocollo PIN condiviso con fc26.js (lavorazione parallela) ---
  // SW  -> content.js : chrome.tabs.sendMessage { scope:'PIN_BRIDGE', requestId, type, payload }
  // content.js -> page: window.postMessage { origin:'FC_SNIPER_EXTENSION', requestId, type, payload } (targetOrigin = location.origin)
  // content.js -> SW  : sendResponse { status:'forwarded', requestId }
  // page -> content.js: window.postMessage { origin:'PIN_BRIDGE_ACK', requestId, status, detail }
  // content.js -> SW  : chrome.runtime.sendMessage { tipo:'PIN_BRIDGE_ACK', requestId, status, detail }

  const ALLOWED_PIN_TYPES = new Set([
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

  function injectBridgeScript() {
    if (document.getElementById("fc-sniper-pin-bridge") || window.__FC_SNIPER_BRIDGE_LOADED__) return;
    try {
      const script = document.createElement("script");
      script.id = "fc-sniper-pin-bridge";
      script.src = chrome.runtime.getURL("pin-bridge.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error("[FC Sniper CS] Errore iniezione pin-bridge.js:", e);
    }
  }

  injectBridgeScript();

  // Deduplica token consecutivi prima di TOKEN_SYNC (mai loggare token o prefissi)
  let lastToken = null;
  let lastUserKey = null;
  const forwardedAcks = new Set();
  let kaTimer = null;

  // Messaggi provenienti dal MAIN world (pin-bridge.js)
  const onPageMessage = (event) => {
    if (!chrome.runtime?.id) {
      window.removeEventListener("message", onPageMessage);
      if (kaTimer) clearInterval(kaTimer);
      return;
    }
    // Verifica rigorosa: stessa finestra, stesso origin, payload oggetto non nullo
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.origin === "PIN_BRIDGE_LOG") {
      if (typeof data.text !== "string" || data.text.length > 500) return;
      if (data.extra !== undefined && data.extra !== null) {
        console.log(data.text, data.extra);
      } else {
        console.log(data.text);
      }
      return;
    }

    if (data.origin === "PIN_BRIDGE_TOKEN") {
      const token = data.token;
      if (typeof token !== "string" || token.length === 0 || token.length > 2048) return;
      if (token === lastToken) return; // deduplica
      lastToken = token;
      try {
        chrome.runtime.sendMessage({ tipo: "TOKEN_SYNC", valore: token });
      } catch (_) {}
      return;
    }

    if (data.origin === "PIN_BRIDGE_USER") {
      const { personaName, clubName } = data;
      const userKey = `${personaName || ''}::${clubName || ''}`;
      if (!personaName && !clubName) return;
      if (userKey === lastUserKey) return; // deduplica profilo
      lastUserKey = userKey;
      try {
        chrome.runtime.sendMessage({
          tipo: "USER_SYNC",
          personaName: typeof personaName === "string" ? personaName.slice(0, 50) : "",
          clubName: typeof clubName === "string" ? clubName.slice(0, 50) : ""
        });
      } catch (_) {}
      return;
    }

    if (data.origin === "PIN_BRIDGE_ACK") {
      if (typeof data.requestId !== "string" || typeof data.status !== "string") return;
      if (forwardedAcks.has(data.requestId)) return; // deduplica ACK per requestId
      forwardedAcks.add(data.requestId);
      if (forwardedAcks.size > 200) {
        const first = forwardedAcks.values().next().value;
        forwardedAcks.delete(first);
      }
      try {
        chrome.runtime.sendMessage({
          tipo: "PIN_BRIDGE_ACK",
          requestId: data.requestId,
          status: data.status,
          detail: typeof data.detail === "string" ? data.detail.slice(0, 200) : "",
          events: Array.isArray(data.events) ? data.events.slice(0, 5) : [],
          stepCounter: data.stepCounter !== undefined ? String(data.stepCounter).slice(0, 40) : "OK"
        });
      } catch (_) {}
      return;
    }
  };

  window.addEventListener("message", onPageMessage);

  // Messaggi dal Service Worker (fc26.js) -> inoltro alla pagina
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || message.scope !== "PIN_BRIDGE") return false;

    const { requestId, type } = message;
    // Ignora richieste malformate o di tipo sconosciuto
    if (typeof requestId !== "string" || typeof type !== "string" || !ALLOWED_PIN_TYPES.has(type)) {
      sendResponse({ status: "ignored", requestId: typeof requestId === "string" ? requestId : null });
      return false;
    }

    let payload = {};
    if (message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)) {
      payload = message.payload;
    }

    try {
      window.postMessage(
        {
          origin: "FC_SNIPER_EXTENSION",
          requestId,
          type,
          payload
        },
        window.location.origin
      );
      sendResponse({ status: "forwarded", requestId });
    } catch (e) {
      sendResponse({ status: "error", requestId });
    }
    return false;
  });

  // Keep-Alive: una sola porta KEEP_ALIVE_PORT con reconnect single-flight
  let keepAlivePort = null;
  let reconnecting = false;

  function setupKeepAlive() {
    if (!chrome.runtime?.id) return;
    if (keepAlivePort || reconnecting) return; // niente doppio setup concorrente
    reconnecting = true;
    try {
      const port = chrome.runtime.connect({ name: "KEEP_ALIVE_PORT" });
      port.onDisconnect.addListener(() => {
        const _ = chrome.runtime.lastError;
        keepAlivePort = null;
        reconnecting = false;
        if (chrome.runtime?.id) setTimeout(setupKeepAlive, 1000);
      });
      port.onMessage.addListener(() => {});
      keepAlivePort = port;
      reconnecting = false;
    } catch (e) {
      keepAlivePort = null;
      reconnecting = false;
      if (chrome.runtime?.id) setTimeout(setupKeepAlive, 1000);
    }
  }

  setupKeepAlive();

  // Ping ogni 20s: azzera il timer di inattività (30s) del Service Worker
  kaTimer = setInterval(() => {
    if (!chrome.runtime?.id) {
      clearInterval(kaTimer);
      return;
    }
    try {
      if (keepAlivePort) {
        keepAlivePort.postMessage({ type: "KEEP_ALIVE_PING" });
      } else {
        setupKeepAlive();
      }
    } catch (e) {
      keepAlivePort = null;
      setupKeepAlive();
    }
  }, 20000);
})();
