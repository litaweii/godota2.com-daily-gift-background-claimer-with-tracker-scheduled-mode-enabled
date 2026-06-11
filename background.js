// background.js — Service Worker (оркестрация процесса)
'use strict';

const MARKER = ' godota2.com';
const MAX_HISTORY = 100;

// Общий таймаут всего процесса (watchdog). Если за это время процесс не
// завершился — считаем, что завис, и прерываем с попыткой отката ника.
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут

let isRunning = false;
let originalNickname = null;
let steamTabId = null;
let godotaTabId = null;

// Управление отменой/таймаутом текущего процесса.
let cancelRequested = false;
let cancelReason = null;
let watchdogTimer = null;

// Выделенное окно автоматизации и окно пользователя.
// Вкладки в окне автоматизации держим АКТИВНЫМИ — тогда visibilityState ===
// 'visible', и Chrome не тротлит их таймеры/анимации, даже когда пользователь
// параллельно работает в своём окне.
let automationWindowId = null;
let userWindowId = null;

// ─── Утилиты ────────────────────────────────────────────────────────────────

// Локализованное сообщение по ключу из _locales/*/messages.json.
// Фоллбэк на сам ключ — чтобы пропущенный перевод был виден, а не пустым.
function t(key, subs) {
  const msg = chrome.i18n.getMessage(key, subs);
  return msg || key;
}

function sleep(ms) {
  // Прерываемый sleep: просыпается раньше, если запрошена отмена, чтобы процесс
  // не «досыпал» длинные паузы после нажатия «Стоп».
  return new Promise(resolve => {
    const step = 200;
    let elapsed = 0;
    const tick = () => {
      if (cancelRequested || elapsed >= ms) return resolve();
      elapsed += step;
      setTimeout(tick, Math.min(step, ms - elapsed + step));
    };
    if (ms <= 0) return resolve();
    setTimeout(tick, Math.min(step, ms));
  });
}

// Ошибка отмены — отличаем её от обычных ошибок, чтобы не дублировать статусы.
class CancelError extends Error {
  constructor(message) {
    super(message || t('errProcessStopped'));
    this.name = 'CancelError';
    this.isCancel = true;
  }
}

// Бросает CancelError, если запрошена отмена. Вставляется в ключевые точки.
function throwIfCancelled() {
  if (cancelRequested) {
    throw new CancelError(cancelReason || t('errStoppedByUser'));
  }
}

// Watchdog: общий предохранитель от зависания всего процесса.
function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setTimeout(() => {
    cancelRequested = true;
    cancelReason = t('errWatchdog');
    sendStatus(t('statusWatchdogTimeout'), 'error');
  }, PROCESS_TIMEOUT_MS);
}

function stopWatchdog() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function requestCancel(reason) {
  if (!isRunning) return { success: false, message: t('errNotRunning') };
  cancelRequested = true;
  cancelReason = reason || t('errStoppedByUser');
  sendStatus(t('statusStopping'), 'progress');
  return { success: true, message: t('msgStopRequested') };
}

function sendStatus(text, status = 'info') {
  chrome.runtime.sendMessage({ type: 'statusUpdate', text, status }).catch(() => {});
  // Дублируем в storage: попап мог быть закрыт в момент отправки — при
  // следующем открытии он покажет последний статус, а не «Готов к работе».
  chrome.storage.local.set({ lastStatus: { text, status, at: Date.now() } }).catch(() => {});
}

// Сообщает попапу о старте/завершении процесса. Нужно для случая, когда попап
// закрыли и открыли заново во время работы: его исходный await потерян, и без
// этого сигнала кнопки остались бы заблокированными навсегда.
function sendRunState(running) {
  chrome.runtime.sendMessage({ type: 'runState', isRunning: running }).catch(() => {});
}

