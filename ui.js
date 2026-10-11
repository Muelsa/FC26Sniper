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
  const lazyConfigContainer = document.getElementById('lazyConfigContainer');
  const targetTradepileSizeInput = document.getElementById('targetTradepileSizeInput');
  const lazyMarkupPercentInput = document.getElementById('lazyMarkupPercentInput');
  const lazySleepMinutesInput = document.getElementById('lazySleepMinutesInput');
  const modeLazy = document.getElementById('modeLazy');
  const labelModeLazy = document.getElementById('labelModeLazy') || document.querySelector('label[for="modeLazy"]');
  const snipeSpecificContainer = document.getElementById('snipeSpecificContainer');

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

  const getTargetTradepileSize = () => {
    return targetTradepileSizeInput ? (parseInt(targetTradepileSizeInput.value) || 50) : 50;
  };

  const getLazyMarkupPercent = () => {
    return lazyMarkupPercentInput ? (parseInt(lazyMarkupPercentInput.value) || 10) : 10;
  };

  const getLazySleepMinutes = () => {
    return lazySleepMinutesInput ? (parseInt(lazySleepMinutesInput.value) || 63) : 63;
  };

  const toggleTargetContainers = () => {
    const target = getSelectedTargetMode();
    if (target === 'fodder') {
      fodderRatingContainer.classList.remove('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = true;

      // Mostra pulsante Lazy sia per Fodder che per Consumabili
      if (modeLazy) modeLazy.classList.remove('d-none');
      if (labelModeLazy) labelModeLazy.classList.remove('d-none');
    } else if (target === 'consumables') {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.remove('d-none');
      if (switchFodder) switchFodder.checked = false;

      // Mostra pulsante Lazy per Consumabili
      if (modeLazy) modeLazy.classList.remove('d-none');
      if (labelModeLazy) labelModeLazy.classList.remove('d-none');
    } else {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = false;

      // Nascondi pulsante Lazy su Manuale
      if (modeLazy) modeLazy.classList.add('d-none');
      if (labelModeLazy) labelModeLazy.classList.add('d-none');
      if (modeLazy && modeLazy.checked) {
        const snipingRadio = document.getElementById('modeSniping');
        if (snipingRadio) snipingRadio.checked = true;
        toggleStrategyContainers();
        chrome.storage.local.set({ strategyMode: 'sniping' });
      }
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

  const toggleStrategyContainers = () => {
    const strategy = getSelectedStrategy();
    if (strategy === 'bidding') {
      if (biddingConfigContainer) biddingConfigContainer.classList.remove('d-none');
      if (lazyConfigContainer) lazyConfigContainer.classList.add('d-none');
      if (snipeSpecificContainer) snipeSpecificContainer.classList.add('d-none');
    } else if (strategy === 'lazy') {
      if (biddingConfigContainer) biddingConfigContainer.classList.add('d-none');
      if (lazyConfigContainer) lazyConfigContainer.classList.remove('d-none');
      if (snipeSpecificContainer) snipeSpecificContainer.classList.add('d-none');
    } else {
      // Sniping
      if (biddingConfigContainer) biddingConfigContainer.classList.add('d-none');
      if (lazyConfigContainer) lazyConfigContainer.classList.add('d-none');
      if (snipeSpecificContainer) snipeSpecificContainer.classList.remove('d-none');
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
    if (targetTradepileSizeInput) disabled ? targetTradepileSizeInput.setAttribute('disabled', 'true') : targetTradepileSizeInput.removeAttribute('disabled');
    if (lazyMarkupPercentInput) disabled ? lazyMarkupPercentInput.setAttribute('disabled', 'true') : lazyMarkupPercentInput.removeAttribute('disabled');
    if (lazySleepMinutesInput) disabled ? lazySleepMinutesInput.setAttribute('disabled', 'true') : lazySleepMinutesInput.removeAttribute('disabled');
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
      toggleStrategyContainers();
      chrome.storage.local.set({ strategyMode: radio.value });
    });
  });

  if (minMarginInput) {
    minMarginInput.addEventListener('change', () => {
      chrome.storage.local.set({ minMargin: parseInt(minMarginInput.value) || 200 });
    });
  }

  if (targetTradepileSizeInput) {
    targetTradepileSizeInput.addEventListener('change', () => {
      chrome.storage.local.set({ targetTradepileSize: parseInt(targetTradepileSizeInput.value) || 50 });
    });
  }

  if (lazyMarkupPercentInput) {
    lazyMarkupPercentInput.addEventListener('change', () => {
      chrome.storage.local.set({ lazyMarkupPercent: parseInt(lazyMarkupPercentInput.value) || 10 });
    });
  }

  if (lazySleepMinutesInput) {
    lazySleepMinutesInput.addEventListener('change', () => {
      chrome.storage.local.set({ lazySleepMinutes: parseInt(lazySleepMinutesInput.value) || 63 });
    });
  }

  // Ripristino stato salvato all'avvio
  chrome.storage.local.get([
    'numeroTentativi', 'targetMode', 'fodderMode', 'fodderRating',
    'chemStyle', 'autoBin', 'manualBin', 'strategyMode', 'minMargin', 'maxSnipePrice',
    'targetTradepileSize', 'lazyMarkupPercent', 'lazySleepMinutes',
    'tradepileCount', 'crediti', 'carteAcquistate'
  ], (result) => {
    if (result.tradepileCount) {
      const tpEl = document.getElementById('tradepileCount');
      if (tpEl) tpEl.textContent = result.tradepileCount;
    }
    if (result.crediti !== undefined && crediti) {
      crediti.textContent = typeof result.crediti === 'number' ? result.crediti.toLocaleString('it-IT') : String(result.crediti);
    }
    if (result.carteAcquistate !== undefined && carteAcquistate) {
      carteAcquistate.textContent = String(result.carteAcquistate);
    }

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

    if (result.targetTradepileSize && targetTradepileSizeInput) {
      targetTradepileSizeInput.value = result.targetTradepileSize;
    }

    if (result.lazyMarkupPercent && lazyMarkupPercentInput) {
      lazyMarkupPercentInput.value = result.lazyMarkupPercent;
    }

    if (result.lazySleepMinutes && lazySleepMinutesInput) {
      lazySleepMinutesInput.value = result.lazySleepMinutes;
    }

    if (result.strategyMode) {
      if (result.strategyMode === 'lazy' && savedTarget !== 'consumables' && savedTarget !== 'fodder') {
        savedTarget = 'consumables';
        const targetRadio = document.querySelector('input[name="targetMode"][value="consumables"]');
        if (targetRadio) targetRadio.checked = true;
        toggleTargetContainers();
      }
      const targetStrategy = document.querySelector(`input[name="strategyMode"][value="${result.strategyMode}"]`);
      if (targetStrategy) targetStrategy.checked = true;
      toggleStrategyContainers();
    }

    if (result.minMargin && minMarginInput) {
      minMarginInput.value = result.minMargin;
    }
  });

  // Disabilito il tasto stop all'inizio
  stopBtn.setAttribute('disabled', 'true');

  startBtn.addEventListener('click', () => {
    let selectedTarget = getSelectedTargetMode();
    const selectedRating = getSelectedRating();
    const selectedStrategy = getSelectedStrategy();

    const selectedChemStyle = getSelectedChemStyle();
    const autoBin = isAutoBinEnabled();
    const manualBin = getManualBinPrice();
    const maxSnipePrice = getMaxSnipePrice();
    const minMargin = minMarginInput ? (parseInt(minMarginInput.value) || 200) : 200;
    const targetTradepileSize = getTargetTradepileSize();
    const lazyMarkupPercent = getLazyMarkupPercent();
    const lazySleepMinutes = getLazySleepMinutes();

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
      minMargin: minMargin,
      targetTradepileSize: targetTradepileSize,
      lazyMarkupPercent: lazyMarkupPercent,
      lazySleepMinutes: lazySleepMinutes
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
      rating: selectedRating,
      targetTradepileSize: targetTradepileSize,
      lazyMarkupPercent: lazyMarkupPercent,
      lazySleepMinutes: lazySleepMinutes
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
      minMargin: minMargin,
      targetTradepileSize: targetTradepileSize,
      lazyMarkupPercent: lazyMarkupPercent,
      lazySleepMinutes: lazySleepMinutes
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
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const statusSubtext = document.getElementById('statusSubtext');
    if (statusDot) statusDot.className = 'text-secondary';
    if (statusText) statusText.textContent = 'Arrestato';
    if (statusSubtext) statusSubtext.textContent = 'Operazione interrotta dall\'utente';
  });

  // Gestione pulsanti di filtro del log
  const filterBtns = document.querySelectorAll('#logFilterGroup button');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active', 'text-white'));
      btn.classList.add('active', 'text-white');
      currentFilter = btn.dataset.filter || 'all';
      applyLogFilter();
    });
  });

  // Pulsante pulizia console
  const clearBtn = document.getElementById('clearLogBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const logConsole = document.getElementById('logConsole');
      if (logConsole) logConsole.innerHTML = '';
      const logViewer = document.getElementById('logViewer');
      if (logViewer) logViewer.value = '';
      allLogRecords.length = 0;
      totalLogEvents = 0;
      const logCount = document.getElementById('logCount');
      if (logCount) logCount.textContent = '0 eventi';
    });
  }

  // Pulsante esportazione / download log completo (.txt)
  const downloadBtn = document.getElementById('downloadLogBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

      const verText = document.getElementById('versione')?.textContent?.trim() || 'v2.5.4';
      const targetMode = typeof getSelectedTargetMode === 'function' ? getSelectedTargetMode() : 'N/D';
      const strategyMode = typeof getSelectedStrategy === 'function' ? getSelectedStrategy() : 'N/D';
      const creditiVal = document.getElementById('crediti')?.textContent?.trim() || 'N/D';
      const carteVal = document.getElementById('carteAcquistate')?.textContent?.trim() || '0';
      const tentativiVal = document.getElementById('tentativi')?.value || 'N/D';

      let content = `=================================================================\n`;
      content += `  FC Sniper & Trader - Report Log Sessione\n`;
      content += `  Versione: ${verText} | Data Export: ${now.toLocaleString()}\n`;
      content += `  Modalità: ${String(targetMode).toUpperCase()} | Strategia: ${String(strategyMode).toUpperCase()}\n`;
      content += `  Crediti: ${creditiVal} | Carte Acquistate: ${carteVal} | Tentativi: ${tentativiVal}\n`;
      content += `  Totale Eventi Registrati: ${allLogRecords.length}\n`;
      content += `=================================================================\n\n`;

      if (allLogRecords.length > 0) {
        allLogRecords.forEach((r) => {
          content += `[${r.timestamp}] [${r.tag}] ${r.raw}\n`;
        });
      } else {
        const logViewer = document.getElementById('logViewer');
        if (logViewer && logViewer.value.trim()) {
          content += logViewer.value;
        } else {
          content += `Nessun evento registrato nella sessione corrente.\n`;
        }
      }

      content += `\n=================================================================\n`;
      content += `  Fine Log Sessione\n`;
      content += `=================================================================\n`;

      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fcsniper_logs_${dateStr}_${timeStr}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

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
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      const statusSubtext = document.getElementById('statusSubtext');
      if (statusDot) statusDot.className = 'text-secondary';
      if (statusText) statusText.textContent = 'Completato / Pronto';
      if (statusSubtext) statusSubtext.textContent = 'Sessione terminata';
    }
    else if (message.tipo == 'TENTATIVI_RIMASTI') {
      tentativiRimasti.textContent = message.valore !== "" ? String(message.valore) : "-";
    }
    else if (message.tipo == 'CARTA_ACQUISTATA') {
      carteAcquistate.textContent = message.valore !== "" ? String(message.valore) : "0";
    }
    else if (message.tipo == 'TRADEPILE_COUNT') {
      const tradepileCount = document.getElementById('tradepileCount');
      if (tradepileCount) {
        tradepileCount.textContent = message.valore !== "" ? String(message.valore) : "-";
      }
    }
  });

  // Ascolto i messaggi per l'aggiornamento dei crediti
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.tipo === 'CREDITI') {
      crediti.textContent = typeof message.valore === 'number'
        ? message.valore.toLocaleString('it-IT')
        : (message.valore ? String(message.valore) : 'N/D');
    }
  });
});

