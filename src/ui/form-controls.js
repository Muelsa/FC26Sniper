// Gestione dei controlli del form, visibilità pannelli e sincronizzazione storage UI (Fase 6 Refactor)
import { setStatusBar } from './log-console.js';

export const DOM = {};

export function initDomReferences() {
  DOM.numeroTentativi = document.getElementById('tentativi');
  DOM.startBtn = document.getElementById('startBtn');
  DOM.stopBtn = document.getElementById('stopBtn');
  DOM.tentativiRimasti = document.getElementById('tentativiRimasti');
  DOM.carteAcquistate = document.getElementById('carteAcquistate');
  DOM.carteVendute = document.getElementById('carteVendute');
  DOM.crediti = document.getElementById('crediti');
  DOM.proiezioneCrediti = document.getElementById('proiezioneCrediti');
  DOM.switchFodder = document.getElementById('switchFodder');
  DOM.targetModeRadios = document.querySelectorAll('input[name="targetMode"]');
  DOM.fodderRatingContainer = document.getElementById('fodderRatingContainer');
  DOM.fodderRatingRadios = document.querySelectorAll('input[name="fodderRating"]');
  DOM.consumablesConfigContainer = document.getElementById('consumablesConfigContainer');
  DOM.chemStyleSelect = document.getElementById('chemStyleSelect');
  DOM.autoBinCheck = document.getElementById('autoBinCheck');
  DOM.manualBinContainer = document.getElementById('manualBinContainer');
  DOM.manualBinInput = document.getElementById('manualBinInput');
  DOM.strategyModeRadios = document.querySelectorAll('input[name="strategyMode"]');
  DOM.biddingConfigContainer = document.getElementById('biddingConfigContainer');
  DOM.minMarginInput = document.getElementById('minMargin');
  DOM.maxSnipePriceInput = document.getElementById('maxSnipePriceInput');
  DOM.lazyConfigContainer = document.getElementById('lazyConfigContainer');
  DOM.targetTradepileSizeInput = document.getElementById('targetTradepileSizeInput');
  DOM.lazyMarkupPercentInput = document.getElementById('lazyMarkupPercentInput');
  DOM.lazySleepMinutesInput = document.getElementById('lazySleepMinutesInput');
  DOM.telegramChatIdInput = document.getElementById('telegramChatIdInput');
  DOM.testTelegramBtn = document.getElementById('testTelegramBtn');
  DOM.telegramTestFeedback = document.getElementById('telegramTestFeedback');
  DOM.modeLazy = document.getElementById('modeLazy');
  DOM.labelModeLazy = document.getElementById('labelModeLazy') || document.querySelector('label[for="modeLazy"]');
  DOM.snipeSpecificContainer = document.getElementById('snipeSpecificContainer');
  DOM.manualConfigContainer = document.getElementById('manualConfigContainer');
  DOM.manualPriceInput = document.getElementById('manualPriceInput');
  DOM.manualPriceLabel = document.getElementById('manualPriceLabel');
  DOM.manualPriceHelp = document.getElementById('manualPriceHelp');
  DOM.managersConfigContainer = document.getElementById('managersConfigContainer');
  DOM.managerNationSelect = document.getElementById('managerNationSelect');
  DOM.sessionTimer = document.getElementById('sessionTimer');
  DOM.sessionTimerPill = document.getElementById('sessionTimerPill');
}

export const getSelectedTargetMode = () => {
  const checkedRadio = document.querySelector('input[name="targetMode"]:checked');
  return checkedRadio ? checkedRadio.value : 'fodder';
};

export const getSelectedManagerNation = () => {
  return DOM.managerNationSelect ? DOM.managerNationSelect.value : '18,34';
};

export const getSelectedRating = () => {
  const checkedRadio = document.querySelector('input[name="fodderRating"]:checked');
  return checkedRadio ? checkedRadio.value : '84';
};

export const getSelectedStrategy = () => {
  const checkedRadio = document.querySelector('input[name="strategyMode"]:checked');
  return checkedRadio ? checkedRadio.value : 'sniping';
};

export const getSelectedChemStyle = () => {
  return DOM.chemStyleSelect ? DOM.chemStyleSelect.value : '268';
};

export const isAutoBinEnabled = () => {
  return DOM.autoBinCheck ? DOM.autoBinCheck.checked : true;
};