async function sendToTab(tabId, message, retries = 5, delay = 600) {
  for (let i = 0; i < retries; i++) {
    throwIfCancelled();
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (e) {
      if (i < retries - 1) {
        await sleep(delay);
      } else {
        throw new Error(t('errContentScript', [String(tabId), e.message]));
      }
    }
  }
}

async function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(t('errTabLoadTimeout')));
    }, timeoutMs);

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Вкладка могла загрузиться ДО подписки — тогда события 'complete' уже не
    // будет, и без этой проверки ожидание висело бы до таймаута.
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.status === 'complete') done();
    }).catch(() => {});
  });
}

// ─── Окно автоматизации ───────────────────────────────────────────────────

// Создаёт (или переиспользует) отдельное окно для фоновой работы.
// Вкладки в нём остаются АКТИВНЫМИ, поэтому не тротлятся, а фокус ОС сразу
// возвращается окну пользователя — он может спокойно работать дальше.
async function ensureAutomationWindow(firstUrl) {
  // Запоминаем окно пользователя (куда вернём фокус)
  if (userWindowId === null) {
    try {
      const current = await chrome.windows.getCurrent();
      userWindowId = current ? current.id : null;
    } catch (e) { /* ignore */ }
  }

  // Если окно автоматизации ещё живо — переиспользуем
  if (automationWindowId !== null) {
    const win = await getWindow(automationWindowId);
    if (win) {
      const tab = await chrome.tabs.create({ windowId: automationWindowId, url: firstUrl, active: true });
      await restoreUserFocus();
      await waitForTabLoad(tab.id);
      await sleep(500);
      return tab.id;
    }
    automationWindowId = null;
  }

  // Создаём новое окно. Держим его в видимой области (Chrome запрещает
  // уводить окно за пределы экрана: bounds должны быть минимум на 50% видимы),
  // но БЕЗ фокуса — сразу после создания фокус возвращается окну пользователя,
  // и окно автоматизации уходит на задний план. minimized НЕ используем —
  // это вернёт тротлинг таймеров и анимаций.
  const win = await chrome.windows.create({
    url: firstUrl,
    focused: false,
    type: 'normal',
    state: 'normal',
    left: 0,
    top: 0,
    width: 1000,
    height: 800
  });

  automationWindowId = win.id;
  const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;

  await restoreUserFocus();

  if (tabId) {
    await waitForTabLoad(tabId);
    await sleep(500);
  }
  return tabId;
}

async function getWindow(windowId) {
  try {
    return await chrome.windows.get(windowId);
  } catch (e) {
    return null;
  }
}

// Возвращает фокус ОС окну пользователя — чтобы окно автоматизации не
// «выпрыгивало» поверх и не мешало работе.
async function restoreUserFocus() {
  if (userWindowId === null) return;
  try {
    await chrome.windows.update(userWindowId, { focused: true });
  } catch (e) { /* ignore */ }
}

// Выводит окно автоматизации на экран и в фокус — нужно, когда Steam требует
// ручного действия (пароль, Steam Guard, капча) и пользователь должен его видеть.
async function revealAutomationWindow() {
  if (automationWindowId === null) return;
  try {
    await chrome.windows.update(automationWindowId, {
      left: 80,
      top: 80,
      focused: true,
      state: 'normal'
    });
  } catch (e) { /* ignore */ }
}

// Создаёт вкладку в окне автоматизации (активную в этом окне = не тротлится).
async function createBackgroundTab(url) {
  if (automationWindowId === null) {
    // Первый вызов — поднимаем окно автоматизации вместе с этой вкладкой
    return await ensureAutomationWindow(url);
  }

  const win = await getWindow(automationWindowId);
  if (!win) {
    automationWindowId = null;
    return await ensureAutomationWindow(url);
  }

  const tab = await chrome.tabs.create({ windowId: automationWindowId, url, active: true });
  await restoreUserFocus();
  await waitForTabLoad(tab.id);
  await sleep(500);
  return tab.id;
}

