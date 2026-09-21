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

// Riceve e rilancia i log da pin-bridge.js per renderli visibili in qualsiasi contesto di console
window.addEventListener("message", (event) => {
  if (event.data && event.data.origin === "PIN_BRIDGE_LOG") {
    if (event.data.extra) {
      console.log(event.data.text, event.data.extra);
    } else {
      console.log(event.data.text);
    }
  }
});

// Ascolto messaggi dal Service Worker (fc26.js) e inoltro alla pagina (pin-bridge.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.scope === "PIN_BRIDGE") {
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
