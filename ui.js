document.addEventListener('DOMContentLoaded', () => {
  const numeroTentativi = document.getElementById('tentativi');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const tentativiRimasti = document.getElementById('tentativiRimasti');
  const carteAcquistate = document.getElementById('carteAcquistate');
  const carteVendute = document.getElementById('carteVendute');
  const crediti = document.getElementById('crediti');
  const proiezioneCrediti = document.getElementById('proiezioneCrediti');
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
  const telegramChatIdInput = document.getElementById('telegramChatIdInput');
  const testTelegramBtn = document.getElementById('testTelegramBtn');
  const telegramTestFeedback = document.getElementById('telegramTestFeedback');
  const modeLazy = document.getElementById('modeLazy');
  const labelModeLazy = document.getElementById('labelModeLazy') || document.querySelector('label[for="modeLazy"]');
  const snipeSpecificContainer = document.getElementById('snipeSpecificContainer');
  const manualConfigContainer = document.getElementById('manualConfigContainer');
  const manualPriceInput = document.getElementById('manualPriceInput');
  const manualPriceLabel = document.getElementById('manualPriceLabel');
  const manualPriceHelp = document.getElementById('manualPriceHelp');

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
    const target = getSelectedTargetMode();
    if (target === 'manual' && manualPriceInput) {
      return parseInt(manualPriceInput.value) || 0;
    }
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

  const setStatusBar = (dotClass, text, subtext) => {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const statusSubtext = document.getElementById('statusSubtext');
    if (statusDot) statusDot.className = dotClass;
    if (statusText) statusText.textContent = text;
    if (statusSubtext) statusSubtext.textContent = subtext;
  };

  const setRunningUiState = (running) => {
    if (running) {
      startBtn.setAttribute('disabled', 'true');
      numeroTentativi.setAttribute('disabled', 'true');
      setControlsDisabled(true);
      stopBtn.removeAttribute('disabled');
    } else {
      startBtn.removeAttribute('disabled');
      numeroTentativi.removeAttribute('disabled');
      setControlsDisabled(false);
      stopBtn.setAttribute('disabled', 'true');
    }
  };

  const toggleTargetContainers = () => {
    const target = getSelectedTargetMode();
    if (target === 'fodder') {
      fodderRatingContainer.classList.remove('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (manualConfigContainer) manualConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = true;

      // Mostra pulsante Lazy sia per Fodder che per Consumabili
      if (modeLazy) modeLazy.classList.remove('d-none');
      if (labelModeLazy) labelModeLazy.classList.remove('d-none');
    } else if (target === 'consumables') {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.remove('d-none');
      if (manualConfigContainer) manualConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = false;

      // Mostra pulsante Lazy per Consumabili
      if (modeLazy) modeLazy.classList.remove('d-none');
      if (labelModeLazy) labelModeLazy.classList.remove('d-none');
    } else if (target === 'managerLeague') {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (manualConfigContainer) manualConfigContainer.classList.add('d-none');
      if (switchFodder) switchFodder.checked = false;

      // Campionati Allenatore: solo Lazy, pulsante visibile e pre-selezionato
      if (modeLazy) {
        modeLazy.classList.remove('d-none');
        if (!modeLazy.checked) {
          modeLazy.checked = true;
          toggleStrategyContainers();
          queueSettingsSave({ strategyMode: 'lazy' });
        }
      }
      if (labelModeLazy) labelModeLazy.classList.remove('d-none');
    } else {
      fodderRatingContainer.classList.add('d-none');
      consumablesConfigContainer.classList.add('d-none');
      if (manualConfigContainer) manualConfigContainer.classList.remove('d-none');
      if (switchFodder) switchFodder.checked = false;

      // Nascondi pulsante Lazy su Manuale
      if (modeLazy) modeLazy.classList.add('d-none');
      if (labelModeLazy) labelModeLazy.classList.add('d-none');
      if (modeLazy && modeLazy.checked) {
        const snipingRadio = document.getElementById('modeSniping');
        if (snipingRadio) snipingRadio.checked = true;
        queueSettingsSave({ strategyMode: 'sniping' });
      }
    }
    toggleStrategyContainers();
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
    const target = getSelectedTargetMode();

    if (target === 'manual') {
      if (biddingConfigContainer) biddingConfigContainer.classList.add('d-none');
      if (lazyConfigContainer) lazyConfigContainer.classList.add('d-none');
      if (snipeSpecificContainer) snipeSpecificContainer.classList.add('d-none');
      if (manualConfigContainer) manualConfigContainer.classList.remove('d-none');

      if (strategy === 'bidding') {
        if (manualPriceLabel) manualPriceLabel.textContent = "Prezzo Max Offerta (Asta):";
        if (manualPriceInput) manualPriceInput.placeholder = "es. 1000 (obbligatorio)";
        if (manualPriceHelp) manualPriceHelp.textContent = "Tetto massimo per le offerte all'asta. Obbligatorio per sicurezza.";
      } else {
        if (manualPriceLabel) manualPriceLabel.textContent = "Prezzo Max Compra Ora (Snipe):";
        if (manualPriceInput) manualPriceInput.placeholder = "es. 2000 (obbligatorio)";
        if (manualPriceHelp) manualPriceHelp.textContent = "Tetto massimo per il Compra Ora. Obbligatorio per sicurezza.";
      }
      return;
    }

    if (manualConfigContainer) manualConfigContainer.classList.add('d-none');

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
    if (manualPriceInput) disabled ? manualPriceInput.setAttribute('disabled', 'true') : manualPriceInput.removeAttribute('disabled');
    if (minMarginInput) disabled ? minMarginInput.setAttribute('disabled', 'true') : minMarginInput.removeAttribute('disabled');
    if (targetTradepileSizeInput) disabled ? targetTradepileSizeInput.setAttribute('disabled', 'true') : targetTradepileSizeInput.removeAttribute('disabled');
    if (lazyMarkupPercentInput) disabled ? lazyMarkupPercentInput.setAttribute('disabled', 'true') : lazyMarkupPercentInput.removeAttribute('disabled');
    if (lazySleepMinutesInput) disabled ? lazySleepMinutesInput.setAttribute('disabled', 'true') : lazySleepMinutesInput.removeAttribute('disabled');
  };

  // Salvataggio impostazioni accumulato con debounce breve:
  // evita una chiamata storage.local.set separata per ogni change handler
  let pendingSettings = {};
  let settingsSaveTimer = null;
  const queueSettingsSave = (partial) => {
    pendingSettings = Object.assign(pendingSettings, partial);
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
      const toSave = pendingSettings;
      pendingSettings = {};
      settingsSaveTimer = null;
      chrome.storage.local.set(toSave);
    }, 250);
  };

  targetModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      toggleTargetContainers();
      queueSettingsSave({
        targetMode: radio.value,
        fodderMode: radio.value === 'fodder'
      });
    });
  });

  if (autoBinCheck) {
    autoBinCheck.addEventListener('change', () => {
      toggleManualBinVisibility();
      queueSettingsSave({ autoBin: autoBinCheck.checked });
    });
  }

  if (manualBinInput) {
    manualBinInput.addEventListener('change', () => {
      queueSettingsSave({ manualBin: parseInt(manualBinInput.value) || 0 });
    });
  }

  if (maxSnipePriceInput) {
    maxSnipePriceInput.addEventListener('change', () => {
      const val = parseInt(maxSnipePriceInput.value) || 0;
      if (manualPriceInput) manualPriceInput.value = val > 0 ? val : '';
      queueSettingsSave({ maxSnipePrice: val });
    });
  }

  if (manualPriceInput) {
    manualPriceInput.addEventListener('change', () => {
      const val = parseInt(manualPriceInput.value) || 0;
      if (maxSnipePriceInput) maxSnipePriceInput.value = val > 0 ? val : '';
      queueSettingsSave({ maxSnipePrice: val });
    });
  }

  if (chemStyleSelect) {
    chemStyleSelect.addEventListener('change', () => {
      queueSettingsSave({ chemStyle: chemStyleSelect.value });
    });
  }

  fodderRatingRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      queueSettingsSave({ fodderRating: radio.value });
    });
  });

  strategyModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      toggleStrategyContainers();
      queueSettingsSave({ strategyMode: radio.value });
    });
  });

  if (minMarginInput) {
    minMarginInput.addEventListener('change', () => {
      queueSettingsSave({ minMargin: parseInt(minMarginInput.value) || 200 });
    });
  }

  if (targetTradepileSizeInput) {
    targetTradepileSizeInput.addEventListener('change', () => {
      queueSettingsSave({ targetTradepileSize: parseInt(targetTradepileSizeInput.value) || 50 });
    });
  }

  if (lazyMarkupPercentInput) {
    lazyMarkupPercentInput.addEventListener('change', () => {
      queueSettingsSave({ lazyMarkupPercent: parseInt(lazyMarkupPercentInput.value) || 10 });
    });
  }

  if (lazySleepMinutesInput) {
    lazySleepMinutesInput.addEventListener('change', () => {
      queueSettingsSave({ lazySleepMinutes: parseInt(lazySleepMinutesInput.value) || 63 });
    });
  }

  if (telegramChatIdInput) {
    const saveChatId = () => {
      const val = telegramChatIdInput.value.trim();
      queueSettingsSave({ telegramChatId: val });
    };
    telegramChatIdInput.addEventListener('input', saveChatId);
    telegramChatIdInput.addEventListener('change', saveChatId);
  }

  if (testTelegramBtn && telegramChatIdInput) {
    testTelegramBtn.addEventListener('click', () => {
      const chatId = telegramChatIdInput.value.trim();
      if (!chatId) {
        if (telegramTestFeedback) {
          telegramTestFeedback.className = 'form-text text-danger';
          telegramTestFeedback.textContent = 'Inserisci un Chat ID prima di effettuare il test.';
        }
        return;
      }

      // Salva subito il Chat ID
      chrome.storage.local.set({ telegramChatId: chatId });

      testTelegramBtn.setAttribute('disabled', 'true');
      if (telegramTestFeedback) {
        telegramTestFeedback.className = 'form-text text-muted';
        telegramTestFeedback.textContent = 'Invio messaggio di test in corso...';
      }

      chrome.runtime.sendMessage({ tipo: 'TELEGRAM_TEST', chatId: chatId }, (response) => {
        testTelegramBtn.removeAttribute('disabled');
        if (chrome.runtime.lastError) {
          if (telegramTestFeedback) {
            telegramTestFeedback.className = 'form-text text-danger';
            telegramTestFeedback.textContent = 'Errore comunicazione: ' + chrome.runtime.lastError.message;
          }
          return;
        }

        if (response && response.success) {
          if (telegramTestFeedback) {
            telegramTestFeedback.className = 'form-text text-success';
            telegramTestFeedback.textContent = '✅ Messaggio inviato! Controlla Telegram.';
          }
        } else {
          if (telegramTestFeedback) {
            telegramTestFeedback.className = 'form-text text-danger';
            telegramTestFeedback.textContent = '❌ Fallito: ' + (response?.error || 'Verifica il Chat ID o avvia il bot su Telegram.');
          }
        }
      });
    });
  }

  // Ripristino stato salvato all'avvio
  chrome.storage.local.get([
    'numeroTentativi', 'targetMode', 'fodderMode', 'fodderRating',
    'chemStyle', 'autoBin', 'manualBin', 'strategyMode', 'minMargin', 'maxSnipePrice',
    'targetTradepileSize', 'lazyMarkupPercent', 'lazySleepMinutes', 'telegramChatId', 'personaName',
    'tradepileCount', 'crediti', 'proiezioneCrediti', 'carteAcquistate', 'carteVendute', 'start', 'botStatus'
  ], (result) => {
    const accBadge = document.getElementById('eaAccountNameBadge');
    if (accBadge) {
      accBadge.textContent = result.personaName ? result.personaName : 'In attesa di sync...';
    }
    if (result.tradepileCount) {
      const tpEl = document.getElementById('tradepileCount');
      if (tpEl) tpEl.textContent = result.tradepileCount;
    }
    if (result.crediti !== undefined && crediti) {
      crediti.textContent = typeof result.crediti === 'number' ? result.crediti.toLocaleString('it-IT') : String(result.crediti);
    }
    if (result.proiezioneCrediti !== undefined && proiezioneCrediti) {
      proiezioneCrediti.textContent = String(result.proiezioneCrediti);
    }
    if (result.carteAcquistate !== undefined && carteAcquistate) {
      carteAcquistate.textContent = String(result.carteAcquistate);
    }
    if (result.carteVendute !== undefined && carteVendute) {
      carteVendute.textContent = String(result.carteVendute);
    }

    if (result.numeroTentativi) {
      numeroTentativi.value = result.numeroTentativi;
    }

    if (result.telegramChatId && telegramChatIdInput) {
      telegramChatIdInput.value = result.telegramChatId;
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

    if (result.maxSnipePrice) {
      if (maxSnipePriceInput) maxSnipePriceInput.value = result.maxSnipePrice;
      if (manualPriceInput) manualPriceInput.value = result.maxSnipePrice;
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

    // Ripristina lo stato di esecuzione: se il bot era attivo, Stop deve rifletterlo
    if (result.start === true) {
      setRunningUiState(true);
      setStatusBar('text-success', 'In esecuzione', 'Sessione ripristinata');
    }
    if (result.botStatus && typeof result.botStatus === 'object') {
      const bs = result.botStatus;
      if (bs.text || bs.subtext || bs.dotClass) {
        setStatusBar(bs.dotClass || 'text-secondary', bs.text || 'Pronto', bs.subtext || '');
      }
    }
  });

  // Disabilito il tasto stop all'inizio (verrà riabilitato dal ripristino se start=true)
  stopBtn.setAttribute('disabled', 'true');

  startBtn.addEventListener('click', () => {
    let selectedTarget = getSelectedTargetMode();
    const selectedRating = getSelectedRating();
    const selectedStrategy = getSelectedStrategy();

    const selectedChemStyle = getSelectedChemStyle();
    const autoBin = isAutoBinEnabled();
    const manualBin = getManualBinPrice();
    const maxSnipePrice = getMaxSnipePrice();

    if (selectedTarget === 'manual') {
      if (!maxSnipePrice || maxSnipePrice <= 0) {
        const fieldName = selectedStrategy === 'bidding' ? 'Prezzo Max Offerta (Asta)' : 'Prezzo Max Compra Ora (Snipe)';
        alert(`Attenzione: devi impostare il "${fieldName}" per avviare la modalità Manuale.`);
        if (manualPriceInput) manualPriceInput.focus();
        return;
      }
    }

    const minMargin = minMarginInput ? (parseInt(minMarginInput.value) || 200) : 200;
    const targetTradepileSize = getTargetTradepileSize();
    const lazyMarkupPercent = getLazyMarkupPercent();
    const lazySleepMinutes = getLazySleepMinutes();

    const settings = {
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
      lazySleepMinutes: lazySleepMinutes,
      telegramChatId: telegramChatIdInput ? telegramChatIdInput.value.trim() : '',
      start: true
    };

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

    // Svuota eventuali salvataggi debounced pendenti prima dello START
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
      Object.assign(settings, pendingSettings);
      pendingSettings = {};
      settingsSaveTimer = null;
    }

    // Attende il salvataggio dello storage prima di inviare START al background
    chrome.storage.local.set(settings, () => {
      chrome.runtime.sendMessage(startPayload, () => {
        // Compatibilità: il background può non rispondere (nessun sendResponse)
        if (chrome.runtime.lastError) {
          console.warn('[FC Sniper UI] Nessun acknowledgement dal background:', chrome.runtime.lastError.message);
        }
      });

      // Disabilito i controlli e abilito il tasto stop
      setRunningUiState(true);
    });
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ tipo: 'START', valore: false }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FC Sniper UI] Nessun acknowledgement dal background:', chrome.runtime.lastError.message);
      }
    });
    chrome.storage.local.set({ start: false });

    // Abilito i controlli e disabilito il tasto stop
    setRunningUiState(false);
    setStatusBar('text-secondary', 'Arrestato', 'Operazione interrotta dall\'utente');
  });

  // Toggle collapse minimale (sostituisce bootstrap.bundle.min.js)
  document.querySelectorAll('[data-bs-toggle="collapse"]').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const selector = toggle.getAttribute('href') || toggle.getAttribute('data-bs-target');
      const target = selector ? document.querySelector(selector) : null;
      if (!target) return;
      const isOpen = target.classList.toggle('show');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
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

      const verText = document.getElementById('versione')?.textContent?.trim() || 'v2.7.0';
      const targetMode = typeof getSelectedTargetMode === 'function' ? getSelectedTargetMode() : 'N/D';
      const strategyMode = typeof getSelectedStrategy === 'function' ? getSelectedStrategy() : 'N/D';
      const creditiVal = document.getElementById('crediti')?.textContent?.trim() || 'N/D';
      const proiezioneVal = document.getElementById('proiezioneCrediti')?.textContent?.trim() || 'N/D';
      const carteVal = document.getElementById('carteAcquistate')?.textContent?.trim() || '0';
      const tentativiVal = document.getElementById('tentativi')?.value || 'N/D';
      const truncated = totalLogEvents > allLogRecords.length;

      let content = `=================================================================\n`;
      content += `  FC Sniper & Trader - Report Log Sessione\n`;
      content += `  Versione: ${verText} | Data Export: ${now.toLocaleString()}\n`;
      content += `  Modalità: ${String(targetMode).toUpperCase()} | Strategia: ${String(strategyMode).toUpperCase()}\n`;
      content += `  Crediti: ${creditiVal} (Proiezione: ${proiezioneVal}) | Carte Acquistate: ${carteVal} | Tentativi: ${tentativiVal}\n`;
      content += `  Totale Eventi Registrati: ${totalLogEvents}\n`;
      content += `  Eventi Inclusi nel Report: ${allLogRecords.length} (buffer max ${MAX_LOG_RECORDS})\n`;
      if (truncated) {
        content += `  NOTA: Report troncato — i ${totalLogEvents - allLogRecords.length} eventi più vecchi non sono inclusi.\n`;
      }
      content += `=================================================================\n\n`;

      if (allLogRecords.length > 0) {
        allLogRecords.forEach((r) => {
          content += `[${r.timestamp}] [${r.tag}] ${r.raw}\n`;
        });
      } else {
        content += `Nessun evento registrato nella sessione corrente.\n`;
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

  // Unico listener runtime.onMessage con dispatch per tipo di messaggio
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.tipo) return;

    switch (message.tipo) {
      case 'LOG':
        logToScreen(message.valore);
        break;

      case 'START':
        // Il bot si è fermato da solo (fine ricerche, errore, ecc.)
        setRunningUiState(false);
        chrome.storage.local.set({ start: false });
        setStatusBar('text-secondary', 'Completato / Pronto', 'Sessione terminata');
        break;

      case 'TENTATIVI_RIMASTI':
        if (tentativiRimasti) {
          tentativiRimasti.textContent = message.valore !== "" ? String(message.valore) : "-";
        }
        break;

      case 'CARTA_ACQUISTATA':
        if (carteAcquistate) {
          carteAcquistate.textContent = message.valore !== "" ? String(message.valore) : "0";
        }
        break;

      case 'CARTA_VENDUTA':
        if (carteVendute) {
          carteVendute.textContent = message.valore !== "" ? String(message.valore) : "0";
        }
        break;

      case 'TRADEPILE_COUNT': {
        const tradepileCount = document.getElementById('tradepileCount');
        if (tradepileCount) {
          tradepileCount.textContent = message.valore !== "" ? String(message.valore) : "-";
        }
        break;
      }

      case 'CREDITI':
        if (crediti) {
          crediti.textContent = typeof message.valore === 'number'
            ? message.valore.toLocaleString('it-IT')
            : (message.valore ? String(message.valore) : 'N/D');
        }
        break;

      case 'PROIEZIONE_CREDITI':
        if (proiezioneCrediti) {
          proiezioneCrediti.textContent = message.valore !== "" ? String(message.valore) : "-";
        }
        break;

      case 'USER_SYNC': {
        const accBadge = document.getElementById('eaAccountNameBadge');
        if (accBadge && message.personaName) {
          accBadge.textContent = message.personaName;
        }
        break;
      }
    }
  });
});