let currentFilter = 'all';
let totalLogEvents = 0;
const allLogRecords = [];

function applyLogFilter() {
  const rows = document.querySelectorAll('#logConsole .log-row');
  rows.forEach(r => {
    const cat = r.dataset.category;
    if (currentFilter === 'all') {
      r.style.display = '';
    } else if (currentFilter === 'trade' && (cat === 'trade' || cat === 'bid')) {
      r.style.display = '';
    } else if (currentFilter === 'sleep' && (cat === 'sleep' || cat === 'status')) {
      r.style.display = '';
    } else if (currentFilter === 'warn' && cat === 'warn') {
      r.style.display = '';
    } else {
      r.style.display = 'none';
    }
  });
  const logConsole = document.getElementById('logConsole');
  if (logConsole) logConsole.scrollTop = logConsole.scrollHeight;
}

function classifyLogMessage(raw) {
  const text = String(raw || '').trim();

  // 1. Trades: Acquisti e Vendite
  if (/acquisto|acquistata|acquistate|vinta|vendita|listata|listato/i.test(text) && !/errore/i.test(text)) {
    let clean = text.replace(/^\[(ACQUISTO RIUSCITO|LAZY BUY NOW|ASTA VINTA|Reconciliation)\]\s*/i, '');
    let tag = 'ACQUISTO';
    if (/vendita|listat/i.test(text) && !/acquist/i.test(text)) tag = 'VENDITA';
    if (/vinta/i.test(text)) tag = 'VINTA';
    return { category: 'trade', tag, text: clean };
  }

  // 2. Offerte / Bidding
  if (/offerta|bid|bidding|rilancio/i.test(text) && !/errore|terminat/i.test(text)) {
    let clean = text.replace(/^\[(LAZY BID|MASS BID|FC Sniper)\]\s*/i, '');
    return { category: 'bid', tag: 'OFFERTA', text: clean };
  }

  // 3. Pause / Sleep / Heartbeat
  if (/pausa|dormiente|heartbeat|cool\s*down|attesa|attendo/i.test(text)) {
    let clean = text.replace(/^\[(LAZY HEARTBEAT|PAUSA DI SICUREZZA[^\]]*|PAUSA)\]\s*/i, '');
    return { category: 'sleep', tag: 'PAUSA', text: clean };
  }

  // 4. Avvisi ed Errori / 461 / Captcha / Limiti
  if (/errore|461|401|429|458|captcha|soft-ban|fallit|attenzione/i.test(text)) {
    let clean = text.replace(/^\[(ATTENZIONE[^\]]*|SNIPE 461|SOFT-BAN[^\]]*)\]\s*/i, '');
    let tag = 'AVVISO';
    if (/461/i.test(text)) tag = '461 PRESA';
    if (/captcha|458/i.test(text)) tag = 'CAPTCHA';
    if (/401/i.test(text)) tag = 'AUTH 401';
    if (/soft-ban|429/i.test(text)) tag = 'RATE LIMIT';
    return { category: 'warn', tag, text: clean };
  }

  // 5. Telemetria PIN
  if (/pin\s*telemetry|telemetr/i.test(text)) {
    let clean = text.replace(/^\[(PIN TELEMETRY)\]\s*/i, '');
    return { category: 'status', tag: 'PIN EVENT', text: clean };
  }

  // 6. Stato, Target, Configurazione e Cicli
  if (/avvio|ciclo|fase|target|completat|pronto|inizializz|terminat|filtro|riconciliazione|tradepile/i.test(text)) {
    let clean = text.replace(/^\[(SNIPING TARGET|LAZY TRADING|LAZY BIDDING|TENTATIVI COMPLETATI)\]\s*/i, '');
    return { category: 'status', tag: 'STATO', text: clean };
  }

  // 7. Generico Info
  return { category: 'info', tag: 'INFO', text: text.replace(/^\[[^\]]+\]\s*/, '') };
}

