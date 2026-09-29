// content.js - Eseguito nel contesto dell'estensione sulla Web App di EA
console.log("[FC Sniper ContentScript] Inizializzazione bridge di comunicazione...");

// Iniezione dinamica di pin-bridge.js nel contesto reale (MAIN world) della pagina
function injectBridgeScript() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pin-bridge.js");
    script.onload = () => {
      console.log("[FC Sniper ContentScript] pin-bridge.js iniettato con successo nel DOM!");
      script.remove(); // pulisce il tag dal DOM mantenendo lo script in memoria
    };
    script.onerror = (err) => {
      console.error("[FC Sniper ContentScript] Errore caricamento pin-bridge.js via URL estensione:", err);
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.error("[FC Sniper ContentScript] Errore iniezione:", e);
  }
}

injectBridgeScript();

// Riceve e rilancia i log e i token da pin-bridge.js
window.addEventListener("message", (event) => {
  if (event.data && event.data.origin === "PIN_BRIDGE_LOG") {
    if (event.data.extra) {
      console.log(event.data.text, event.data.extra);
    } else {
      console.log(event.data.text);
    }
  }
  if (event.data && event.data.origin === "PIN_BRIDGE_TOKEN" && event.data.token) {
    console.log("[FC Sniper ContentScript] Token X-UT-SID intercettato da Web App:", event.data.token.substring(0, 10) + "...");
    chrome.runtime.sendMessage({
      tipo: "TOKEN_SYNC",
      valore: event.data.token
    });
  }
});

// Ascolto messaggi dal Service Worker (fc26.js) e inoltro alla pagina (pin-bridge.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.scope === "PIN_BRIDGE") {
    console.log("[FC Sniper ContentScript] Inoltro evento PIN a Web App:", message.type);
    window.postMessage(
      {
        origin: "FC_SNIPER_EXTENSION",
        type: message.type,
        payload: message.payload || {}
      },
      "*"
    );
    sendResponse({ status: "forwarded" });
  }
});

// Keep-Alive Connection per prevenire l'arresto del Service Worker Manifest V3 durante pause e sonni prolungati
let keepAlivePort = null;
function setupKeepAlive() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: "KEEP_ALIVE_PORT" });
    keepAlivePort.onDisconnect.addListener(() => {
      const _ = chrome.runtime.lastError;
      keepAlivePort = null;
      setTimeout(setupKeepAlive, 1000);
    });
    keepAlivePort.onMessage.addListener(() => {});
  } catch (e) {
    setTimeout(setupKeepAlive, 1000);
  }
}
setupKeepAlive();

// Ping periodico ogni 20s: azzera il timer di inattività (30s) di Chrome per il Service Worker
setInterval(() => {
  try {
    if (keepAlivePort) {
      keepAlivePort.postMessage({ type: "KEEP_ALIVE_PING" });
    } else {
      setupKeepAlive();
    }
  } catch (e) {
    setupKeepAlive();
  }
}, 20000);

