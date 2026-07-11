// popup.js — Логика попапа (Editorial Glass редизайн)
'use strict';

const profileUrlInput = document.getElementById('profileUrl');
const btnCollect = document.getElementById('btnCollect');
const btnTest = document.getElementById('btnTest');
const btnStop = document.getElementById('btnStop');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const modePill = document.getElementById('modePill');
const heroDelta = document.getElementById('heroDelta');
const statLast = document.getElementById('statLast');
const statTotal = document.getElementById('statTotal');
const statAvg = document.getElementById('statAvg');
const statCount = document.getElementById('statCount');
const statStreak = document.getElementById('statStreak');
const btnHistory = document.getElementById('btnHistory');
const btnClear = document.getElementById('btnClear');
const btnTheme = document.getElementById('btnTheme');
const historyList = document.getElementById('historyList');
const historyCount = document.getElementById('historyCount');
const sparkLine = document.getElementById('spark-line');
const sparkFill = document.getElementById('spark-fill');

const schedBox = document.getElementById('schedBox');
const schedEnabled = document.getElementById('schedEnabled');
const schedHour = document.getElementById('schedHour');
const schedMinute = document.getElementById('schedMinute');
const schedNext = document.getElementById('schedNext');

let isProcessing = false;

// ─── Локализация ────────────────────────────────────────────────────────────

// Сообщение из _locales/*/messages.json (фоллбэк — сам ключ, чтобы пропуск был виден).
function t(key, subs) {
  const msg = chrome.i18n.getMessage(key, subs);
  return msg || key;
}

// Локаль интерфейса браузера — для форматирования дат и чисел.
const UI_LOCALE = chrome.i18n.getUILanguage() || 'en';

// Подставляет переводы в статическую разметку (узлы с data-i18n / data-i18n-title).
function localizeHtml() {
  document.documentElement.lang = UI_LOCALE.split('-')[0];
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const text = t(el.dataset.i18nTitle);
    el.title = text;
    el.setAttribute('aria-label', text);
  }
}
localizeHtml();

// ─── Тема ───────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.body && document.body.setAttribute('data-theme', t);
}

async function initTheme() {
  const data = await chrome.storage.sync.get('theme');
  applyTheme(data.theme || 'dark');
}

if (btnTheme) {
  btnTheme.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.sync.set({ theme: next });
  });
}

// ─── Инициализация ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();
  const data = await chrome.storage.sync.get('profileUrl');
  if (data.profileUrl) {
    profileUrlInput.value = data.profileUrl;
  }
  await updateStats();

  // Загружаем настройки расписания
  await initSchedule();

  // Если процесс уже идёт (попап открыли повторно во время фоновой работы) —
  // показываем «Стоп» и блокируем запуск.
  let running = false;
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getRunningState' });
    running = Boolean(state && state.isRunning);
    if (running) setProcessing(true);
  } catch (e) { /* worker мог спать — значит процесс не идёт */ }

  // Восстанавливаем последний статус: пока попап был закрыт, сообщения
  // statusUpdate терялись. Показываем сохранённый, если процесс идёт или
  // статус свежий (последние 10 минут).
  try {
    const stored = await chrome.storage.local.get('lastStatus');
    const last = stored.lastStatus;
    if (last && (running || Date.now() - last.at < 10 * 60 * 1000)) {
      setStatus(last.text, last.status);
    }
  } catch (e) { /* не критично */ }
});

// ─── Сохранение URL при изменении ───────────────────────────────────────────

profileUrlInput.addEventListener('change', persistUrl);
profileUrlInput.addEventListener('blur', persistUrl);

function persistUrl() {
  const url = profileUrlInput.value.trim();
  if (url) chrome.storage.sync.set({ profileUrl: url });
}

// ─── Автоопределение профиля ────────────────────────────────────────────────
// Актуальный аккаунт = залогиненная сейчас сессия, поэтому ссылку не просим
// копировать руками: background определяет её по редиректу steamcommunity.com/my/
// (фоллбэк — STEAMID со страницы godota2.com). Если нигде не залогинен,
// открываем steamcommunity.com/my/ — после входа достаточно нажать ещё раз.