async function closeTab(tabId) {
  if (tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) { /* вкладка уже закрыта */ }
  }
}

// Закрывает окно автоматизации целиком (по завершении процесса).
async function closeAutomationWindow() {
  if (automationWindowId === null) return;
  try {
    await chrome.windows.remove(automationWindowId);
  } catch (e) { /* уже закрыто */ }
  automationWindowId = null;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

async function getHistory() {
  const data = await chrome.storage.local.get('collectionHistory');
  return data.collectionHistory || [];
}

async function addHistoryEntry(entry) {
  const history = await getHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  await chrome.storage.local.set({ collectionHistory: history });
}

async function clearHistory() {
  await chrome.storage.local.set({ collectionHistory: [] });
}

// ─── Состояние восстановления ника (персист на случай выгрузки worker'а) ─────
// Смена ника происходит при каждом сборе. Если service worker выгрузится или
// браузер закроется между сменой и восстановлением, ник останется с маркером.
// Поэтому факт «ник изменён, оригинал = X» сразу пишем в storage и снимаем
// только после успешного восстановления. При старте worker'а доводим дело.

const PENDING_KEY = 'pendingNicknameRestore';

async function setPendingRestore(profileUrl, original) {
  await chrome.storage.local.set({
    [PENDING_KEY]: { profileUrl, original, at: Date.now() }
  });
}

async function getPendingRestore() {
  const data = await chrome.storage.local.get(PENDING_KEY);
  return data[PENDING_KEY] || null;
}

async function clearPendingRestore() {
  await chrome.storage.local.remove(PENDING_KEY);
}

async function getStats() {
  const history = await getHistory();
  const successful = history.filter(h => h.status === 'claimed' && h.delta > 0);
  const total = successful.reduce((sum, h) => sum + h.delta, 0);
  const count = successful.length;
  const avg = count > 0 ? Math.round(total / count) : 0;
  const last = history.length > 0 ? history[0] : null;
  return { total, count, avg, last, history };
}

// ─── Смена никнейма Steam ───────────────────────────────────────────────────

async function changeNickname(profileUrl) {
  const editUrl = profileUrl.replace(/\/$/, '') + '/edit/info';
  sendStatus(t('statusOpeningSteamEdit'));
  steamTabId = await createBackgroundTab(editUrl);
  await sleep(1000);

  sendStatus(t('statusChangingNick'));
  const result = await sendToTab(steamTabId, { action: 'changeNickname', addText: MARKER });

  if (!result.success) {
    throw new Error(t('errChangeNick', [result.message]));
  }

  originalNickname = result.originalNickname;
  // Сразу фиксируем в storage: если worker умрёт до восстановления — доведём при старте.
  await setPendingRestore(profileUrl, result.originalNickname);
  if (result.truncated) {
    sendStatus(t('statusNickTruncated'), 'info');
  }
  sendStatus(t('statusNickChanged', [result.originalNickname, result.newNickname]));
  await sleep(2000);
}

async function restoreNickname(profileUrl) {
  if (!originalNickname) return;

  sendStatus(t('statusRestoringNick'));

  try {
    // Если вкладка Steam ещё открыта, переиспользуем
    if (steamTabId) {
      try {
        await chrome.tabs.get(steamTabId);
        // Делаем Steam-вкладку активной в окне автоматизации, чтобы она не была
        // затротлена (пока шёл сбор, активной была вкладка godota2).
        await chrome.tabs.update(steamTabId, { active: true });
        await restoreUserFocus();
        const editUrl = profileUrl.replace(/\/$/, '') + '/edit/info';
        await chrome.tabs.update(steamTabId, { url: editUrl });
        await waitForTabLoad(steamTabId);
        await sleep(1000);
      } catch (e) {
        // Вкладка закрыта, создаём новую
        const editUrl = profileUrl.replace(/\/$/, '') + '/edit/info';
        steamTabId = await createBackgroundTab(editUrl);
        await sleep(1000);
      }
    } else {
      const editUrl = profileUrl.replace(/\/$/, '') + '/edit/info';
      steamTabId = await createBackgroundTab(editUrl);
      await sleep(1000);
    }

    const result = await sendToTab(steamTabId, {
      action: 'restoreNickname',
      originalNickname: originalNickname
    });

    if (result.success) {
      await clearPendingRestore();
      sendStatus(t('statusNickRestored', [originalNickname]), 'success');
    } else {
      throw new Error(result.message);
    }
  } catch (e) {
    sendStatus(t('errNickRestoreFailed', [originalNickname]), 'error');
    throw e;
  }
}

// ─── Авторизация на godota2 ─────────────────────────────────────────────────

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

async function waitForTabCompletePolling(tabId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfCancelled();
    const tab = await getTab(tabId);
    if (!tab) throw new Error(t('errTabClosedLoading'));
    if (tab.status === 'complete') return tab;
    await sleep(250);
  }
  throw new Error(t('errTabLoadTimeout'));
}

