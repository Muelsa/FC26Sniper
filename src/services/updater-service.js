// Servizio di Rilevamento Release GitHub e Auto-Aggiornamento Invisibile
const GITHUB_REPO = 'Muelsa/FC26Sniper';
const NATIVE_HOST_NAME = 'com.fc26sniper.updater';

/**
 * Confronta due stringhe di versione SemVer (es. "2.8.1" e "2.8.0")
 * @returns {number} 1 se v1 > v2, -1 se v1 < v2, 0 se v1 == v2
 */
export function compareSemver(v1, v2) {
  if (!v1 || !v2) return 0;
  const clean1 = String(v1).trim().replace(/^v/i, '');
  const clean2 = String(v2).trim().replace(/^v/i, '');

  const parts1 = clean1.split('.').map(n => parseInt(n, 10) || 0);
  const parts2 = clean2.split('.').map(n => parseInt(n, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Ottiene la versione corrente dell'estensione dal Manifest
 */
export function getCurrentVersion() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
    try {
<<<<<<< Updated upstream
      return chrome.runtime.getManifest().version || '2.8.3';
    } catch (_) {}
  }
  return '2.8.3';
=======
      return chrome.runtime.getManifest().version || '2.8.4';
    } catch (_) {}
  }
  return '2.8.4';
>>>>>>> Stashed changes
}

/**
 * Controlla se è presente una nuova release su GitHub
 */
export async function checkForGithubRelease() {
  const currentVersion = getCurrentVersion();
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!res.ok) {
      if (res.status === 404) {
        console.log('[Updater] Nessuna release pubblica trovata sul repository.');
        return { updateAvailable: false, currentVersion, error: 'Releases not found (404)' };
      }
      throw new Error(`GitHub API HTTP ${res.status}`);
    }

    const data = await res.json();
    const rawTag = data.tag_name || '';
    const latestVersion = rawTag.replace(/^v/i, '');

    const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
    const zipUrl = data.zipball_url || `https://github.com/${GITHUB_REPO}/archive/refs/tags/${rawTag}.zip`;

    const info = {
      updateAvailable,
      currentVersion,
      latestVersion,
      tag: rawTag,
      releaseName: data.name || rawTag,
      releaseNotes: data.body || '',
      publishedAt: data.published_at || '',
      zipUrl,
      htmlUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases`
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ lastUpdateCheck: Date.now(), updateInfo: info });
    }

    return info;
  } catch (err) {
    console.warn('[Updater] Errore verifica aggiornamenti GitHub:', err.message);
    return { updateAvailable: false, currentVersion, error: err.message };
  }
}

/**
 * Esegue il download e la sostituzione dei file tramite Chrome Native Messaging
 * (Invisibile in background su macOS, Linux e Windows)
 */
export function performNativeUpdate(zipUrl, tag) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendNativeMessage) {
      return reject(new Error('API chrome.runtime.sendNativeMessage non disponibile.'));
    }

    console.log(`[Updater Client] Invio comando nativo UPDATE per ${tag}...`);
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'UPDATE', zipUrl, tag },
      (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || 'Errore Native Messaging';
          console.error('[Updater Client] Errore Native Host:', errMsg);
          return reject(new Error(errMsg));
        }

        if (response && response.success) {
          console.log('[Updater Client] Aggiornamento nativo completato:', response);
          resolve(response);
        } else {
          const err = response?.error || 'Operazione di aggiornamento non riuscita';
          reject(new Error(err));
        }
      }
    );
  });
}

/**
 * Ricarica a caldo l'estensione Chrome e predispone la riapertura della Dashboard
 */
export function reloadExtensionAndAutoStart(newVersion) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.reload) {
    window.location.reload();
    return;
  }

  // Rimuoviamo il vecchio updateInfo per evitare badge residui al riavvio
  chrome.storage?.local.remove(['updateInfo']);
  chrome.storage.local.set({
    pendingPostUpdateReopen: true,
    pendingAutoStartAfterUpdate: false,
    updatedVersion: newVersion || '',
    updatedAt: Date.now()
  }, () => {
    console.log('[Updater Client] Ricaricamento estensione con chrome.runtime.reload()...');
    chrome.runtime.reload();
  });
}
