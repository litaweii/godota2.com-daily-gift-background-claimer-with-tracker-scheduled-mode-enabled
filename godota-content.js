// godota-content.js — Content script для godota2.com
'use strict';

// ─── Утилиты ────────────────────────────────────────────────────────────────

// Локализованное сообщение из _locales/*/messages.json (фоллбэк — сам ключ).
function t(key, subs) {
  const msg = chrome.i18n.getMessage(key, subs);
  return msg || key;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function waitForCondition(checker, timeoutMs = 20000, intervalMs = 300) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = checker();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function textOf(element) {
  return normalizeText(element?.innerText || element?.textContent || element?.value || element?.alt || '');
}

function isVisible(element) {
  return Boolean(element && (element.offsetParent || element.getClientRects().length));
}

function findClickableAncestor(element) {
  if (!element) return null;
  return element.closest('a, button, [role="button"], input[type="button"], input[type="submit"]') || element;
}

function parseBalance(text) {
  if (!text) return null;
  // Берём ПЕРВУЮ последовательность цифр (с возможными разделителями тысяч)
  // Это устойчивее, чем "вычистить всё подряд": если в тексте "Balance: 1,270 G2 +200",
  // мы возьмём "1270", а не "1270200".
  const match = String(text).match(/-?\d[\d\s,.\u00A0]*/);
  if (!match) return null;
  // Теперь из найденного куска убираем все разделители (включая точку и запятую как тысячные)
  const cleaned = match[0].replace(/[\s,.\u00A0]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

function getBalanceElement() {
  // Стратегия 1: по id
  let el = document.querySelector('#balance_ontop');
  if (el) return el;

  // Стратегия 2: по классу
  el = document.querySelector('.balance_ontop, .user-balance, .balance-value');
  if (el) return el;

  // Стратегия 3: по data-атрибуту
  el = document.querySelector('[data-balance]');
  if (el) return el;

  return null;
}

function getBalance() {
  const el = getBalanceElement();
  if (!el) return null;
  return parseBalance(el.textContent);
}

function isLoggedIn() {
  const loginButton = findLoginButton();
  const bodyText = document.body?.innerText || '';
  const lower = bodyText.toLowerCase();

  const hasUserPanel = Boolean(
    getBalance() !== null ||
    Array.from(document.querySelectorAll('img')).some(img => isVisible(img) && ((img.src || '').includes('avatars') || /avatar/i.test(img.className || ''))) ||
    document.getElementById('balance_ontop') ||
    lower.includes('balance:') && !loginButton ||
    lower.includes('login with:') ||
    lower.includes('connecting') ||
    lower.includes('generating token') ||
    /logout|выйти|sign\s*out/i.test(bodyText)
  );

  return !loginButton && hasUserPanel;
}

function findLoginButton() {
  const image = Array.from(document.querySelectorAll('img')).find(img => {
    const alt = (img.alt || '').toLowerCase();
    const src = (img.src || '').toLowerCase();
    return alt.includes('sign in') ||
      alt.includes('steam') ||
      src.includes('steam') ||
      src.includes('sits_') ||
      src.includes('signinthroughsteam');
  });

  if (image && isVisible(image)) {
    return findClickableAncestor(image);
  }

  const candidates = Array.from(document.querySelectorAll('a, button, input, div, span'));

  return candidates.find(el => {
    if (!isVisible(el)) return false;
    const text = textOf(el).toLowerCase();
    const href = (el.href || '').toLowerCase();
    return text.includes('sign in through steam') ||
      text.includes('sign in') && text.includes('steam') ||
      text.includes('login with steam') ||
      text.includes('войти') && text.includes('steam') ||
      href.includes('steam') && /login|auth|openid|sign/.test(href);
  }) || null;
}

function findDailyGiftTab() {
  // Стратегия 1: по тексту
  const tabs = document.querySelectorAll('a, button, div, li, span');
  for (const tab of tabs) {
    const text = (tab.textContent || '').trim();
    if (/^daily\s*gift$/i.test(text) || /^ежедневный\s*подарок$/i.test(text)) {
      return tab;
    }
  }

  // Стратегия 2: по href или data-атрибуту
  const links = document.querySelectorAll('a[href*="daily"], [data-tab*="daily"]');
  for (const link of links) return link;

  // Стратегия 3: по id/классу
  const el = document.querySelector('#daily-tab, .daily-tab, [class*="daily"]');
  if (el) return el;

  return null;
}

function findDailyButton() {
  // Стратегия 1: по id
  let btn = document.querySelector('#dailygo');
  if (btn) return btn;

  // Стратегия 2: по тексту
  const buttons = document.querySelectorAll('button, a, div[onclick], span[onclick]');
  for (const b of buttons) {
    const text = (b.textContent || '').trim();
    if (/open\s*daily|получить|забрать|claim/i.test(text)) {
      return b;
    }
  }

  // Стратегия 3: по классу
  btn = document.querySelector('.daily-btn, .claim-btn, [class*="dailygo"]');
  if (btn) return btn;

  return null;
}

function isAlreadyCollected() {
  const body = document.body.textContent || '';
  const patterns = [
    /already/i,
    /tomorrow/i,
    /try\s*it\s*again\s*next\s*day/i,
    /уже\s*получен/i,
    /завтра/i,
    /следующий\s*через/i
  ];
  return patterns.some(p => p.test(body));
}

// ─── Обработчик сообщений ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'checkAuthState':
      handleCheckAuth().then(sendResponse);
      return true;

    case 'clickSteamLogin':
      handleClickLogin().then(sendResponse);
      return true;

    case 'waitForGodotaReady':
      handleWaitReady().then(sendResponse);
      return true;

    case 'getBalance':
      handleGetBalance(sendResponse);
      return false;

    case 'diagnoseBalance':
      handleDiagnoseBalance().then(sendResponse);
      return true;

    case 'waitForBalanceChange':
      handleWaitBalanceChange(message.referenceValue, message.timeoutMs).then(sendResponse);
      return true;

    case 'collectDailyBonus':
      handleCollectBonus().then(sendResponse);
      return true;

    // Обработка OpenID на godota2 (если редирект произошёл на этой вкладке)
    case 'confirmSteamOpenId':
      handleConfirmOpenId().then(sendResponse);
      return true;
  }
});