async function waitForTabUrl(tabId, predicate, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfCancelled();
    const tab = await getTab(tabId);
    if (!tab) throw new Error(t('errTabClosedNav'));
    const url = tab.url || '';
    if (predicate(url, tab)) return tab;
    await sleep(250);
  }
  throw new Error(t('errNavTimeout'));
}

async function ensureGodotaAuth() {
  sendStatus(t('statusOpeningGodota'));
  godotaTabId = await createBackgroundTab('https://godota2.com/');
  await waitForTabCompletePolling(godotaTabId, 45000);

  sendStatus(t('statusCheckingAuth'));
  await sendToTab(godotaTabId, { action: 'waitForGodotaReady' }, 70, 500).catch(() => null);

  let authState = await sendToTab(godotaTabId, { action: 'checkAuthState' }, 35, 500);

  if (authState && authState.loggedIn) {
    sendStatus(t('statusAlreadyAuthed'));
    return;
  }

  if (!authState || !authState.loginButtonFound) {
    await sleep(1500);
    authState = await sendToTab(godotaTabId, { action: 'checkAuthState' }, 20, 500);

    if (authState && authState.loggedIn) {
      sendStatus(t('statusAuthed'));
      return;
    }
  }

  if (!authState || !authState.loginButtonFound) {
    throw new Error(authState?.message || t('errNoLoginButton'));
  }

  sendStatus(t('statusClickingLogin'));
  const clickResult = await sendToTab(godotaTabId, { action: 'clickSteamLogin' }, 50, 500);
  if (!clickResult || !clickResult.success) {
    throw new Error(clickResult?.message || t('errClickLogin'));
  }

  sendStatus(t('statusWaitingOpenId'));
  await waitForTabUrl(godotaTabId, url => url.includes('steamcommunity.com/openid/login'), 45000);
  await waitForTabCompletePolling(godotaTabId, 45000);

  sendStatus(t('statusConfirmingOpenId'));
  const openIdResult = await sendToTab(godotaTabId, { action: 'confirmSteamOpenId' }, 60, 500);

  if (!openIdResult || !openIdResult.success) {
    if (openIdResult && openIdResult.manualActionRequired) {
      sendStatus(t('statusManualLogin'), 'error');
      await revealAutomationWindow();
    } else {
      throw new Error(openIdResult?.message || t('errConfirmOpenId'));
    }
  }

  sendStatus(t('statusWaitingReturn'));
  await waitForTabUrl(godotaTabId, url => url.includes('godota2.com'), 120000);
  await waitForTabCompletePolling(godotaTabId, 45000);

  // Если показывали окно для ручного входа — после возврата прячем обратно
  // и отдаём фокус пользователю.
  if (openIdResult && openIdResult.manualActionRequired) {
    await restoreUserFocus();
  }

  sendStatus(t('statusWaitingAccount'));
  await sendToTab(godotaTabId, { action: 'waitForGodotaReady' }, 80, 500).catch(() => null);
  await sleep(1000);

  const finalAuth = await sendToTab(godotaTabId, { action: 'checkAuthState' }, 40, 500);
  if (!finalAuth || !finalAuth.loggedIn) {
    sendStatus(t('statusAuthUncertain'), 'info');
    return;
  }
  sendStatus(t('statusAuthSuccess'));
}