export const getManualBinPrice = () => {
  return DOM.manualBinInput ? (parseInt(DOM.manualBinInput.value) || 0) : 0;
};

export const getMaxSnipePrice = () => {
  const target = getSelectedTargetMode();
  if (target === 'manual' && DOM.manualPriceInput) {
    return parseInt(DOM.manualPriceInput.value) || 0;
  }
  return DOM.maxSnipePriceInput ? (parseInt(DOM.maxSnipePriceInput.value) || 0) : 0;
};

export const getTargetTradepileSize = () => {
  return DOM.targetTradepileSizeInput ? (parseInt(DOM.targetTradepileSizeInput.value) || 50) : 50;
};

export const getLazyMarkupPercent = () => {
  return DOM.lazyMarkupPercentInput ? (parseInt(DOM.lazyMarkupPercentInput.value) || 10) : 10;
};

export const getLazySleepMinutes = () => {
  return DOM.lazySleepMinutesInput ? (parseInt(DOM.lazySleepMinutesInput.value) || 63) : 63;
};

let sessionTimerInterval = null;

export function formatElapsedTime(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function startSessionTimer(startTime) {
  stopSessionTimer();
  const startTs = typeof startTime === 'number' && startTime > 0 ? startTime : Date.now();
  const timerPill = DOM.sessionTimerPill || document.getElementById('sessionTimerPill');
  const timerVal = DOM.sessionTimer || document.getElementById('sessionTimer');
  if (timerPill) {
    timerPill.classList.add('timer-running');
  }
  if (timerVal) {
    timerVal.className = 'font-monospace text-success';
  }
  const tick = () => {
    if (timerVal) {
      timerVal.textContent = formatElapsedTime(Date.now() - startTs);
    }
  };
  tick();
  sessionTimerInterval = setInterval(tick, 1000);
}

export function stopSessionTimer(freeze = false) {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
  const timerPill = DOM.sessionTimerPill || document.getElementById('sessionTimerPill');
  const timerVal = DOM.sessionTimer || document.getElementById('sessionTimer');
  if (timerPill) {
    timerPill.classList.remove('timer-running');
  }
  if (timerVal) {
    timerVal.className = 'font-monospace text-secondary';
    if (!freeze) {
      timerVal.textContent = '--:--:--';
    }
  }
}

export const setRunningUiState = (running, startTime = null) => {
  if (running) {
    DOM.startBtn?.setAttribute('disabled', 'true');
    DOM.numeroTentativi?.setAttribute('disabled', 'true');
    setControlsDisabled(true);
    DOM.stopBtn?.removeAttribute('disabled');
    startSessionTimer(startTime);
  } else {
    DOM.startBtn?.removeAttribute('disabled');
    DOM.numeroTentativi?.removeAttribute('disabled');
    setControlsDisabled(false);
    DOM.stopBtn?.setAttribute('disabled', 'true');
    stopSessionTimer(true);
  }
};

export const toggleTargetContainers = () => {
  const target = getSelectedTargetMode();
  const modeSniping = document.getElementById('modeSniping');
  const labelModeSniping = document.getElementById('labelModeSniping') || document.querySelector('label[for="modeSniping"]');
  const modeBidding = document.getElementById('modeBidding');
  const labelModeBidding = document.getElementById('labelModeBidding') || document.querySelector('label[for="modeBidding"]');
  const labelModeLazyText = document.getElementById('labelModeLazyText');

  if (DOM.managersConfigContainer) {
    DOM.managersConfigContainer.classList.toggle('d-none', target !== 'managers');
  }
  if (target === 'fodder') {
    DOM.fodderRatingContainer?.classList.remove('d-none');
    DOM.consumablesConfigContainer?.classList.add('d-none');
    if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.add('d-none');
    if (DOM.switchFodder) DOM.switchFodder.checked = true;

    modeSniping?.classList.remove('d-none');
    labelModeSniping?.classList.remove('d-none');
    modeBidding?.classList.remove('d-none');
    labelModeBidding?.classList.remove('d-none');
    if (DOM.modeLazy) DOM.modeLazy.classList.remove('d-none');
    if (DOM.labelModeLazy) DOM.labelModeLazy.classList.remove('d-none');
    if (labelModeLazyText) labelModeLazyText.textContent = 'Lazy';
  } else if (target === 'consumables') {
    DOM.fodderRatingContainer?.classList.add('d-none');
    DOM.consumablesConfigContainer?.classList.remove('d-none');
    if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.add('d-none');
    if (DOM.switchFodder) DOM.switchFodder.checked = false;

    modeSniping?.classList.remove('d-none');
    labelModeSniping?.classList.remove('d-none');
    modeBidding?.classList.remove('d-none');
    labelModeBidding?.classList.remove('d-none');
    if (DOM.modeLazy) DOM.modeLazy.classList.remove('d-none');
    if (DOM.labelModeLazy) DOM.labelModeLazy.classList.remove('d-none');
    if (labelModeLazyText) labelModeLazyText.textContent = 'Lazy';
  } else if (target === 'managerLeague') {
    DOM.fodderRatingContainer?.classList.add('d-none');
    DOM.consumablesConfigContainer?.classList.add('d-none');
    if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.add('d-none');
    if (DOM.switchFodder) DOM.switchFodder.checked = false;

    // Campionati: supportato solo in modalità Lazy nel bot
    modeSniping?.classList.add('d-none');
    labelModeSniping?.classList.add('d-none');
    modeBidding?.classList.add('d-none');
    labelModeBidding?.classList.add('d-none');
    if (DOM.modeLazy) {
      DOM.modeLazy.classList.remove('d-none');
      if (!DOM.modeLazy.checked) {
        DOM.modeLazy.checked = true;
        queueSettingsSave({ strategyMode: 'lazy' });
      }
    }
    if (DOM.labelModeLazy) DOM.labelModeLazy.classList.remove('d-none');
    if (labelModeLazyText) labelModeLazyText.textContent = 'Lazy (Campionati)';
  } else if (target === 'managers') {
    DOM.fodderRatingContainer?.classList.add('d-none');
    DOM.consumablesConfigContainer?.classList.add('d-none');
    if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.add('d-none');
    if (DOM.switchFodder) DOM.switchFodder.checked = false;

    // Allenatori: gira solo sul motore ciclico Lazy (-15% / vendita Lowest BIN)
    modeSniping?.classList.add('d-none');
    labelModeSniping?.classList.add('d-none');
    modeBidding?.classList.add('d-none');
    labelModeBidding?.classList.add('d-none');
    if (DOM.modeLazy) {
      DOM.modeLazy.classList.remove('d-none');
      if (!DOM.modeLazy.checked) {
        DOM.modeLazy.checked = true;
        queueSettingsSave({ strategyMode: 'lazy' });
      }
    }
    if (DOM.labelModeLazy) DOM.labelModeLazy.classList.remove('d-none');
    if (labelModeLazyText) labelModeLazyText.textContent = 'Lazy (Ciclo -15%)';
  } else {
    DOM.fodderRatingContainer?.classList.add('d-none');
    DOM.consumablesConfigContainer?.classList.add('d-none');
    if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.remove('d-none');
    if (DOM.switchFodder) DOM.switchFodder.checked = false;

    modeSniping?.classList.remove('d-none');
    labelModeSniping?.classList.remove('d-none');
    modeBidding?.classList.remove('d-none');
    labelModeBidding?.classList.remove('d-none');
    if (DOM.modeLazy) DOM.modeLazy.classList.add('d-none');
    if (DOM.labelModeLazy) DOM.labelModeLazy.classList.add('d-none');
    if (labelModeLazyText) labelModeLazyText.textContent = 'Lazy';
    if (DOM.modeLazy && DOM.modeLazy.checked) {
      if (modeSniping) modeSniping.checked = true;
      queueSettingsSave({ strategyMode: 'sniping' });
    }
  }
  toggleStrategyContainers();
};

export const toggleManualBinVisibility = () => {
  if (DOM.autoBinCheck && DOM.manualBinContainer) {
    if (DOM.autoBinCheck.checked) {
      DOM.manualBinContainer.classList.add('d-none');
    } else {
      DOM.manualBinContainer.classList.remove('d-none');
    }
  }
};

export const toggleStrategyContainers = () => {
  const strategy = getSelectedStrategy();
  const target = getSelectedTargetMode();
  const tentativiContainer = document.getElementById('tentativiContainer');
  const lazyMarkupBlock = document.getElementById('lazyMarkupBlock');
  const lazyFieldsGrid = document.getElementById('lazyFieldsGrid');
  const lazyConfigHelp = document.getElementById('lazyConfigHelp');

  // In modalità Lazy il ciclo è continuo fino a Stop (non usa numeroTentativi)
  if (tentativiContainer) {
    tentativiContainer.classList.toggle('d-none', strategy === 'lazy');
  }

  // Gli Allenatori vendono istantaneamente al Lowest BIN (non usano % di ricarico Lazy)
  if (lazyMarkupBlock && lazyFieldsGrid) {
    const isManagers = target === 'managers';
    lazyMarkupBlock.classList.toggle('d-none', isManagers);
    lazyFieldsGrid.className = isManagers ? 'field-grid-2' : 'field-grid-3';
  }
  if (lazyConfigHelp) {
    if (target === 'managers') {
      lazyConfigHelp.textContent = 'Ciclo continuo: acquisto automatico a -15% (Asta + Compra Ora), vendita immediata al Lowest BIN live e pausa con heartbeat.';
    } else {
      lazyConfigHelp.textContent = 'Ciclo continuo: pulizia venduti, relist invenduti, rifornimento (Asta + Compra Ora) con vendita scaglionata (+6% / +Ricarico% / +15%) e heartbeat ogni 7.5m.';
    }
  }

  if (target === 'manual') {
    if (DOM.biddingConfigContainer) DOM.biddingConfigContainer.classList.add('d-none');
    if (DOM.lazyConfigContainer) DOM.lazyConfigContainer.classList.add('d-none');
    if (DOM.snipeSpecificContainer) DOM.snipeSpecificContainer.classList.add('d-none');
    if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.remove('d-none');

    if (strategy === 'bidding') {
      if (DOM.manualPriceLabel) DOM.manualPriceLabel.textContent = "Prezzo Max Offerta (Asta):";
      if (DOM.manualPriceInput) DOM.manualPriceInput.placeholder = "es. 1000 (obbligatorio)";
      if (DOM.manualPriceHelp) DOM.manualPriceHelp.textContent = "Tetto massimo per le offerte all'asta. Obbligatorio per sicurezza.";
    } else {
      if (DOM.manualPriceLabel) DOM.manualPriceLabel.textContent = "Prezzo Max Compra Ora (Snipe):";
      if (DOM.manualPriceInput) DOM.manualPriceInput.placeholder = "es. 2000 (obbligatorio)";
      if (DOM.manualPriceHelp) DOM.manualPriceHelp.textContent = "Tetto massimo per il Compra Ora. Obbligatorio per sicurezza.";
    }
    return;
  }

  if (DOM.manualConfigContainer) DOM.manualConfigContainer.classList.add('d-none');

  if (strategy === 'bidding') {
    if (DOM.biddingConfigContainer) DOM.biddingConfigContainer.classList.remove('d-none');
    if (DOM.lazyConfigContainer) DOM.lazyConfigContainer.classList.add('d-none');
    if (DOM.snipeSpecificContainer) DOM.snipeSpecificContainer.classList.add('d-none');
  } else if (strategy === 'lazy') {
    if (DOM.biddingConfigContainer) DOM.biddingConfigContainer.classList.add('d-none');
    if (DOM.lazyConfigContainer) DOM.lazyConfigContainer.classList.remove('d-none');
    if (DOM.snipeSpecificContainer) DOM.snipeSpecificContainer.classList.add('d-none');
  } else {
    if (DOM.biddingConfigContainer) DOM.biddingConfigContainer.classList.add('d-none');
    if (DOM.lazyConfigContainer) DOM.lazyConfigContainer.classList.add('d-none');
    if (DOM.snipeSpecificContainer) DOM.snipeSpecificContainer.classList.remove('d-none');
  }
};

export const setControlsDisabled = (disabled) => {
  DOM.targetModeRadios?.forEach(r => disabled ? r.setAttribute('disabled', 'true') : r.removeAttribute('disabled'));
  DOM.fodderRatingRadios?.forEach(r => disabled ? r.setAttribute('disabled', 'true') : r.removeAttribute('disabled'));
  DOM.strategyModeRadios?.forEach(r => disabled ? r.setAttribute('disabled', 'true') : r.removeAttribute('disabled'));
  if (DOM.chemStyleSelect) disabled ? DOM.chemStyleSelect.setAttribute('disabled', 'true') : DOM.chemStyleSelect.removeAttribute('disabled');
  if (DOM.autoBinCheck) disabled ? DOM.autoBinCheck.setAttribute('disabled', 'true') : DOM.autoBinCheck.removeAttribute('disabled');
  if (DOM.manualBinInput) disabled ? DOM.manualBinInput.setAttribute('disabled', 'true') : DOM.manualBinInput.removeAttribute('disabled');
  if (DOM.maxSnipePriceInput) disabled ? DOM.maxSnipePriceInput.setAttribute('disabled', 'true') : DOM.maxSnipePriceInput.removeAttribute('disabled');
  if (DOM.manualPriceInput) disabled ? DOM.manualPriceInput.setAttribute('disabled', 'true') : DOM.manualPriceInput.removeAttribute('disabled');
  if (DOM.minMarginInput) disabled ? DOM.minMarginInput.setAttribute('disabled', 'true') : DOM.minMarginInput.removeAttribute('disabled');
  if (DOM.targetTradepileSizeInput) disabled ? DOM.targetTradepileSizeInput.setAttribute('disabled', 'true') : DOM.targetTradepileSizeInput.removeAttribute('disabled');
  if (DOM.lazyMarkupPercentInput) disabled ? DOM.lazyMarkupPercentInput.setAttribute('disabled', 'true') : DOM.lazyMarkupPercentInput.removeAttribute('disabled');
  if (DOM.lazySleepMinutesInput) disabled ? DOM.lazySleepMinutesInput.setAttribute('disabled', 'true') : DOM.lazySleepMinutesInput.removeAttribute('disabled');
  if (DOM.managerNationSelect) disabled ? DOM.managerNationSelect.setAttribute('disabled', 'true') : DOM.managerNationSelect.removeAttribute('disabled');
};

let pendingSettings = {};
let settingsSaveTimer = null;

export const queueSettingsSave = (partial) => {
  pendingSettings = Object.assign(pendingSettings, partial);
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    const toSave = pendingSettings;
    pendingSettings = {};
    settingsSaveTimer = null;
    chrome.storage.local.set(toSave);
  }, 250);
};

