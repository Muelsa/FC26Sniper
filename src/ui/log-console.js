// Gestione della console log interattiva, barra di stato, filtri ed esportazione txt (Fase 6 Refactor)

let currentFilter = 'all';
let currentSearchQuery = '';
let totalLogEvents = 0;
const MAX_LOG_RECORDS = 1000;
const allLogRecords = [];

let lastLoggedText = '';
let lastLoggedTag = '';
let lastLoggedTime = 0;
let lastLoggedCount = 1;
let lastLogRowElement = null;
let lastRecordRef = null;

export function setStatusBar(dotClass, text, subtext) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusSubtext = document.getElementById('statusSubtext');
  if (statusDot) statusDot.className = dotClass;
  if (statusText) statusText.textContent = text;
  if (statusSubtext) statusSubtext.textContent = subtext;
}

export function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

function rowMatchesFilter(cat, rowText) {
  let catMatch = false;
  if (currentFilter === 'all') {
    catMatch = true;
  } else if (currentFilter === 'trade' && (cat === 'trade' || cat === 'bid' || cat === 'outbid')) {
    catMatch = true;
  } else if (currentFilter === 'sleep' && (cat === 'sleep' || cat === 'status')) {
    catMatch = true;
  } else if (currentFilter === 'warn' && (cat === 'warn' || cat === 'outbid')) {
    catMatch = true;
  }
  if (!catMatch) return false;
  if (!currentSearchQuery) return true;
  return String(rowText || '').toLowerCase().includes(currentSearchQuery);
}

export function applyLogFilter() {
  const rows = document.querySelectorAll('#logConsole .log-row');
  rows.forEach(r => {
    const cat = r.dataset.category;
    r.style.display = rowMatchesFilter(cat, r.textContent) ? '' : 'none';
  });
  const logConsole = document.getElementById('logConsole');
  if (logConsole && isScrolledToBottom(logConsole)) {
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

export function stripLeadingBrackets(str) {
  let s = String(str || '').trim();
  while (/^\[[^\]]+\]\s*/.test(s)) {
    s = s.replace(/^\[[^\]]+\]\s*/, '').trim();
  }
  return s;
}

export function classifyLogMessage(raw) {
  const text = String(raw || '').trim();
  const clean = stripLeadingBrackets(text);

  // 1. Aste Superate, Perse o Abbandonate
  if (!/^\[CONTRORILANCIO\]/i.test(text) && (/superata|superato|asta persa|non vinta|abbandon/i.test(text) || /^\[ASTA SUPERATA\]/i.test(text))) {
    let tag = 'SUPERATA';
    if (/persa|non vinta/i.test(text)) tag = 'ASTA PERSA';
    else if (/abbandon/i.test(text) && !/superat/i.test(text)) tag = 'ABBANDONO';
    return { category: 'outbid', tag, text: clean };
  }

  // 2. Trades: Acquisti e Vendite
  if (/acquisto|acquistata|acquistate|vinta|vendita|listata|listato/i.test(text) && !/errore|persa|non vinta/i.test(text)) {
    let tag = 'ACQUISTO';
    if (/vendita|listat/i.test(text) && !/acquist/i.test(text)) tag = 'VENDITA';
    else if (/vinta/i.test(text)) tag = 'VINTA';
    return { category: 'trade', tag, text: clean };
  }

  // 3. Offerte / Bidding & Controrilanci
  if (/offerta|bid|bidding|controrilancio|rilancio/i.test(text) && !/errore|terminat|abbandon/i.test(text)) {
    let tag = 'OFFERTA';
    if (/controrilancio|rilancio/i.test(text)) tag = 'RILANCIO';
    return { category: 'bid', tag, text: clean };
  }

  // 4. Pause / Sleep / Heartbeat
  if (/pausa|dormiente|heartbeat|cool\s*down|attesa|attendo/i.test(text)) {
    return { category: 'sleep', tag: 'PAUSA', text: clean };
  }

  // 5. Avvisi ed Errori / 461 / Captcha / Limiti
  if (/errore|461|401|429|458|captcha|soft-ban|fallit|attenzione/i.test(text)) {
    let tag = 'AVVISO';
    if (/461/i.test(text)) tag = '461 PRESA';
    else if (/captcha|458/i.test(text)) tag = 'CAPTCHA';
    else if (/401/i.test(text)) tag = 'AUTH 401';
    else if (/soft-ban|429/i.test(text)) tag = 'RATE LIMIT';
    return { category: 'warn', tag, text: clean };
  }

  // 6. Telemetria PIN
  if (/pin\s*telemetry|telemetr/i.test(text)) {
    return { category: 'status', tag: 'TELEMETRIA', text: clean };
  }

  // 7. Stato, Target, Configurazione e Cicli
  if (/avvio|ciclo|fase|target|progresso|lotto|completat|pronto|inizializz|terminat|filtro|riconciliazione|tradepile/i.test(text)) {
    return { category: 'status', tag: 'STATO', text: clean };
  }

  // 8. Generico Info
  return { category: 'info', tag: 'INFO', text: clean };
}