async function waitForTabNavigation(tabId, urlFragment, timeoutMs = 30000) {
  return await waitForTabUrl(tabId, url => url.includes(urlFragment), timeoutMs);
}

// ─── Сбор бонуса ────────────────────────────────────────────────────────────

async function collectBonus() {
  // Читаем баланс «до»
  sendStatus(t('statusReadingBalance'));
  const balanceBefore = await sendToTab(godotaTabId, { action: 'getBalance' });
  const beforeValue = balanceBefore.success ? balanceBefore.balance : null;

  if (beforeValue !== null) {
    sendStatus(t('statusBalanceBefore', [String(beforeValue)]));
  } else {
    sendStatus(t('statusBalanceReadFail'), 'info');
  }

  // Кликаем DAILY GIFT и OPEN DAILY
  sendStatus(t('statusCollecting'));
  const collectResult = await sendToTab(godotaTabId, { action: 'collectDailyBonus' });

  if (collectResult.alreadyCollected) {
    sendStatus(t('statusAlreadyCollected'), 'info');
    return { status: 'already_collected', balanceBefore: beforeValue, balanceAfter: beforeValue, delta: 0 };
  }

  if (!collectResult.success) {
    throw new Error(t('errCollect', [collectResult.message]));
  }

  let delta = null;
  let afterValue = null;
  let status = 'uncertain';

  // ───── ИСТОЧНИК №1 (главный): сумма из попапа "Open daily received: +200" ─────
  // Сайт сам пишет точную сумму выигрыша. content script ловит её при сборе.
  // Это не зависит от гонок: даже если число в шапке докручивается с задержкой,
  // сумма из попапа уже точна.
  const winAmount = collectResult.winAmount;

  if (typeof winAmount === 'number' && winAmount > 0) {
    delta = winAmount;
    status = 'claimed';

    // Дельта из попапа — источник истины. Баланс «после» = «до» + выигрыш.
    // Шапка #balance_ontop обновляется с задержкой (на скриншотах попап +200
    // уже виден, а шапка ещё показывает старое число), поэтому на неё не
    // закладываемся — только сверяем, если она успела догнать.
    if (beforeValue !== null) {
      // Шапка #balance_ontop обновляется с задержкой, поэтому баланс «после»
      // считаем сами: «до» + выигрыш из попапа.
      afterValue = beforeValue + delta;
      sendStatus(t('statusReceivedWithBalance', [String(delta), String(afterValue)]), 'success');
    } else {
      // «До» не прочитали, но дельту знаем точно из попапа.
      sendStatus(t('statusReceived', [String(delta)]), 'success');
    }

    return { status, balanceBefore: beforeValue, balanceAfter: afterValue, delta, source: 'popup' };
  }

  // ───── ИСТОЧНИК №2 (fallback): попап не пойман — перезагружаем и читаем баланс ─
  sendStatus(t('statusRefiningBalance'));
  try {
    await chrome.tabs.reload(godotaTabId);
    await waitForTabCompletePolling(godotaTabId, 30000);
    await sendToTab(godotaTabId, { action: 'waitForGodotaReady' }, 60, 500).catch(() => null);
    await sleep(1200);
    const afterReload = await sendToTab(godotaTabId, { action: 'getBalance' }).catch(() => null);
    if (afterReload && afterReload.success && afterReload.balance !== null) {
      afterValue = afterReload.balance;
    }
  } catch (e) {
    sendStatus(t('statusReloadFail'), 'info');
  }

  // Снимок диагностики: какие числа/попапы видны на странице. Показывается
  // кнопкой «Диагностика баланса» в попапе — помогает понять, почему сумма
  // не была поймана автоматически.
  try {
    const diag = await sendToTab(godotaTabId, { action: 'diagnoseBalance' }, 3, 500);
    if (diag && diag.success) {
      await chrome.storage.local.set({ lastDiagnostic: { ...diag, at: Date.now() } });
    }
  } catch (e) { /* диагностика опциональна */ }

  if (beforeValue !== null && afterValue !== null) {
    delta = afterValue - beforeValue;
    if (delta > 0) {
      status = 'claimed';
      sendStatus(t('statusReceivedWithBalance', [String(delta), String(afterValue)]), 'success');
    } else {
      status = 'uncertain';
      sendStatus(t('statusBalanceUnchanged', [String(beforeValue), String(afterValue)]), 'info');
    }
  } else {
    sendStatus(t('statusBalanceUnknown'), 'info');
  }

  return { status, balanceBefore: beforeValue, balanceAfter: afterValue, delta, source: 'reload' };
}