export const flushPendingSettingsSave = () => {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    const toSave = pendingSettings;
    pendingSettings = {};
    settingsSaveTimer = null;
    return toSave;
  }
  return {};
};

export function initThemeToggle() {
  const themeBtn = document.getElementById('themeToggleBtn');
  const applyTheme = (theme) => {
    const resolved = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', resolved);
    if (themeBtn) {
      themeBtn.setAttribute('aria-label', resolved === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro');
      themeBtn.dataset.currentTheme = resolved;
    }
  };

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['uiTheme'], (res) => {
      applyTheme(res?.uiTheme || 'dark');
    });
  } else {
    applyTheme('dark');
  }

  themeBtn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ uiTheme: next });
    }
  });
}

function updateTelegramBadge(chatId) {
  const badge = document.getElementById('telegramStatusBadge');
  if (!badge) return;
  if (chatId && String(chatId).trim().length > 0) {
    badge.textContent = 'Attivo';
    badge.className = 'tile-mini-tag text-success';
  } else {
    badge.textContent = 'Configura';
    badge.className = 'tile-mini-tag';
  }
}

export function initFormControls() {
  initDomReferences();
  initThemeToggle();

  DOM.targetModeRadios?.forEach(radio => {
    radio.addEventListener('change', () => {
      toggleTargetContainers();
      queueSettingsSave({
        targetMode: radio.value,
        fodderMode: radio.value === 'fodder'
      });
    });
  });

  if (DOM.autoBinCheck) {
    DOM.autoBinCheck.addEventListener('change', () => {
      toggleManualBinVisibility();
      queueSettingsSave({ autoBin: DOM.autoBinCheck.checked });
    });
  }

  if (DOM.manualBinInput) {
    DOM.manualBinInput.addEventListener('change', () => {
      queueSettingsSave({ manualBin: parseInt(DOM.manualBinInput.value) || 0 });
    });
  }

  if (DOM.managerNationSelect) {
    DOM.managerNationSelect.addEventListener('change', () => {
      queueSettingsSave({ managerNation: DOM.managerNationSelect.value });
    });
  }

  if (DOM.maxSnipePriceInput) {
    DOM.maxSnipePriceInput.addEventListener('change', () => {
      const val = parseInt(DOM.maxSnipePriceInput.value) || 0;
      if (DOM.manualPriceInput) DOM.manualPriceInput.value = val > 0 ? val : '';
      queueSettingsSave({ maxSnipePrice: val });
    });
  }

  if (DOM.manualPriceInput) {
    DOM.manualPriceInput.addEventListener('change', () => {
      const val = parseInt(DOM.manualPriceInput.value) || 0;
      if (DOM.maxSnipePriceInput) DOM.maxSnipePriceInput.value = val > 0 ? val : '';
      queueSettingsSave({ maxSnipePrice: val });
    });
  }

  if (DOM.chemStyleSelect) {
    DOM.chemStyleSelect.addEventListener('change', () => {
      queueSettingsSave({ chemStyle: DOM.chemStyleSelect.value });
    });
  }

  DOM.fodderRatingRadios?.forEach(radio => {
    radio.addEventListener('change', () => {
      queueSettingsSave({ fodderRating: radio.value });
    });
  });

  DOM.strategyModeRadios?.forEach(radio => {
    radio.addEventListener('change', () => {
      toggleStrategyContainers();
      queueSettingsSave({ strategyMode: radio.value });
    });
  });

  if (DOM.minMarginInput) {
    DOM.minMarginInput.addEventListener('change', () => {
      queueSettingsSave({ minMargin: parseInt(DOM.minMarginInput.value) || 200 });
    });
  }

  if (DOM.targetTradepileSizeInput) {
    DOM.targetTradepileSizeInput.addEventListener('change', () => {
      queueSettingsSave({ targetTradepileSize: parseInt(DOM.targetTradepileSizeInput.value) || 50 });
    });
  }

  if (DOM.lazyMarkupPercentInput) {
    DOM.lazyMarkupPercentInput.addEventListener('change', () => {
      queueSettingsSave({ lazyMarkupPercent: parseInt(DOM.lazyMarkupPercentInput.value) || 10 });
    });
  }

  if (DOM.lazySleepMinutesInput) {
    DOM.lazySleepMinutesInput.addEventListener('change', () => {
      queueSettingsSave({ lazySleepMinutes: parseInt(DOM.lazySleepMinutesInput.value) || 63 });
    });
  }

  if (DOM.telegramChatIdInput) {
    const saveChatId = () => {
      const val = DOM.telegramChatIdInput.value.trim();
      updateTelegramBadge(val);
      queueSettingsSave({ telegramChatId: val });
    };
    DOM.telegramChatIdInput.addEventListener('input', saveChatId);
    DOM.telegramChatIdInput.addEventListener('change', saveChatId);
  }

  if (DOM.testTelegramBtn && DOM.telegramChatIdInput) {
    DOM.testTelegramBtn.addEventListener('click', () => {
      const chatId = DOM.telegramChatIdInput.value.trim();
      if (!chatId) {
        if (DOM.telegramTestFeedback) {
          DOM.telegramTestFeedback.className = 'form-text text-danger';
          DOM.telegramTestFeedback.textContent = 'Inserisci un Chat ID prima di effettuare il test.';
        }
        return;
      }

      chrome.storage.local.set({ telegramChatId: chatId });

      DOM.testTelegramBtn.setAttribute('disabled', 'true');
      if (DOM.telegramTestFeedback) {
        DOM.telegramTestFeedback.className = 'form-text text-muted';
        DOM.telegramTestFeedback.textContent = 'Invio messaggio di test in corso...';
      }

      chrome.runtime.sendMessage({ tipo: 'TELEGRAM_TEST', chatId: chatId }, (response) => {
        DOM.testTelegramBtn?.removeAttribute('disabled');
        if (chrome.runtime.lastError) {
          if (DOM.telegramTestFeedback) {
            DOM.telegramTestFeedback.className = 'form-text text-danger';
            DOM.telegramTestFeedback.textContent = 'Errore comunicazione: ' + chrome.runtime.lastError.message;
          }
          return;
        }

        if (response && response.success) {
          if (DOM.telegramTestFeedback) {
            DOM.telegramTestFeedback.className = 'form-text text-success';
            DOM.telegramTestFeedback.textContent = '✅ Messaggio inviato! Controlla Telegram.';
          }
        } else {
          if (DOM.telegramTestFeedback) {
            DOM.telegramTestFeedback.className = 'form-text text-danger';
            DOM.telegramTestFeedback.textContent = '❌ Fallito: ' + (response?.error || 'Verifica il Chat ID o avvia il bot su Telegram.');
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
    'managerNation',
    'tradepileCount', 'crediti', 'proiezioneCrediti', 'carteAcquistate', 'carteVendute', 'start', 'botStatus',
    'botStartTime'
  ], (result) => {
    const accBadge = document.getElementById('eaAccountNameBadge');
    if (accBadge) {
      accBadge.textContent = result.personaName ? result.personaName : 'In attesa di sync...';
    }
    if (result.tradepileCount) {
      const tpEl = document.getElementById('tradepileCount');
      if (tpEl) tpEl.textContent = result.tradepileCount;
    }
    if (result.crediti !== undefined && DOM.crediti) {
      DOM.crediti.textContent = typeof result.crediti === 'number' ? result.crediti.toLocaleString('it-IT') : String(result.crediti);
    }
    if (result.proiezioneCrediti !== undefined && DOM.proiezioneCrediti) {
      DOM.proiezioneCrediti.textContent = String(result.proiezioneCrediti);
    }
    if (result.carteAcquistate !== undefined && DOM.carteAcquistate) {
      DOM.carteAcquistate.textContent = String(result.carteAcquistate);
    }
    if (result.carteVendute !== undefined && DOM.carteVendute) {
      DOM.carteVendute.textContent = String(result.carteVendute);
    }

    if (result.numeroTentativi && DOM.numeroTentativi) {
      DOM.numeroTentativi.value = result.numeroTentativi;
    }

    if (result.telegramChatId && DOM.telegramChatIdInput) {
      DOM.telegramChatIdInput.value = result.telegramChatId;
      updateTelegramBadge(result.telegramChatId);
    } else {
      updateTelegramBadge('');
    }

    if (result.managerNation && DOM.managerNationSelect) {
      DOM.managerNationSelect.value = result.managerNation;
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

    if (result.chemStyle && DOM.chemStyleSelect) {
      DOM.chemStyleSelect.value = result.chemStyle;
    }

    if (result.autoBin !== undefined && DOM.autoBinCheck) {
      DOM.autoBinCheck.checked = result.autoBin;
      toggleManualBinVisibility();
    }

    if (result.manualBin && DOM.manualBinInput) {
      DOM.manualBinInput.value = result.manualBin;
    }

    if (result.maxSnipePrice) {
      if (DOM.maxSnipePriceInput) DOM.maxSnipePriceInput.value = result.maxSnipePrice;
      if (DOM.manualPriceInput) DOM.manualPriceInput.value = result.maxSnipePrice;
    }

    if (result.targetTradepileSize && DOM.targetTradepileSizeInput) {
      DOM.targetTradepileSizeInput.value = result.targetTradepileSize;
    }

    if (result.lazyMarkupPercent && DOM.lazyMarkupPercentInput) {
      DOM.lazyMarkupPercentInput.value = result.lazyMarkupPercent;
    }

    if (result.lazySleepMinutes && DOM.lazySleepMinutesInput) {
      DOM.lazySleepMinutesInput.value = result.lazySleepMinutes;
    }

    if (result.strategyMode) {
      let effectiveStrategy = result.strategyMode;
      if (savedTarget === 'managerLeague' || savedTarget === 'managers') {
        effectiveStrategy = 'lazy';
      } else if (effectiveStrategy === 'lazy' && savedTarget !== 'consumables' && savedTarget !== 'fodder') {
        savedTarget = 'consumables';
        const targetRadio = document.querySelector('input[name="targetMode"][value="consumables"]');
        if (targetRadio) targetRadio.checked = true;
        toggleTargetContainers();
      }
      const targetStrategy = document.querySelector(`input[name="strategyMode"][value="${effectiveStrategy}"]`);
      if (targetStrategy) targetStrategy.checked = true;
      toggleStrategyContainers();
    }

    if (result.minMargin && DOM.minMarginInput) {
      DOM.minMarginInput.value = result.minMargin;
    }

    if (result.start === true) {
      setRunningUiState(true, result.botStartTime || Date.now());
      setStatusBar('text-success', 'In esecuzione', 'Sessione ripristinata');
    } else {
      stopSessionTimer(false);
    }
    if (result.botStatus && typeof result.botStatus === 'object') {
      const bs = result.botStatus;
      if (bs.text || bs.subtext || bs.dotClass) {
        setStatusBar(bs.dotClass || 'text-secondary', bs.text || 'Pronto', bs.subtext || '');
      }
    }
  });
}