async function handleCheckAuth() {
  const loginButton = findLoginButton();
  const bodyText = document.body?.innerText || '';
  const lower = bodyText.toLowerCase();

  const hasUserPanel = Boolean(
    getBalance() !== null ||
    Array.from(document.querySelectorAll('img')).some(img => isVisible(img) && ((img.src || '').includes('avatars') || /avatar/i.test(img.className || ''))) ||
    document.getElementById('balance_ontop') ||
    lower.includes('balance:') && !loginButton ||
    lower.includes('login with:') ||
    lower.includes('connecting') ||
    lower.includes('generating token') ||
    /logout|выйти|sign\s*out/i.test(bodyText)
  );

  return {
    success: true,
    loggedIn: !loginButton && hasUserPanel,
    loginButtonFound: Boolean(loginButton),
    isConnecting: lower.includes('connecting') || lower.includes('generating token'),
    message: loginButton
      ? t('msgLoginBtnVisible')
      : hasUserPanel
        ? t('msgAuthSigns')
        : t('msgAuthUnknown')
  };
}

async function handleClickLogin() {
  const loginButton = await waitForCondition(findLoginButton, 20000);
  if (!loginButton) {
    return { success: false, message: t('errNoLoginButton') };
  }
  findClickableAncestor(loginButton).click();
  return { success: true, message: t('msgLoginClicked') };
}

async function handleWaitReady() {
  await waitForCondition(() => {
    const lower = (document.body?.innerText || '').toLowerCase();
    const stillConnecting = lower.includes('generating token') || lower.includes('connecting...');
    const hasLoginButton = Boolean(findLoginButton());
    const hasDailyGift = Boolean(findDailyGiftTab());
    const hasOpenDaily = Boolean(findDailyButton());
    const hasBalance = Boolean(document.getElementById('balance_ontop')) || getBalance() !== null;

    return !stillConnecting && (hasLoginButton || hasDailyGift || hasOpenDaily || hasBalance);
  }, 30000);

  return {
    success: true,
    authState: await handleCheckAuth(),
    message: t('msgGodotaReady')
  };
}

function handleGetBalance(sendResponse) {
  const balance = getBalance();
  sendResponse({
    success: balance !== null,
    balance,
    message: balance !== null ? t('msgBalance', [String(balance)]) : t('errBalanceRead')
  });
}