// ─── Основные процессы ──────────────────────────────────────────────────────

async function runFullProcess(profileUrl) {
  if (isRunning) return { success: false, message: t('errAlreadyRunning') };
  isRunning = true;
  cancelRequested = false;
  cancelReason = null;
  originalNickname = null;
  steamTabId = null;
  godotaTabId = null;
  startWatchdog();
  sendRunState(true);

  try {
    // Запоминаем окно пользователя (куда вернём фокус)
    try {
      const current = await chrome.windows.getCurrent();
      userWindowId = current ? current.id : null;
    } catch (e) { userWindowId = null; }

    // Шаг 1-3: Смена никнейма
    await changeNickname(profileUrl);

    // Шаг 4-7: Авторизация на godota2
    await ensureGodotaAuth();

    // Шаг 8-11: Сбор бонуса
    const bonusResult = await collectBonus();

    // Сохраняем в историю
    if (bonusResult.status !== 'already_collected') {
      await addHistoryEntry({
        timestamp: Date.now(),
        balanceBefore: bonusResult.balanceBefore,
        balanceAfter: bonusResult.balanceAfter,
        delta: bonusResult.delta,
        status: bonusResult.status
      });
    }

    // Шаг 12: Восстановление никнейма
    await restoreNickname(profileUrl);

    // Шаг 13: Закрытие окна автоматизации целиком
    await closeAutomationWindow();
    godotaTabId = null;
    steamTabId = null;

    sendStatus(t('statusDone'), 'success');
    return { success: true, message: t('msgBonusCollected'), bonusResult };

  } catch (e) {
    const cancelled = e && e.isCancel;
    if (cancelled) {
      sendStatus(`🛑 ${e.message}`, 'error');
    } else {
      sendStatus(t('statusError', [e.message]), 'error');
    }

    // Пытаемся восстановить ник в любом случае (в т.ч. при отмене).
    // Отмену на время отката снимаем, иначе восстановление само прервётся.
    if (originalNickname) {
      cancelRequested = false;
      try {
        await restoreNickname(profileUrl);
      } catch (restoreErr) {
        // Уже обработано внутри restoreNickname
      }
    }

    await closeAutomationWindow();
    godotaTabId = null;
    steamTabId = null;

    return { success: false, cancelled: Boolean(cancelled), message: e.message };
  } finally {
    stopWatchdog();
    isRunning = false;
    originalNickname = null;
    cancelRequested = false;
    cancelReason = null;
    sendRunState(false);
  }
}

