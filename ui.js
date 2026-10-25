import {
  DOM,
  initFormControls,
  flushPendingSettingsSave,
  saveAllCurrentFormSettings,
  setRunningUiState,
  getSelectedTargetMode,
  getSelectedStrategy,
  getSelectedRating,
  getSelectedChemStyle,
  getSelectedManagerNation,
  isAutoBinEnabled,
  getManualBinPrice,
  getMaxSnipePrice,
  getTargetTradepileSize,
  getLazyMarkupPercent,
  getLazySleepMinutes
} from './src/ui/form-controls.js';

import {
  initLogConsoleControls,
  logToScreen,
  setStatusBar
} from './src/ui/log-console.js';

import {
  checkForGithubRelease,
  performNativeUpdate,
  reloadExtensionAndAutoStart,
  getCurrentVersion,
  compareSemver
} from './src/services/updater-service.js';

function initApp() {
  initFormControls();
  initLogConsoleControls(() => ({
    targetMode: getSelectedTargetMode(),
    strategyMode: getSelectedStrategy()
  }));

  // Disabilito il tasto stop all'inizio (verrà riabilitato dal ripristino se start=true)
  DOM.stopBtn?.setAttribute('disabled', 'true');

  DOM.startBtn?.addEventListener('click', () => {
    const selectedTarget = getSelectedTargetMode();
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
        if (DOM.manualPriceInput) DOM.manualPriceInput.focus();
        return;
      }
    }

    const minMargin = DOM.minMarginInput ? (parseInt(DOM.minMarginInput.value) || 200) : 200;
    const targetTradepileSize = getTargetTradepileSize();
    const lazyMarkupPercent = getLazyMarkupPercent();
    const lazySleepMinutes = getLazySleepMinutes();
    const selectedManagerNation = getSelectedManagerNation();

    const now = Date.now();
    const settings = {
      numeroTentativi: DOM.numeroTentativi ? DOM.numeroTentativi.value : '',
      targetMode: selectedTarget,
      fodderMode: selectedTarget === 'fodder',
      fodderRating: selectedRating,
      chemStyle: selectedChemStyle,
      managerNation: selectedManagerNation,
      autoBin: autoBin,
      manualBin: manualBin,
      maxSnipePrice: maxSnipePrice,
      strategyMode: selectedStrategy,
      minMargin: minMargin,
      targetTradepileSize: targetTradepileSize,
      lazyMarkupPercent: lazyMarkupPercent,
      lazySleepMinutes: lazySleepMinutes,
      telegramChatId: DOM.telegramChatIdInput ? DOM.telegramChatIdInput.value.trim() : '',
      botStartTime: now,
      start: true
    };

    const startPayload = {
      tipo: 'START',
      valore: true,
      targetMode: selectedTarget,
      strategyMode: selectedStrategy,
      minMargin: minMargin,
      chemStyle: selectedChemStyle,
      managerNation: selectedManagerNation,
      autoBin: autoBin,
      manualBin: manualBin,
      maxSnipePrice: maxSnipePrice,
      rating: selectedRating,
      targetTradepileSize: targetTradepileSize,
      lazyMarkupPercent: lazyMarkupPercent,
      lazySleepMinutes: lazySleepMinutes
    };

    // Svuota eventuali salvataggi debounced pendenti prima dello START
    const pendingFlushed = flushPendingSettingsSave();
    Object.assign(settings, pendingFlushed);

    // Attende il salvataggio dello storage prima di inviare START al background
    chrome.storage.local.set(settings, () => {
      chrome.runtime.sendMessage(startPayload, () => {
        // Compatibilità: il background può non rispondere (nessun sendResponse)
        if (chrome.runtime.lastError) {
          console.warn('[FC Sniper UI] Nessun acknowledgement dal background:', chrome.runtime.lastError.message);
        }
      });

      // Disabilito i controlli e abilito il tasto stop
      setRunningUiState(true, now);
    });
  });

  DOM.stopBtn?.addEventListener('click', () => {
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

  // Gestione dell'aggiornamento automatico e invisibile
  const updateBadge = document.getElementById('updateBadge');
  const newVersionTag = document.getElementById('newVersionTag');
  const versioneBadge = document.getElementById('versione');
  const currentAppVersion = getCurrentVersion();
  if (versioneBadge) {
    versioneBadge.textContent = `v${currentAppVersion}`;
  }

  const updateModal = document.getElementById('updateModal');
  const modalCurrentVersion = document.getElementById('modalCurrentVersion');
  const modalNewVersion = document.getElementById('modalNewVersion');
  const modalChangelog = document.getElementById('modalChangelog');
  const closeUpdateModalBtn = document.getElementById('closeUpdateModalBtn');
  const cancelUpdateBtn = document.getElementById('cancelUpdateBtn');
  const confirmUpdateBtn = document.getElementById('confirmUpdateBtn');
  const updateProgressContainer = document.getElementById('updateProgressContainer');
  const updateProgressText = document.getElementById('updateProgressText');
  const updateErrorFeedback = document.getElementById('updateErrorFeedback');

  let activeReleaseInfo = null;

  const showUpdateNotification = (info) => {
    if (!info || !info.updateAvailable) {
      if (updateBadge) updateBadge.classList.add('d-none');
      return;
    }
    const currentVer = getCurrentVersion();
    if (compareSemver(info.latestVersion, currentVer) <= 0) {
      if (updateBadge) updateBadge.classList.add('d-none');
      chrome.storage.local.remove(['updateInfo']);
      return;
    }
    activeReleaseInfo = info;
    if (newVersionTag) newVersionTag.textContent = `v${info.latestVersion}`;
    if (updateBadge) {
      updateBadge.classList.remove('d-none');
      updateBadge.setAttribute('title', `Nuova versione v${info.latestVersion} disponibile! Clicca per aggiornare.`);
    }
  };

  const openUpdateModal = () => {
    if (!activeReleaseInfo) return;
    if (modalCurrentVersion) modalCurrentVersion.textContent = `v${activeReleaseInfo.currentVersion}`;
    if (modalNewVersion) modalNewVersion.textContent = `v${activeReleaseInfo.latestVersion}`;
    if (modalChangelog) {
      modalChangelog.textContent = activeReleaseInfo.releaseNotes || 'Nessuna nota di rilascio allegata a questa release.';
    }
    if (updateProgressContainer) updateProgressContainer.classList.add('d-none');
    if (updateErrorFeedback) updateErrorFeedback.classList.add('d-none');
    if (confirmUpdateBtn) {
      confirmUpdateBtn.removeAttribute('disabled');
      confirmUpdateBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Installa e Ricarica
      `;
    }
    if (updateModal) updateModal.classList.remove('d-none');
  };

  const closeUpdateModal = () => {
    if (updateModal) updateModal.classList.add('d-none');
  };

  updateBadge?.addEventListener('click', openUpdateModal);
  closeUpdateModalBtn?.addEventListener('click', closeUpdateModal);
  cancelUpdateBtn?.addEventListener('click', closeUpdateModal);

  updateModal?.addEventListener('click', (e) => {
    if (e.target === updateModal) closeUpdateModal();
  });

  confirmUpdateBtn?.addEventListener('click', async () => {
    if (!activeReleaseInfo || !activeReleaseInfo.zipUrl) return;

    // Salvataggio immediato e forzato di tutte le impostazioni correnti della UI
    saveAllCurrentFormSettings();

    confirmUpdateBtn.setAttribute('disabled', 'true');
    cancelUpdateBtn?.setAttribute('disabled', 'true');
    closeUpdateModalBtn?.setAttribute('disabled', 'true');

    if (updateProgressContainer) updateProgressContainer.classList.remove('d-none');
    if (updateErrorFeedback) updateErrorFeedback.classList.add('d-none');
    if (updateProgressText) {
      updateProgressText.className = 'update-status-msg text-info font-monospace';
      updateProgressText.textContent = 'Download e sostituzione file in corso via Native Updater...';
    }

    logToScreen(`[AGGIORNAMENTO] Avvio download release ${activeReleaseInfo.tag || activeReleaseInfo.latestVersion}...`);

    try {
      const result = await performNativeUpdate(activeReleaseInfo.zipUrl, activeReleaseInfo.tag);
      logToScreen(`[AGGIORNAMENTO] ${result.message || 'File aggiornati con successo!'}`);

      if (updateProgressText) {
        updateProgressText.className = 'update-status-msg text-success font-monospace';
        updateProgressText.textContent = 'Aggiornamento completato! Ricaricamento estensione...';
      }

      setTimeout(() => {
        reloadExtensionAndAutoStart(activeReleaseInfo.latestVersion);
      }, 1000);
    } catch (err) {
      console.error('[Update Error]', err);
      logToScreen(`[ERRORE AGGIORNAMENTO] ${err.message || err}`);
      if (updateProgressContainer) updateProgressContainer.classList.add('d-none');
      if (updateErrorFeedback) {
        updateErrorFeedback.classList.remove('d-none');
        const rawMsg = err.message || String(err);
        if (rawMsg.includes('Specified native messaging host not found') || rawMsg.includes('Native host not found')) {
          updateErrorFeedback.innerHTML = `
            <div style="font-size: 0.85rem; line-height: 1.4; color: #ff6b6b; margin-top: 6px;">
              <strong>⚠️ Auto-Updater non ancora abilitato su Windows:</strong><br>
              Per abilitare gli aggiornamenti automatici futuri, fai semplicemente <strong>doppio clic sul file <code>setup_windows.bat</code></strong> presente nella cartella del bot.<br>
              <div style="margin-top: 8px;">
                <a href="${activeReleaseInfo?.zipUrl || '#'}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-info btn-xs" style="text-decoration: none; padding: 4px 10px; font-size: 0.8rem; border-radius: 4px; border: 1px solid #00d2ff; color: #00d2ff; display: inline-block;">
                  📥 Scarica ZIP manualmente (${activeReleaseInfo?.tag || activeReleaseInfo?.latestVersion || 'Release'})
                </a>
              </div>
            </div>
          `;
        } else {
          updateErrorFeedback.textContent = `Errore durante l'aggiornamento: ${rawMsg}`;
        }
      }
      confirmUpdateBtn.removeAttribute('disabled');
      cancelUpdateBtn?.removeAttribute('disabled');
      closeUpdateModalBtn?.removeAttribute('disabled');
    }
  });

  // Esposizione per test manuale e diagnostica da console DevTools
  window.fcSniperUpdater = {
    checkNativeHost: () => {
      return new Promise((resolve, reject) => {
        if (!chrome.runtime?.sendNativeMessage) {
          const err = 'chrome.runtime.sendNativeMessage non disponibile';
          console.error(err);
          return reject(err);
        }
        chrome.runtime.sendNativeMessage('com.fc26sniper.updater', { action: 'PING' }, (res) => {
          if (chrome.runtime.lastError) {
            console.error('[Native Host Error]:', chrome.runtime.lastError.message);
            return reject(chrome.runtime.lastError.message);
          }
          console.log('[Native Host OK]:', res);
          resolve(res);
        });
      });
    },
    simulateUpdateAlert: (fakeVersion = '2.8.5', notes = 'Miglioramenti UI Bento Grid e ottimizzazioni performance.') => {
      showUpdateNotification({
        updateAvailable: true,
        currentVersion: getCurrentVersion(),
        latestVersion: fakeVersion,
        tag: `v${fakeVersion}`,
        releaseNotes: notes,
        zipUrl: `https://github.com/Muelsa/FC26Sniper/archive/refs/tags/v${fakeVersion}.zip`
      });
      console.log(`[Updater Test] Badge aggiornamento per v${fakeVersion} attivato.`);
    },
    openModal: () => openUpdateModal(),
    testLog: (text = 'Test log di verifica UI') => {
      logToScreen(text);
    }
  };

  // Ripristino o controllo silente iniziale
  chrome.storage?.local.get(['updateInfo', 'pendingPostUpdateReopen', 'pendingAutoStartAfterUpdate', 'updatedVersion'], (res) => {
    // 1. Notifica eventuale release salvata
    if (res?.updateInfo?.updateAvailable) {
      showUpdateNotification(res.updateInfo);
    }

    // 2. Controllo se questo avvio è il risultato di un aggiornamento appena completato
    if (res?.pendingPostUpdateReopen || res?.pendingAutoStartAfterUpdate) {
      chrome.storage.local.remove(['pendingPostUpdateReopen', 'pendingAutoStartAfterUpdate']);
      const verText = res.updatedVersion ? `v${res.updatedVersion}` : '';
      logToScreen(`[AGGIORNAMENTO] 🎉 Bot aggiornato con successo a ${verText}! Seleziona una modalità e premi Avvia quando desideri.`);
      setStatusBar('text-success', 'Aggiornato', `Pronto (${verText})`);
    }
  });

  // Controllo attivo GitHub all'avvio
  checkForGithubRelease().then((info) => {
    if (info && info.updateAvailable) {
      showUpdateNotification(info);
    }
  });

  // Controllo automatico periodico ogni 3 ore (10800000 ms)
  setInterval(() => {
    checkForGithubRelease().then((info) => {
      if (info && info.updateAvailable) {
        showUpdateNotification(info);
      }
    });
  }, 3 * 60 * 60 * 1000);

  // Unico listener runtime.onMessage con dispatch per tipo di messaggio
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.tipo) return;
    console.log('[UI Messaggio Ricevuto]:', message.tipo, message);

    switch (message.tipo) {
      case 'UPDATE_AVAILABLE':
        if (message.info) {
          showUpdateNotification(message.info);
        }
        break;
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
        if (DOM.tentativiRimasti) {
          DOM.tentativiRimasti.textContent = message.valore !== "" ? String(message.valore) : "-";
        }
        break;

      case 'CARTA_ACQUISTATA':
        if (DOM.carteAcquistate) {
          DOM.carteAcquistate.textContent = message.valore !== "" ? String(message.valore) : "0";
        }
        break;

      case 'CARTA_VENDUTA':
        if (DOM.carteVendute) {
          DOM.carteVendute.textContent = message.valore !== "" ? String(message.valore) : "0";
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
        if (DOM.crediti) {
          DOM.crediti.textContent = typeof message.valore === 'number'
            ? message.valore.toLocaleString('it-IT')
            : (message.valore ? String(message.valore) : 'N/D');
        }
        break;

      case 'PROIEZIONE_CREDITI':
        if (DOM.proiezioneCrediti) {
          DOM.proiezioneCrediti.textContent = message.valore !== "" ? String(message.valore) : "-";
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