async function handleWaitBalanceChange(referenceValue, timeoutMs = 15000) {
  // ИДЕЯ: ждём, пока баланс СТАНЕТ БОЛЬШЕ исходного (именно зачисление, а не ререндер),
  // а затем убедимся, что значение «устаканилось» (1.5 сек подряд без роста) —
  // чтобы не зафиксировать промежуточное число во время анимации счётчика.
  const startTime = Date.now();
  const interval = 250;
  const stabilizationMs = 1500;

  let bestValue = null;        // максимум, который мы видели
  let lastChangeAt = null;     // когда bestValue последний раз вырос

  while (Date.now() - startTime < timeoutMs) {
    const current = getBalance();

    if (current !== null) {
      // Засчитываем только РОСТ относительно исходного значения.
      // (Если referenceValue не известно — null — берём любое непустое.)
      const isIncrease =
        referenceValue === null
          ? bestValue === null || current > bestValue
          : current > referenceValue && (bestValue === null || current >= bestValue);

      if (isIncrease) {
        if (bestValue === null || current > bestValue) {
          bestValue = current;
          lastChangeAt = Date.now();
        }
      }

      // Если уже видели рост и он не меняется stabilizationMs — выходим
      if (bestValue !== null && lastChangeAt !== null) {
        if (Date.now() - lastChangeAt >= stabilizationMs) {
          return { changed: true, value: bestValue, stabilized: true };
        }
      }
    }

    await sleep(interval);
  }

  // Таймаут. Возвращаем лучшее увиденное значение (если был рост) или текущее (как фоллбэк).
  const finalValue = bestValue !== null ? bestValue : getBalance();
  return {
    changed: finalValue !== null && finalValue !== referenceValue,
    value: finalValue,
    stabilized: false
  };
}

// ─── ДИАГНОСТИКА ─────────────────────────────────────────────────────────────
// Возвращает «снимок» страницы: все узлы, похожие на баланс, их селекторы и текст.
// Помогает понять, какой именно элемент обновляется после сбора.

function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += '#' + node.id;
      parts.unshift(part);
      break; // id уникален — дальше можно не идти
    }
    if (node.className && typeof node.className === 'string') {
      const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) part += '.' + cls;
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

function scanBalanceCandidates() {
  const candidates = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    // Берём только «листовые» узлы (без детей-элементов) — там лежит само число
    if (el.children.length > 0) continue;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 25) continue;
    // Текст должен содержать число от 2 цифр (баланс вряд ли однозначный)
    if (!/\d{2,}/.test(raw)) continue;
    const parsed = parseBalance(raw);
    if (parsed === null) continue;
    candidates.push({
      selector: cssPath(el),
      id: el.id || null,
      className: (typeof el.className === 'string' ? el.className : '') || null,
      text: raw,
      parsed,
      visible: isVisible(el)
    });
  }
  // Уникализируем по selector+text, ограничиваем
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = c.selector + '|' + c.text;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= 40) break;
  }
  return unique;
}

function findWinPopupText() {
  // Ищем текст вида "+200", "you won 200", "+200 G2" в видимых узлах
  const all = document.querySelectorAll('*');
  const hits = [];
  for (const el of all) {
    if (el.children.length > 0) continue;
    if (!isVisible(el)) continue;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 40) continue;
    if (/\+\s*\d{2,}|you\s*won|won\s*\d|выигр|получено|\bwin\b/i.test(raw)) {
      hits.push({ selector: cssPath(el), text: raw });
    }
  }
  return hits.slice(0, 15);
}

async function handleDiagnoseBalance() {
  return {
    success: true,
    url: location.href,
    currentGetBalance: getBalance(),
    balanceElementFound: Boolean(getBalanceElement()),
    candidates: scanBalanceCandidates(),
    winPopup: findWinPopupText()
  };
}