async function runCollectOnly() {
  if (isRunning) return { success: false, message: t('errAlreadyRunning') };
  isRunning = true;
  cancelRequested = false;
  cancelReason = null;
  godotaTabId = null;
  startWatchdog();
  sendRunState(true);

  try {
    try {
      const current = await chrome.windows.getCurrent();
      userWindowId = current ? current.id : null;
    } catch (e) { userWindowId = null; }

    // Авторизация на godota2
    await ensureGodotaAuth();

    // Сбор бонуса
    const bonusResult = await collectBonus();

    // Сохраняем в историю
    if (bonusResult.status !== 'already_collected') {
      await addHistoryEntry({
        timestamp: Date.now(),
        balanceBefore: bonusResult.balanceBefore,
        balanceAfter: bonusResult.balanceAfter,
        delta: bonusResult.delta,
        status: bonusResult.status
      });
    }

    await closeAutomationWindow();
    godotaTabId = null;

    sendStatus(t('statusDone'), 'success');
    return { success: true, message: t('msgBonusCollected'), bonusResult };

  } catch (e) {
    const cancelled = e && e.isCancel;
    if (cancelled) {
      sendStatus(`🛑 ${e.message}`, 'error');
    } else {
      sendStatus(t('statusError', [e.message]), 'error');
    }
    await closeAutomationWindow();
    godotaTabId = null;
    return { success: false, cancelled: Boolean(cancelled), message: e.message };
  } finally {
    stopWatchdog();
    isRunning = false;
    cancelRequested = false;
    cancelReason = null;
    sendRunState(false);
  }
}

// ─── Обработка сообщений ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startFullProcess') {
    runFullProcess(message.profileUrl).then(sendResponse);
    return true;
  }

  if (message.action === 'collectBonusOnly') {
    runCollectOnly().then(sendResponse);
    return true;
  }

  if (message.action === 'stopProcess') {
    sendResponse(requestCancel(t('errStoppedByUser')));
    return false;
  }

  if (message.action === 'getRunningState') {
    sendResponse({ isRunning });
    return false;
  }

  if (message.action === 'getStats') {
    getStats().then(sendResponse);
    return true;
  }

  if (message.action === 'getDiagnostic') {
    chrome.storage.local.get('lastDiagnostic').then(d => sendResponse(d.lastDiagnostic || null));
    return true;
  }

  if (message.action === 'clearHistory') {
    clearHistory().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'getSchedule') {
    getSchedule().then(sendResponse);
    return true;
  }

  if (message.action === 'updateSchedule') {
    applySchedule(message.schedule).then(sendResponse);
    return true;
  }
});

// ─── Восстановление ника после выгрузки worker'а / перезапуска ──────────────
// Если в прошлый раз worker умер между сменой и восстановлением ника, в storage
// останется pendingNicknameRestore. При старте досстанавливаем оригинальный ник.

async function recoverPendingNickname() {
  if (isRunning) return; // штатный процесс сам разберётся

  const pending = await getPendingRestore();
  if (!pending || !pending.original || !pending.profileUrl) return;

  isRunning = true;
  try {
    sendStatus(t('statusRecoveringNick'), 'progress');

    try {
      const current = await chrome.windows.getCurrent();
      userWindowId = current ? current.id : null;
    } catch (e) { userWindowId = null; }

    const editUrl = pending.profileUrl.replace(/\/$/, '') + '/edit/info';
    steamTabId = await createBackgroundTab(editUrl);
    await sleep(1000);

    const result = await sendToTab(steamTabId, {
      action: 'restoreNickname',
      originalNickname: pending.original
    });

    if (result && result.success) {
      await clearPendingRestore();
      sendStatus(t('statusNickRecoveredRestart', [pending.original]), 'success');
    } else {
      sendStatus(t('errAutoRestoreFail', [pending.original]), 'error');
    }
  } catch (e) {
    sendStatus(t('errAutoRestoreFailReason', [pending.original, e.message]), 'error');
  } finally {
    await closeAutomationWindow();
    steamTabId = null;
    godotaTabId = null;
    isRunning = false;
  }
}