function updateBotStatusBar(category, tag, text) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusSubtext = document.getElementById('statusSubtext');
  if (!statusText || !statusDot || !statusSubtext) return;

  if (category === 'trade') {
    statusDot.className = 'text-success';
    statusText.textContent = tag === 'VENDITA' ? 'Carta in vendita' : 'Acquisto riuscito!';
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  } else if (category === 'bid') {
    statusDot.className = 'text-primary';
    statusText.textContent = 'Offerta piazzata';
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  } else if (category === 'sleep') {
    statusDot.className = 'text-warning';
    statusText.textContent = 'In pausa (Attesa)';
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  } else if (category === 'warn') {
    statusDot.className = 'text-danger';
    statusText.textContent = tag;
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  } else if (category === 'status') {
    statusDot.className = 'text-info';
    statusText.textContent = 'In esecuzione';
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  }
}

// Funzione avanzata per aggiungere log formattati alla console interattiva
function logToScreen(message) {
  if (!message) return;
  const logConsole = document.getElementById('logConsole');
  const logViewer = document.getElementById('logViewer');
  const logCount = document.getElementById('logCount');

  // Fallback per logViewer grezzo (mantiene compatibilità)
  if (logViewer) {
    const timestamp = new Date().toLocaleTimeString();
    logViewer.value += `[${timestamp}] ${message}\n`;
  }

  if (!logConsole) return;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
  const { category, tag, text } = classifyLogMessage(message);

  allLogRecords.push({
    timestamp: timeStr,
    iso: now.toISOString(),
    category,
    tag,
    raw: String(message || '').trim()
  });

  updateBotStatusBar(category, tag, text);

  const row = document.createElement('div');
  row.className = `log-row filter-${category}`;
  row.dataset.category = category;

  if (currentFilter !== 'all') {
    if (currentFilter === 'trade' && category !== 'trade' && category !== 'bid') {
      row.style.display = 'none';
    } else if (currentFilter === 'sleep' && category !== 'sleep' && category !== 'status') {
      row.style.display = 'none';
    } else if (currentFilter === 'warn' && category !== 'warn') {
      row.style.display = 'none';
    }
  }

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = timeStr;

  const tagSpan = document.createElement('span');
  tagSpan.className = `log-tag tag-${category}`;
  tagSpan.textContent = tag;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = text;

  row.appendChild(timeSpan);
  row.appendChild(tagSpan);
  row.appendChild(msgSpan);

  logConsole.appendChild(row);

  totalLogEvents++;
  if (logCount) {
    logCount.textContent = `${totalLogEvents} eventi`;
  }

  // Massimo 250 righe mantenute in DOM per garantire memoria leggera e reattività
  while (logConsole.childElementCount > 250) {
    logConsole.removeChild(logConsole.firstElementChild);
  }

  logConsole.scrollTop = logConsole.scrollHeight;
}

// Keep-Alive Connection dalla UI per prevenire la chiusura del Service Worker in Manifest V3
let uiKeepAlivePort = null;
function setupUiKeepAlive() {
  try {
    uiKeepAlivePort = chrome.runtime.connect({ name: "KEEP_ALIVE_PORT" });
    uiKeepAlivePort.onDisconnect.addListener(() => {
      const _ = chrome.runtime.lastError;
      uiKeepAlivePort = null;
      setTimeout(setupUiKeepAlive, 1000);
    });
    uiKeepAlivePort.onMessage.addListener(() => {});
  } catch (e) {
    setTimeout(setupUiKeepAlive, 1000);
  }
}
setupUiKeepAlive();

// Ping ogni 20 secondi: azzera il timer di inattività del Service Worker finché la UI è aperta
setInterval(() => {
  try {
    if (uiKeepAlivePort) {
      uiKeepAlivePort.postMessage({ type: "KEEP_ALIVE_PING" });
    } else {
      setupUiKeepAlive();
    }
  } catch (e) {
    setupUiKeepAlive();
  }
}, 20000);