const btnDetect = document.getElementById('btnDetect');

btnDetect.addEventListener('click', async () => {
  btnDetect.disabled = true;
  setStatus(t('statusDetecting'), 'progress');

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ action: 'detectProfileUrl' });
  } catch (e) { /* worker недоступен — обработаем как неудачу */ }

  btnDetect.disabled = false;

  if (res && res.success) {
    profileUrlInput.value = res.url;
    chrome.storage.sync.set({ profileUrl: res.url });
    setStatus(t('statusDetected'), 'success');
    return;
  }

  setStatus(t('errDetectFailed'), 'error');
  // Даём прочитать подсказку, затем открываем Steam для входа
  // (создание вкладки закрывает попап, поэтому не сразу).
  setTimeout(() => {
    chrome.tabs.create({ url: 'https://steamcommunity.com/my/' });
  }, 1800);
});

// ─── Расписание автосбора ────────────────────────────────────────────────────

async function initSchedule() {
  const sched = await chrome.runtime.sendMessage({ action: 'getSchedule' });
  if (!sched) return;

  schedEnabled.checked = sched.enabled;
  schedHour.value = pad2(sched.hour);
  schedMinute.value = pad2(sched.minute);
  reflectScheduleUI(sched.enabled);
  updateNextRunLabel(sched.nextRun);

  schedEnabled.addEventListener('change', saveSchedule);
  schedHour.addEventListener('change', saveSchedule);
  schedMinute.addEventListener('change', saveSchedule);
}

function reflectScheduleUI(enabled) {
  schedBox.classList.toggle('on', enabled);
}

async function saveSchedule() {
  const enabled = schedEnabled.checked;
  let hour = clampInt(schedHour.value, 0, 23, 4);
  let minute = clampInt(schedMinute.value, 0, 59, 0);

  // Нормализуем отображение
  schedHour.value = pad2(hour);
  schedMinute.value = pad2(minute);
  reflectScheduleUI(enabled);

  const res = await chrome.runtime.sendMessage({
    action: 'updateSchedule',
    schedule: { enabled, hour, minute }
  });

  updateNextRunLabel(res && res.nextRun);

  setStatus(enabled ? t('statusSchedOn') : t('statusSchedOff'), 'info');
}