let currentFilter = 'all';
let totalLogEvents = 0;
const MAX_LOG_RECORDS = 1000;
const allLogRecords = [];

function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

function applyLogFilter() {
  const rows = document.querySelectorAll('#logConsole .log-row');
  rows.forEach(r => {
    const cat = r.dataset.category;
    if (currentFilter === 'all') {
      r.style.display = '';
    } else if (currentFilter === 'trade' && (cat === 'trade' || cat === 'bid' || cat === 'outbid')) {
      r.style.display = '';
    } else if (currentFilter === 'sleep' && (cat === 'sleep' || cat === 'status')) {
      r.style.display = '';
    } else if (currentFilter === 'warn' && (cat === 'warn' || cat === 'outbid')) {
      r.style.display = '';
    } else {
      r.style.display = 'none';
    }
  });
  const logConsole = document.getElementById('logConsole');
  if (logConsole && isScrolledToBottom(logConsole)) {
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

function classifyLogMessage(raw) {
  const text = String(raw || '').trim();

  // 1. Aste Superate, Perse o Abbandonate (Priorità alta con colore dedicato Arancione: intercetta prima che "non vinta" o "rilancio" vengano confusi con acquisti/offerte)
  if (!/^\[CONTRORILANCIO\]/i.test(text) && (/superata|superato|asta persa|non vinta|abbandon/i.test(text) || /^\[ASTA SUPERATA\]/i.test(text))) {
    let clean = text.replace(/^\[(ASTA SUPERATA|ASTA PERSA|ASTA NON VINTA)\]\s*/i, '');
    let tag = 'SUPERATA';
    if (/persa|non vinta/i.test(text)) tag = 'ASTA PERSA';
    if (/abbandon/i.test(text) && !/superat/i.test(text)) tag = 'ABBANDONO';
    return { category: 'outbid', tag, text: clean };
  }

  // 2. Trades: Acquisti e Vendite (Verde)
  if (/acquisto|acquistata|acquistate|vinta|vendita|listata|listato/i.test(text) && !/errore|persa|non vinta/i.test(text)) {
    let clean = text.replace(/^\[(ACQUISTO RIUSCITO|LAZY BUY NOW|ASTA VINTA|Reconciliation)\]\s*/i, '');
    let tag = 'ACQUISTO';
    if (/vendita|listat/i.test(text) && !/acquist/i.test(text)) tag = 'VENDITA';
    if (/vinta/i.test(text)) tag = 'VINTA';
    return { category: 'trade', tag, text: clean };
  }

  // 3. Offerte / Bidding & Controrilanci (Viola)
  if (/offerta|bid|bidding|controrilancio|rilancio/i.test(text) && !/errore|terminat|abbandon/i.test(text)) {
    let clean = text.replace(/^\[(LAZY BID|MASS BID|FC Sniper|CONTRORILANCIO)\]\s*/i, '');
    let tag = 'OFFERTA';
    if (/controrilancio|rilancio/i.test(text)) tag = 'RILANCIO';
    return { category: 'bid', tag, text: clean };
  }

  // 4. Pause / Sleep / Heartbeat (Giallo/Oro)
  if (/pausa|dormiente|heartbeat|cool\s*down|attesa|attendo/i.test(text)) {
    let clean = text.replace(/^\[(LAZY HEARTBEAT|PAUSA DI SICUREZZA[^\]]*|PAUSA)\]\s*/i, '');
    return { category: 'sleep', tag: 'PAUSA', text: clean };
  }

  // 5. Avvisi ed Errori / 461 / Captcha / Limiti (Rosso)
  if (/errore|461|401|429|458|captcha|soft-ban|fallit|attenzione/i.test(text)) {
    let clean = text.replace(/^\[(ATTENZIONE[^\]]*|SNIPE 461|SOFT-BAN[^\]]*)\]\s*/i, '');
    let tag = 'AVVISO';
    if (/461/i.test(text)) tag = '461 PRESA';
    if (/captcha|458/i.test(text)) tag = 'CAPTCHA';
    if (/401/i.test(text)) tag = 'AUTH 401';
    if (/soft-ban|429/i.test(text)) tag = 'RATE LIMIT';
    return { category: 'warn', tag, text: clean };
  }

  // 6. Telemetria PIN (Blu)
  if (/pin\s*telemetry|telemetr/i.test(text)) {
    let clean = text.replace(/^\[(PIN TELEMETRY)\]\s*/i, '');
    return { category: 'status', tag: 'PIN EVENT', text: clean };
  }

  // 7. Stato, Target, Configurazione e Cicli (Blu)
  if (/avvio|ciclo|fase|target|completat|pronto|inizializz|terminat|filtro|riconciliazione|tradepile/i.test(text)) {
    let clean = text.replace(/^\[(SNIPING TARGET|LAZY TRADING|LAZY BIDDING|TENTATIVI COMPLETATI)\]\s*/i, '');
    return { category: 'status', tag: 'STATO', text: clean };
  }

  // 8. Generico Info (Grigio)
  return { category: 'info', tag: 'INFO', text: text.replace(/^\[[^\]]+\]\s*/, '') };
}

