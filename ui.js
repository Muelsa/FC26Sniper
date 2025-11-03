document.addEventListener('DOMContentLoaded', () => {
  const numeroTentativi = document.getElementById('tentativi');
  const startBtn = document.getElementById('startBtn'); 
  const stopBtn = document.getElementById('stopBtn'); 
  const tentativiInput = document.getElementById('tentativi'); 
  const tentativiRimasti = document.getElementById('tentativiRimasti'); 
  const carteAcquistate = document.getElementById('carteAcquistate'); 
  const switchFodder = document.getElementById('switchFodder'); 

  // Disabilito il tasto stop all'inizio
  stopBtn.setAttribute('disabled', 'true');

  startBtn.addEventListener('click', () => {
    chrome.storage.local.set({ numeroTentativi: numeroTentativi.value });
    chrome.runtime.sendMessage({ tipo: 'START', valore: true });
    chrome.runtime.sendMessage({ tipo: 'FODDER_MODE', valore: switchFodder.checked });

    // Disabilito il tasto start e abilito il tasto stop
    startBtn.setAttribute('disabled', 'true');
    tentativiInput.setAttribute('disabled', 'true');
    switchFodder.setAttribute('disabled', 'true');
    stopBtn.removeAttribute('disabled');
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ tipo: 'START', valore: false });
    
    // Abilito il tasto start e disabilito il tasto stop
    startBtn.removeAttribute('disabled');
    tentativiInput.removeAttribute('disabled');
    switchFodder.removeAttribute('disabled');
    stopBtn.setAttribute('disabled', 'true');
  });

  // Ascolto i messaggi di log dalla background script
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'LOG') {
      logToScreen(message.valore);
    }
  })

  // Ascolto i messaggi di START/STOP dalla background script
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'START') {
        startBtn.removeAttribute('disabled');
        tentativiInput.removeAttribute('disabled');
        switchFodder.removeAttribute('disabled');
        stopBtn.setAttribute('disabled', 'true');
    }
    //aggiorno contatore tentativi rimasti
    else if(message.tipo == 'TENTATIVI_RIMASTI'){
      tentativiRimasti.textContent = "Tentativi rimasti: " + message.valore;
    }
    else if(message.tipo == 'CARTA_ACQUISTATA'){
      carteAcquistate.textContent = "Carte acquistate: " + message.valore;
    }
  })



});




// Funzione per aggiungere log al campo di testo
function logToScreen(message) {
  const logViewer = document.getElementById('logViewer');
  if (logViewer) {
    const timestamp = new Date().toLocaleTimeString(); // ora corrente
    logViewer.value += `[${timestamp}] ${message}\n`; // Aggiungo il timestamp al messaggio
    logViewer.scrollTop = logViewer.scrollHeight; // Scorro automaticamente verso il basso
  }
}