export function updateBotStatusBar(category, tag, text) {
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

export function logToScreen(message) {
  if (!message) return;
  const logConsole = document.getElementById('logConsole');
  const logCount = document.getElementById('logCount');
  if (!logConsole) return;

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  const { category, tag, text } = classifyLogMessage(message);

  if (text && text === lastLoggedText && tag === lastLoggedTag && (now.getTime() - lastLoggedTime < 5000)) {
    lastLoggedCount++;
    const countSuffix = ` (x${lastLoggedCount})`;
    if (lastLogRowElement) {
      const msgSpan = lastLogRowElement.querySelector('.log-msg');
      if (msgSpan) msgSpan.textContent = text + countSuffix;
    }
    if (lastRecordRef) {
      lastRecordRef.text = text + countSuffix;
    }
    return;
  }

  lastLoggedText = text;
  lastLoggedTag = tag;
  lastLoggedTime = now.getTime();
  lastLoggedCount = 1;

  const record = {
    timestamp: timeStr,
    iso: now.toISOString(),
    category,
    tag,
    text,
    raw: String(message || '').trim()
  };
  lastRecordRef = record;
  allLogRecords.push(record);
  if (allLogRecords.length > MAX_LOG_RECORDS) {
    allLogRecords.splice(0, allLogRecords.length - MAX_LOG_RECORDS);
  }

  updateBotStatusBar(category, tag, text);

  const wasAtBottom = isScrolledToBottom(logConsole);

  const row = document.createElement('div');
  row.className = `log-row filter-${category}`;
  row.dataset.category = category;
  lastLogRowElement = row;

  if (!rowMatchesFilter(category, `${timeStr} ${tag} ${text}`)) {
    row.style.display = 'none';
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

  while (logConsole.childElementCount > 250) {
    logConsole.removeChild(logConsole.firstElementChild);
  }

  if (wasAtBottom) {
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

export function initLogConsoleControls(getContextInfo = () => ({})) {
  const filterBtns = document.querySelectorAll('#logFilterGroup button');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active', 'text-white'));
      btn.classList.add('active', 'text-white');
      currentFilter = btn.dataset.filter || 'all';
      applyLogFilter();
    });
  });

  const searchInput = document.getElementById('logSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      currentSearchQuery = searchInput.value.trim().toLowerCase();
      applyLogFilter();
    });
  }

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

  const downloadBtn = document.getElementById('downloadLogBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

      const info = getContextInfo() || {};
      const verText = document.getElementById('versione')?.textContent?.trim() || 'v2.8.1';
      const targetMode = info.targetMode || 'N/D';
      const strategyMode = info.strategyMode || 'N/D';
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
          content += `[${r.timestamp}] [${r.tag}] ${r.text || r.raw}\n`;
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
}
