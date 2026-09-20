document.addEventListener('DOMContentLoaded', () => {
  const numeroTentativi = document.getElementById('tentativi');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const tentativiInput = document.getElementById('tentativi');
  const tentativiRimasti = document.getElementById('tentativiRimasti');
  const carteAcquistate = document.getElementById('carteAcquistate');
  const crediti = document.getElementById('crediti');
  const switchFodder = document.getElementById('switchFodder');
  const fodderRatingContainer = document.getElementById('fodderRatingContainer');
  const fodderRatingRadios = document.querySelectorAll('input[name="fodderRating"]');

  const getSelectedRating = () => {
    const checkedRadio = document.querySelector('input[name="fodderRating"]:checked');
    return checkedRadio ? checkedRadio.value : '84';
  };

  const setRatingDisabled = (disabled) => {
    fodderRatingRadios.forEach(radio => {
      if (disabled) radio.setAttribute('disabled', 'true');
      else radio.removeAttribute('disabled');
    });
  };

  const toggleFodderRatingVisibility = () => {
    if (switchFodder.checked) {
      fodderRatingContainer.classList.remove('d-none');
    } else {
      fodderRatingContainer.classList.add('d-none');
    }
  };

  switchFodder.addEventListener('change', () => {
    toggleFodderRatingVisibility();
    chrome.storage.local.set({ fodderMode: switchFodder.checked });
  });

  fodderRatingRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      chrome.storage.local.set({ fodderRating: radio.value });
    });
  });

  // Ripristino stato salvato all'avvio
  chrome.storage.local.get(['numeroTentativi', 'fodderMode', 'fodderRating'], (result) => {
    if (result.numeroTentativi) {
      numeroTentativi.value = result.numeroTentativi;
    }
    if (result.fodderMode !== undefined) {
      switchFodder.checked = result.fodderMode;
      toggleFodderRatingVisibility();
    }
    if (result.fodderRating) {
      const targetRadio = document.querySelector(`input[name="fodderRating"][value="${result.fodderRating}"]`);
      if (targetRadio) {
        targetRadio.checked = true;
      }
    }
  });

  // Disabilito il tasto stop all'inizio
  stopBtn.setAttribute('disabled', 'true');

  startBtn.addEventListener('click', () => {
    const selectedRating = getSelectedRating();
    chrome.storage.local.set({
      numeroTentativi: numeroTentativi.value,
      fodderMode: switchFodder.checked,
      fodderRating: selectedRating
    });
    chrome.runtime.sendMessage({ tipo: 'START', valore: true });
    chrome.runtime.sendMessage({ tipo: 'FODDER_MODE', valore: switchFodder.checked, rating: selectedRating });

    // Disabilito il tasto start e abilito il tasto stop
    startBtn.setAttribute('disabled', 'true');
    tentativiInput.setAttribute('disabled', 'true');
    switchFodder.setAttribute('disabled', 'true');
    setRatingDisabled(true);
    stopBtn.removeAttribute('disabled');
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ tipo: 'START', valore: false });

    // Abilito il tasto start e disabilito il tasto stop
    startBtn.removeAttribute('disabled');
    tentativiInput.removeAttribute('disabled');
    switchFodder.removeAttribute('disabled');
    setRatingDisabled(false);
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
      setRatingDisabled(false);
      stopBtn.setAttribute('disabled', 'true');
    }
    //aggiorno contatore tentativi rimasti
    else if (message.tipo == 'TENTATIVI_RIMASTI') {
      tentativiRimasti.textContent = "Tentativi rimasti: " + message.valore;
    }
    else if (message.tipo == 'CARTA_ACQUISTATA') {
      carteAcquistate.textContent = "Carte acquistate: " + message.valore;
    }
  })

  //Ascolto i messaggi per l'aggiornamento dei credi
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'CREDITI') {
      crediti.textContent = `Crediti: ${message.valore ?? 'N/D'}`;
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