function updateNextRunLabel(nextRun) {
  if (!schedEnabled.checked) {
    schedNext.textContent = '';
    return;
  }
  if (nextRun) {
    const d = new Date(nextRun);
    schedNext.textContent = '→ ' + d.toLocaleString(UI_LOCALE, {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ─── Кнопки ─────────────────────────────────────────────────────────────────

btnCollect.addEventListener('click', async () => {
  const profileUrl = profileUrlInput.value.trim();
  if (!profileUrl) {
    setStatus(t('errEnterProfileUrl'), 'error');
    return;
  }
  if (!profileUrl.includes('steamcommunity.com')) {
    setStatus(t('errInvalidProfileUrl'), 'error');
    return;
  }

  chrome.storage.sync.set({ profileUrl });

  setProcessing(true);
  setStatus(t('statusStartingFull'), 'progress');
  await runProcess({ action: 'startFullProcess', profileUrl });
});

btnTest.addEventListener('click', async () => {
  setProcessing(true);
  setStatus(t('statusTestRun'), 'progress');
  await runProcess({ action: 'collectBonusOnly' });
});

async function runProcess(message) {
  let response = null;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (e) {
    // Канал оборвался (например, worker перезапустился) — финальное состояние
    // придёт сообщением runState, кнопки разблокирует его обработчик.
  }

  if (response) {
    setProcessing(false);
    await updateStats();
    setStatus(response.message, response.success ? 'success' : 'error');
  }
}

btnHistory.addEventListener('click', () => {
  historyList.classList.toggle('visible');
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  setStatus(t('statusStoppingShort'), 'progress');
  try {
    await chrome.runtime.sendMessage({ action: 'stopProcess' });
  } catch (e) { /* ignore */ }
});

// Двухшаговое подтверждение вместо confirm(): нативные диалоги в попапах
// расширений Chrome ненадёжны (могут молча возвращать false).
let clearArmTimer = null;

function disarmClear() {
  if (clearArmTimer) clearTimeout(clearArmTimer);
  clearArmTimer = null;
  btnClear.classList.remove('armed');
  btnClear.querySelector('span').textContent = t('btnClearLabel');
}

btnClear.addEventListener('click', async () => {
  if (!btnClear.classList.contains('armed')) {
    btnClear.classList.add('armed');
    btnClear.querySelector('span').textContent = t('btnClearConfirm');
    clearArmTimer = setTimeout(disarmClear, 3000);
    return;
  }

  disarmClear();
  await chrome.runtime.sendMessage({ action: 'clearHistory' });
  await updateStats();
  historyList.innerHTML = '';
  historyList.classList.remove('visible');
  setStatus(t('statusHistoryCleared'), 'info');
});

// ─── Диагностика баланса ─────────────────────────────────────────────────────

const btnDiag = document.getElementById('btnDiag');
const diagList = document.getElementById('diagList');

if (btnDiag) {
  btnDiag.addEventListener('click', async () => {
    const visible = diagList.style.display !== 'none';
    if (visible) { diagList.style.display = 'none'; return; }

    const diag = await chrome.runtime.sendMessage({ action: 'getDiagnostic' });
    diagList.style.display = 'block';

    if (!diag) {
      diagList.textContent = t('diagEmpty');
      return;
    }

    const esc = s => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const when = new Date(diag.at).toLocaleString(UI_LOCALE);

    let html = '';
    html += `<div style="color:var(--text);margin-bottom:6px;">${esc(t('diagSnapshot'))}: ${esc(when)}</div>`;
    html += `<div>getBalance(): <b style="color:var(--accent)">${esc(diag.currentGetBalance)}</b></div>`;
    html += `<div>${esc(t('diagBalanceFound'))}: ${diag.balanceElementFound ? esc(t('wordYes')) : esc(t('wordNo'))}</div>`;
    html += `<div style="margin-top:6px;color:var(--text);">${esc(t('diagCandidates'))}</div>`;

    const cands = (diag.candidates || []).filter(c => c.visible);
    if (!cands.length) {
      html += `<div>${esc(t('diagNothing'))}</div>`;
    } else {
      for (const c of cands.slice(0, 20)) {
        html += `<div style="padding:3px 0;border-bottom:1px solid var(--line);">`;
        html += `<span style="color:var(--accent)">${esc(c.parsed)}</span> · "${esc(c.text)}"<br>`;
        html += `<span style="color:var(--dim)">${esc(c.selector)}</span>`;
        html += `</div>`;
      }
    }

    if (diag.winPopup && diag.winPopup.length) {
      html += `<div style="margin-top:6px;color:var(--text);">${esc(t('diagWinPopup'))}</div>`;
      for (const w of diag.winPopup) {
        html += `<div>"${esc(w.text)}" — <span style="color:var(--dim)">${esc(w.selector)}</span></div>`;
      }
    }

    diagList.innerHTML = html;
  });
}

// ─── Обновление статуса из background ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'statusUpdate') {
    setStatus(message.text, message.status);
  }

  // Финал процесса для переоткрытого попапа: его исходный await потерян,
  // поэтому кнопки разблокируем по этому сигналу.
  if (message.type === 'runState') {
    setProcessing(message.isRunning);
    if (!message.isRunning) updateStats();
  }
});

// ─── Статус ─────────────────────────────────────────────────────────────────

function setStatus(text, status = 'info') {
  statusText.textContent = stripEmoji(text);
  statusBox.dataset.status = status;
  if (modePill) {
    if (status === 'progress') {
      modePill.textContent = t('pillWorking');
    } else if (status === 'error') {
      modePill.textContent = t('pillError');
    } else if (status === 'success') {
      modePill.textContent = t('pillDone');
    } else {
      modePill.textContent = t('pillOnline');
    }
  }
}

// Очистка эмодзи из сообщений background — дизайн полагается на иконку статуса
function stripEmoji(text) {
  if (!text) return '';
  // Один широкий диапазон: пиктограммы, стрелки/часы (⏱⏳), знаки (ℹ️✅❌)
  // и variation selector, который иначе остаётся «хвостом» после эмодзи.
  return String(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2100}-\u{2BFF}\u{FE0F}]/gu, '')
    .trim();
}