// Извлекает сумму бонуса из попапа-уведомления "Open daily received: +200".
// Возвращает число (200) или null, если попап не найден.
function readWinAmountFromPopup() {
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.children.length > 0) continue;
    if (!isVisible(el)) continue;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 60) continue;
    // ТОЛЬКО финальный попап выигрыша: слово "received" есть лишь в нём
    // ("Open daily received: +200"). Это не даёт зацепить числа из крутящейся
    // рулетки (1,500 / 3,000 / ...) или заголовки вкладки Daily Gift.
    if (/received/i.test(raw) && /\+?\s*\d{2,}/.test(raw)) {
      const m = raw.match(/\+?\s*(\d[\d\s,.\u00A0]*)/);
      if (m) {
        const n = parseInt(m[1].replace(/[\s,.\u00A0]/g, ''), 10);
        if (!isNaN(n) && n > 0) return n;
      }
    }
  }
  // Запасной заход: зелёный SUCCESS-блок с "+NNN" (на случай иной формулировки).
  for (const el of all) {
    if (!isVisible(el)) continue;
    const raw = (el.textContent || '').trim();
    if (raw.length > 80) continue;
    if (/success/i.test(raw) && /\+\s*\d{2,}/.test(raw)) {
      const m = raw.match(/\+\s*(\d[\d\s,.\u00A0]*)/);
      if (m) {
        const n = parseInt(m[1].replace(/[\s,.\u00A0]/g, ''), 10);
        if (!isNaN(n) && n > 0) return n;
      }
    }
  }
  return null;
}

// Ждёт появления попапа с суммой до timeoutMs мс (частый polling)
async function waitForWinAmount(timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const amount = readWinAmountFromPopup();
    if (amount !== null) return amount;
    await sleep(120);
  }
  return null;
}

// Ставит MutationObserver, который ловит попап в момент его появления в DOM.
// Возвращает объект с .result (заполнится числом) и .stop() для остановки.
// Нужен на случай, если попап мелькает быстрее, чем интервал polling.
function startWinAmountObserver() {
  const holder = { result: null, stop: null };

  const tryRead = () => {
    if (holder.result !== null) return;
    const amount = readWinAmountFromPopup();
    if (amount !== null) holder.result = amount;
  };

  // Сразу пробуем — вдруг попап уже на экране
  tryRead();

  const observer = new MutationObserver(() => tryRead());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  holder.stop = () => observer.disconnect();
  return holder;
}

async function handleCollectBonus() {
  try {
    // Проверяем, не собран ли уже
    if (isAlreadyCollected()) {
      return { success: false, alreadyCollected: true, status: 'already_collected', message: t('msgAlreadyCollectedToday') };
    }

    // Кликаем по вкладке DAILY GIFT
    const dailyTab = findDailyGiftTab();
    if (dailyTab) {
      dailyTab.click();
      await sleep(1000);
    }

    // Проверяем ещё раз после переключения вкладки
    if (isAlreadyCollected()) {
      return { success: false, alreadyCollected: true, status: 'already_collected', message: t('msgAlreadyCollectedToday') };
    }

    // Кликаем OPEN DAILY
    const dailyBtn = findDailyButton();
    if (!dailyBtn) {
      return { success: false, alreadyCollected: false, status: 'error', message: t('errOpenDailyNotFound') };
    }

    // Ставим наблюдатель ДО клика — чтобы поймать попап в момент появления,
    // даже если он мелькнёт быстрее интервала polling.
    const observerHolder = startWinAmountObserver();

    dailyBtn.click();

    // Ловим сумму двумя путями параллельно: polling + observer.
    // 15 сек — с запасом на анимацию «верчения» рулетки перед попапом.
    // Observer вернёт результат сразу, как попап появится, не ожидая таймаута.
    const polled = await waitForWinAmount(15000);
    const winAmount = polled !== null ? polled : observerHolder.result;
    observerHolder.stop();

    return {
      success: true,
      alreadyCollected: false,
      status: 'claimed',
      winAmount,                    // сумма из попапа (null если не пойман)
      message: winAmount !== null ? t('msgBonusCollectedAmount', [String(winAmount)]) : t('msgBonusCollected')
    };
  } catch (e) {
    return { success: false, uncertain: true, status: 'uncertain', message: e.message };
  }
}

async function handleConfirmOpenId() {
  // Эта функция может быть вызвана если Steam OpenID открылся в той же вкладке
  const signInBtn = document.querySelector('#imageLogin, input[type="image"], input[type="submit"]');
  if (signInBtn) {
    signInBtn.click();
    return { success: true, manualActionRequired: false, message: t('msgSignInClicked') };
  }

  // Проверяем, нужен ли ручной ввод
  const passwordField = document.querySelector('input[type="password"]');
  if (passwordField) {
    return { success: false, manualActionRequired: true, message: t('errManualLoginRequired') };
  }

  return { success: false, manualActionRequired: true, message: t('errSignInNotFound') };
}
