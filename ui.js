document.addEventListener('DOMContentLoaded', () => {
  const numeroTentativi = document.getElementById('tentativi');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const tentativiInput = document.getElementById('tentativi');
  const tentativiRimasti = document.getElementById('tentativiRimasti');
  const carteAcquistate = document.getElementById('carteAcquistate');
  const crediti = document.getElementById('crediti');
  const switchFodder = document.getElementById('switchFodder');
  const targetModeRadios = document.querySelectorAll('input[name="targetMode"]');
  const fodderRatingContainer = document.getElementById('fodderRatingContainer');
  const fodderRatingRadios = document.querySelectorAll('input[name="fodderRating"]');
  const consumablesConfigContainer = document.getElementById('consumablesConfigContainer');
  const chemStyleSelect = document.getElementById('chemStyleSelect');
  const autoBinCheck = document.getElementById('autoBinCheck');
  const manualBinContainer = document.getElementById('manualBinContainer');
  const manualBinInput = document.getElementById('manualBinInput');
  const strategyModeRadios = document.querySelectorAll('input[name="strategyMode"]');
  const biddingConfigContainer = document.getElementById('biddingConfigContainer');
  const minMarginInput = document.getElementById('minMargin');
  const maxSnipePriceInput = document.getElementById('maxSnipePriceInput');

  const getSelectedTargetMode = () => {
    const checkedRadio = document.querySelector('input[name="targetMode"]:checked');
    return checkedRadio ? checkedRadio.value : 'fodder';
  };

  const getSelectedRating = () => {
    const checkedRadio = document.querySelector('input[name="fodderRating"]:checked');
    return checkedRadio ? checkedRadio.value : '84';
  };

  const getSelectedStrategy = () => {
    const checkedRadio = document.querySelector('input[name="strategyMode"]:checked');
    return checkedRadio ? checkedRadio.value : 'sniping';
  };

  const getSelectedChemStyle = () => {
    return chemStyleSelect ? chemStyleSelect.value : '268';
  };

  const isAutoBinEnabled = () => {
    return autoBinCheck ? autoBinCheck.checked : true;
  };

  const getManualBinPrice = () => {
    return manualBinInput ? (parseInt(manualBinInput.value) || 0) : 0;
  };

  const getMaxSnipePrice = () => {
    return maxSnipePriceInput ? (parseInt(maxSnipePriceInput.value) || 0) : 0;
  };

  const toggleTargetContainers = () => {
    const target = getSelectedTargetMode();
    if (target === 'fodder') {
      fodderRatingContainer.classList.remove('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = true;
    } else if (target === 'consumables') {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.remove('d-none');
      if (switchFodder) switchFodder.checked = false;
    } else {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = false;
    }
  };

  const toggleManualBinVisibility = () => {
    if (autoBinCheck && manualBinContainer) {
      if (autoBinCheck.checked) {
        manualBinContainer.classList.add('d-none');
      } else {
        manualBinContainer.classList.remove('d-none');
      }
    }
  };

  const toggleBiddingVisibility = () => {
    const strategy = getSelectedStrategy();
    if (strategy === 'bidding') {
      biddingConfigContainer.classList.remove('d-none');
    } else {
      biddingConfigContainer.classList.add('d-none');
    }
  };

  const setControlsDisabled = (disabled) => {
    targetModeRadios.forEach(r => disabled ? r.setAttribute('disabled', 'true') : r.removeAttribute('disabled'));
    fodderRatingRadios.forEach(r => disabled ? r.setAttribute('disabled', 'true') : r.removeAttribute('disabled'));
    strategyModeRadios.forEach(r => disabled ? r.setAttribute('disabled', 'true') : r.removeAttribute('disabled'));
    if (chemStyleSelect) disabled ? chemStyleSelect.setAttribute('disabled', 'true') : chemStyleSelect.removeAttribute('disabled');
    if (autoBinCheck) disabled ? autoBinCheck.setAttribute('disabled', 'true') : autoBinCheck.removeAttribute('disabled');
    if (manualBinInput) disabled ? manualBinInput.setAttribute('disabled', 'true') : manualBinInput.removeAttribute('disabled');
    if (maxSnipePriceInput) disabled ? maxSnipePriceInput.setAttribute('disabled', 'true') : maxSnipePriceInput.removeAttribute('disabled');
    if (minMarginInput) disabled ? minMarginInput.setAttribute('disabled', 'true') : minMarginInput.removeAttribute('disabled');
  };

  targetModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      toggleTargetContainers();
      chrome.storage.local.set({
        targetMode: radio.value,
        fodderMode: radio.value === 'fodder'
      });
    });
  });

  if (autoBinCheck) {
    autoBinCheck.addEventListener('change', () => {
      toggleManualBinVisibility();
      chrome.storage.local.set({ autoBin: autoBinCheck.checked });
    });
  }

  if (manualBinInput) {
    manualBinInput.addEventListener('change', () => {
      chrome.storage.local.set({ manualBin: parseInt(manualBinInput.value) || 0 });
    });
  }

  if (maxSnipePriceInput) {
    maxSnipePriceInput.addEventListener('change', () => {
      chrome.storage.local.set({ maxSnipePrice: parseInt(maxSnipePriceInput.value) || 0 });
    });
  }

  if (chemStyleSelect) {
    chemStyleSelect.addEventListener('change', () => {
      chrome.storage.local.set({ chemStyle: chemStyleSelect.value });
    });
  }

  fodderRatingRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      chrome.storage.local.set({ fodderRating: radio.value });
    });
  });

  strategyModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      toggleBiddingVisibility();
      chrome.storage.local.set({ strategyMode: radio.value });
    });
  });

  if (minMarginInput) {
    minMarginInput.addEventListener('change', () => {
      chrome.storage.local.set({ minMargin: parseInt(minMarginInput.value) || 200 });
    });
  }

  // Ripristino stato salvato all'avvio
  chrome.storage.local.get([
    'numeroTentativi', 'targetMode', 'fodderMode', 'fodderRating',
    'chemStyle', 'autoBin', 'manualBin', 'strategyMode', 'minMargin', 'maxSnipePrice'
  ], (result) => {
    if (result.numeroTentativi) {
      numeroTentativi.value = result.numeroTentativi;
    }

    let savedTarget = result.targetMode;
    if (!savedTarget && result.fodderMode !== undefined) {
      savedTarget = result.fodderMode ? 'fodder' : 'manual';
    }
    if (savedTarget) {
      const targetRadio = document.querySelector(`input[name="targetMode"][value="${savedTarget}"]`);
      if (targetRadio) targetRadio.checked = true;
    }
    toggleTargetContainers();

    if (result.fodderRating) {
      const ratingRadio = document.querySelector(`input[name="fodderRating"][value="${result.fodderRating}"]`);
      if (ratingRadio) ratingRadio.checked = true;
    }

    if (result.chemStyle && chemStyleSelect) {
      chemStyleSelect.value = result.chemStyle;
    }

    if (result.autoBin !== undefined && autoBinCheck) {
      autoBinCheck.checked = result.autoBin;
      toggleManualBinVisibility();
    }

    if (result.manualBin && manualBinInput) {
      manualBinInput.value = result.manualBin;
    }

    if (result.maxSnipePrice && maxSnipePriceInput) {
      maxSnipePriceInput.value = result.maxSnipePrice;
    }

    if (result.strategyMode) {
      const targetStrategy = document.querySelector(`input[name="strategyMode"][value="${result.strategyMode}"]`);
      if (targetStrategy) targetStrategy.checked = true;
      toggleBiddingVisibility();
    }

    if (result.minMargin && minMarginInput) {
      minMarginInput.value = result.minMargin;
    }
  });

  // Disabilito il tasto stop all'inizio
  stopBtn.setAttribute('disabled', 'true');

  startBtn.addEventListener('click', () => {
    const selectedTarget = getSelectedTargetMode();
    const selectedRating = getSelectedRating();
    const selectedStrategy = getSelectedStrategy();
    const selectedChemStyle = getSelectedChemStyle();
    const autoBin = isAutoBinEnabled();
    const manualBin = getManualBinPrice();
    const maxSnipePrice = getMaxSnipePrice();
    const minMargin = minMarginInput ? (parseInt(minMarginInput.value) || 200) : 200;

    chrome.storage.local.set({
      numeroTentativi: numeroTentativi.value,
      targetMode: selectedTarget,
      fodderMode: selectedTarget === 'fodder',
      fodderRating: selectedRating,
      chemStyle: selectedChemStyle,
      autoBin: autoBin,
      manualBin: manualBin,
      maxSnipePrice: maxSnipePrice,
      strategyMode: selectedStrategy,
      minMargin: minMargin
    });

    const startPayload = {
      tipo: 'START',
      valore: true,
      targetMode: selectedTarget,
      strategyMode: selectedStrategy,
      minMargin: minMargin,
      chemStyle: selectedChemStyle,
      autoBin: autoBin,
      manualBin: manualBin,
      maxSnipePrice: maxSnipePrice,
      rating: selectedRating
    };

    chrome.runtime.sendMessage(startPayload);

    chrome.runtime.sendMessage({
      tipo: 'FODDER_MODE',
      valore: selectedTarget === 'fodder',
      targetMode: selectedTarget,
      rating: selectedRating,
      chemStyle: selectedChemStyle,
      autoBin: autoBin,
      manualBin: manualBin,
      strategyMode: selectedStrategy,
      minMargin: minMargin
    });

    // Disabilito i controlli e abilito il tasto stop
    startBtn.setAttribute('disabled', 'true');
    tentativiInput.setAttribute('disabled', 'true');
    setControlsDisabled(true);
    stopBtn.removeAttribute('disabled');
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ tipo: 'START', valore: false });

    // Abilito i controlli e disabilito il tasto stop
    startBtn.removeAttribute('disabled');
    tentativiInput.removeAttribute('disabled');
    setControlsDisabled(false);
    stopBtn.setAttribute('disabled', 'true');
  });

  // Ascolto i messaggi di log dalla background script
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'LOG') {
      logToScreen(message.valore);
    }
  });

  // Ascolto i messaggi di START/STOP dalla background script
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'START') {
      startBtn.removeAttribute('disabled');
      tentativiInput.removeAttribute('disabled');
      setControlsDisabled(false);
      stopBtn.setAttribute('disabled', 'true');
    }
    else if (message.tipo == 'TENTATIVI_RIMASTI') {
      tentativiRimasti.textContent = "Tentativi rimasti: " + message.valore;
    }
    else if (message.tipo == 'CARTA_ACQUISTATA') {
      carteAcquistate.textContent = "Carte acquistate: " + message.valore;
    }
  });

  // Ascolto i messaggi per l'aggiornamento dei crediti
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'CREDITI') {
      crediti.textContent = `Crediti: ${message.valore ?? 'N/D'}`;
    }
  });
});

// Funzione per aggiungere log al campo di testo
function logToScreen(message) {
  const logViewer = document.getElementById('logViewer');
  if (logViewer) {
    const timestamp = new Date().toLocaleTimeString();
    logViewer.value += `[${timestamp}] ${message}\n`;
    logViewer.scrollTop = logViewer.scrollHeight;
  }
}