function setProcessing(processing) {
  isProcessing = processing;
  btnCollect.disabled = processing;
  btnTest.disabled = processing;
  // Во время процесса прячем обычные кнопки действий и показываем «Стоп»
  btnStop.style.display = processing ? 'flex' : 'none';
  if (processing) btnStop.disabled = false;
}

// ─── Stats / sparkline ──────────────────────────────────────────────────────

async function updateStats() {
  const stats = await chrome.runtime.sendMessage({ action: 'getStats' });
  if (!stats) return;

  statTotal.textContent = formatNumber(stats.total);
  statCount.textContent = stats.count;
  statAvg.textContent = stats.avg;

  // Hero delta
  if (stats.last && stats.last.status === 'claimed' && stats.last.delta > 0) {
    statLast.textContent = '+' + stats.last.delta;
    heroDelta.className = 'hero-delta';
    heroDelta.style.display = '';
  } else if (stats.last && stats.last.status === 'uncertain') {
    statLast.textContent = stats.last.delta !== null ? String(stats.last.delta) : '?';
    heroDelta.className = 'hero-delta uncertain';
    heroDelta.style.display = '';
  } else if (stats.last && stats.last.status === 'already_collected') {
    statLast.textContent = t('labelCollected');
    heroDelta.className = 'hero-delta neutral';
    heroDelta.style.display = '';
  } else {
    heroDelta.style.display = 'none';
  }

  // Streak — кол-во последних подряд claimed
  const history = stats.history || [];
  let streak = 0;
  for (const entry of history) {
    if (entry.status === 'claimed' && entry.delta > 0) streak++;
    else break;
  }
  statStreak.textContent = streak;

  // Sparkline
  renderSparkline(history);

  // History count + list
  historyCount.textContent = history.length ? `· ${history.length}` : '';
  renderHistory(history);
}

function formatNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString(UI_LOCALE);
}

function renderSparkline(history) {
  // Use balanceAfter values, oldest → newest
  const values = history
    .slice()
    .reverse()
    .map(h => (h.balanceAfter != null ? h.balanceAfter : null))
    .filter(v => v != null);

  if (values.length < 2) {
    sparkLine.setAttribute('d', '');
    sparkFill.setAttribute('d', '');
    return;
  }

  const W = 284;
  const H = 32;
  const PAD = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (W - PAD * 2) / (values.length - 1);

  let line = '';
  values.forEach((v, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / span);
    line += (i === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  });

  const lastX = PAD + (values.length - 1) * stepX;
  const fill = line + `L ${lastX.toFixed(2)} ${H} L ${PAD} ${H} Z`;

  sparkLine.setAttribute('d', line.trim());
  sparkFill.setAttribute('d', fill);
}

function renderHistory(history) {
  if (!history.length) {
    historyList.innerHTML = `<div class="history-empty">${t('historyEmpty')}</div>`;
    return;
  }

  historyList.innerHTML = history.map(entry => {
    const date = new Date(entry.timestamp);
    const dateStr = date.toLocaleDateString(UI_LOCALE, {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });

    const before = entry.balanceBefore !== null ? entry.balanceBefore : '?';
    const after = entry.balanceAfter !== null ? entry.balanceAfter : '?';

    let deltaClass = 'neutral';
    let deltaText = '—';
    if (entry.delta !== null && entry.delta !== undefined) {
      if (entry.status === 'claimed' && entry.delta > 0) {
        deltaClass = 'positive';
        deltaText = '+' + entry.delta;
      } else if (entry.status === 'uncertain') {
        deltaClass = 'uncertain';
        deltaText = entry.delta > 0 ? '+' + entry.delta : String(entry.delta);
      } else {
        deltaText = String(entry.delta);
      }
    }

    return `
      <div class="history-item">
        <div class="history-meta">
          <span class="history-date">${dateStr}</span>
          <span class="history-balance">${before} → ${after}</span>
        </div>
        <span class="history-delta ${deltaClass}">${deltaText}</span>
      </div>
    `;
  }).join('');
}