function updateBotStatusBar(category, tag, text) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusSubtext = document.getElementById('statusSubtext');
  if (!statusText || !statusDot || !statusSubtext) return;

  statusDot.style.color = '';

  if (category === 'trade') {
    statusDot.className = 'text-success';
    statusText.textContent = tag === 'VENDITA' ? 'Carta in vendita' : 'Acquisto riuscito!';
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  } else if (category === 'bid') {
    statusDot.className = 'text-primary';
    statusText.textContent = 'Offerta piazzata';
    statusSubtext.textContent = text.length > 38 ? text.substring(0, 35) + '...' : text;
  } else if (category === 'outbid') {
    statusDot.className = '';
    statusDot.style.color = '#ff922b';
    statusText.textContent = tag === 'ASTA PERSA' ? 'Asta non vinta' : 'Asta superata';
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
  const logCount = document.getElementById('logCount');
  if (!logConsole) return;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
  const { category, tag, text } = classifyLogMessage(message);

  // Buffer bounded: mantiene al massimo MAX_LOG_RECORDS record per l'export
  allLogRecords.push({
    timestamp: timeStr,
    iso: now.toISOString(),
    category,
    tag,
    raw: String(message || '').trim()
  });
  if (allLogRecords.length > MAX_LOG_RECORDS) {
    allLogRecords.splice(0, allLogRecords.length - MAX_LOG_RECORDS);
  }

  updateBotStatusBar(category, tag, text);

  const wasAtBottom = isScrolledToBottom(logConsole);

  const row = document.createElement('div');
  row.className = `log-row filter-${category}`;
  row.dataset.category = category;

  if (currentFilter !== 'all') {
    if (currentFilter === 'trade' && category !== 'trade' && category !== 'bid' && category !== 'outbid') {
      row.style.display = 'none';
    } else if (currentFilter === 'sleep' && category !== 'sleep' && category !== 'status') {
      row.style.display = 'none';
    } else if (currentFilter === 'warn' && category !== 'warn' && category !== 'outbid') {
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

  // Scroll automatico solo se l'utente era già in fondo alla console
  if (wasAtBottom) {
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}