chrome.runtime.onStartup.addListener(() => { recoverPendingNickname(); });
chrome.runtime.onInstalled.addListener(() => { recoverPendingNickname(); });

// ─── Расписание автосбора (chrome.alarms) ───────────────────────────────────
// Опциональный ежедневный автосбор. ВЫКЛЮЧЕН по умолчанию: каждый сбор меняет ник
// в Steam, а это вешает ~3-часовой запрет на обмены. Пользователь сам включает
// автосбор и выбирает час (по умолчанию ночь, когда трейды обычно не нужны).

const ALARM_NAME = 'dailyAutoCollect';
const SCHEDULE_KEY = 'autoSchedule';

const DEFAULT_SCHEDULE = { enabled: false, hour: 4, minute: 0 };

async function getSchedule() {
  const data = await chrome.storage.local.get(SCHEDULE_KEY);
  const s = data[SCHEDULE_KEY] || {};
  const schedule = {
    enabled: Boolean(s.enabled),
    hour: Number.isInteger(s.hour) ? s.hour : DEFAULT_SCHEDULE.hour,
    minute: Number.isInteger(s.minute) ? s.minute : DEFAULT_SCHEDULE.minute
  };
  // Время следующего запуска берём из живого alarm'а — попап показывает его
  // сразу при открытии, а не только после пересохранения настроек.
  const alarm = await chrome.alarms.get(ALARM_NAME).catch(() => null);
  schedule.nextRun = schedule.enabled && alarm ? alarm.scheduledTime : null;
  return schedule;
}

// Вычисляет timestamp следующего срабатывания для заданных часа/минуты.
function nextOccurrence(hour, minute) {
  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1); // время уже прошло сегодня — берём завтра
  }
  return next.getTime();
}

// Применяет настройки: сохраняет и (пере)создаёт или удаляет alarm.
async function applySchedule(schedule) {
  const normalized = {
    enabled: Boolean(schedule && schedule.enabled),
    hour: clampInt(schedule && schedule.hour, 0, 23, DEFAULT_SCHEDULE.hour),
    minute: clampInt(schedule && schedule.minute, 0, 59, DEFAULT_SCHEDULE.minute)
  };

  await chrome.storage.local.set({ [SCHEDULE_KEY]: normalized });
  await chrome.alarms.clear(ALARM_NAME);

  if (normalized.enabled) {
    const when = nextOccurrence(normalized.hour, normalized.minute);
    // periodInMinutes = сутки: alarm самоповторяется ежедневно.
    chrome.alarms.create(ALARM_NAME, { when, periodInMinutes: 24 * 60 });
    return { success: true, schedule: normalized, nextRun: when };
  }

  return { success: true, schedule: normalized, nextRun: null };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Восстанавливает alarm из сохранённых настроек (после перезапуска браузера
// alarms переживают рестарт, но пере-создаём на всякий случай для консистентности).
async function ensureAlarmFromStorage() {
  const schedule = await getSchedule();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (schedule.enabled && !existing) {
    const when = nextOccurrence(schedule.hour, schedule.minute);
    chrome.alarms.create(ALARM_NAME, { when, periodInMinutes: 24 * 60 });
  } else if (!schedule.enabled && existing) {
    await chrome.alarms.clear(ALARM_NAME);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  if (isRunning) return; // не накладываемся на уже идущий процесс

  const data = await chrome.storage.sync.get('profileUrl');
  const profileUrl = data.profileUrl;
  if (!profileUrl) {
    sendStatus(t('errNoProfileUrl'), 'error');
    return;
  }

  sendStatus(t('statusAutoCollectStart'), 'progress');
  await runFullProcess(profileUrl);
});

// Поднимаем alarm при старте worker'а
chrome.runtime.onStartup.addListener(() => { ensureAlarmFromStorage(); });
chrome.runtime.onInstalled.addListener(() => { ensureAlarmFromStorage(); });
