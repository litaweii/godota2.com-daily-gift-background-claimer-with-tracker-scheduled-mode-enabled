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
  // Реальные id сайта (в порядке приоритета): #balance_ontop — шапка при
  // логине, #balance_main — блок профиля, #balance_mobile — мобильное меню.
  // Предпочитаем видимый элемент: скрытые могут показывать устаревший «0».
  const ids = ['#balance_ontop', '#balance_main', '#balance_mobile'];
  let firstExisting = null;
  for (const sel of ids) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (isVisible(el)) return el;
    if (!firstExisting) firstExisting = el;
  }
  if (firstExisting) return firstExisting;

  // Фоллбэк на случай редизайна
  return document.querySelector('.balance_ontop, .user-balance, .balance-value, [data-balance]');
}

function getBalance() {
  const el = getBalanceElement();
  if (!el) return null;
  return parseBalance(el.textContent);
}

// Сайт рендерит в каждую страницу инлайн-скрипт <script>STEAMID = '765…'</script>
// ('0' — не авторизован). Это самый надёжный признак: main.js сайта сам
// проверяет по нему вход. Возвращает строку steamid или null, если скрипт
// не найден (например, после редизайна).
function readSteamId() {
  for (const s of document.querySelectorAll('script:not([src])')) {
    const m = (s.textContent || '').match(/STEAMID\s*=\s*'(\d*)'/);
    if (m) return m[1];
  }
  return null;
}

// Единственный источник истины о состоянии авторизации на странице.
// Основной сигнал — STEAMID; DOM-эвристики остаются фоллбэком.
function readAuthState() {
  const steamId = readSteamId();
  const loginButton = findLoginButton();
  const bodyText = document.body?.innerText || '';
  const lower = bodyText.toLowerCase();

  const hasUserPanel = Boolean(
    getBalance() !== null ||
    Array.from(document.querySelectorAll('img')).some(img => isVisible(img) && ((img.src || '').includes('avatars') || /avatar/i.test(img.className || ''))) ||
    document.getElementById('balance_ontop') ||
    (lower.includes('balance:') && !loginButton) ||
    lower.includes('login with:') ||
    lower.includes('connecting') ||
    lower.includes('generating token') ||
    /logout|выйти|sign\s*out/i.test(bodyText)
  );

  const loggedIn = steamId !== null
    ? steamId !== '' && steamId !== '0'
    : !loginButton && hasUserPanel;

  return {
    steamId,
    loggedIn,
    loginButton,
    hasUserPanel,
    isConnecting: lower.includes('connecting') || lower.includes('generating token')
  };
}

function findLoginButton() {
  // Реальная разметка сайта: <div class="top_signin"><a href="?login"><img …></a></div>
  const byHref = Array.from(document.querySelectorAll('a[href$="?login"], .top_signin a')).find(isVisible);
  if (byHref) return byHref;

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
  // Стратегия 1: класс из реальной разметки — клик по .js_dailygift открывает
  // модалку .open_daily (обработчик в main.js сайта). Берём видимый экземпляр:
  // второй лежит в скрытом мобильном меню.
  const real = Array.from(document.querySelectorAll('.js_dailygift'));
  const visible = real.find(isVisible);
  if (visible) return visible;
  if (real.length) return real[0];

  // Стратегия 2: по тексту
  const tabs = document.querySelectorAll('a, button, div, li, span');
  for (const tab of tabs) {
    const text = (tab.textContent || '').trim();
    if (/^daily\s*gift$/i.test(text) || /^ежедневный\s*подарок$/i.test(text)) {
      return tab;
    }
  }

  // Стратегия 3: по href, data-атрибуту, id/классу
  return document.querySelector('a[href*="daily"], [data-tab*="daily"], #daily-tab, .daily-tab, [class*="daily"]');
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

// Только ПОЛНЫЕ формулировки сайта «бонус уже получен». Раньше проверялись
// одиночные слова (/already/, /tomorrow/, /завтра/) по всему body — любое такое
// слово в чате сайта давало ложное «уже собрано» и сбор молча пропускался.
const COLLECTED_PATTERNS = [
  /already\s*(collected|received|opened|got|claimed)/i,
  /try\s*(it\s*)?again\s*(the\s*)?next\s*day/i,
  /come\s*back\s*tomorrow/i,
  /next\s*(gift|daily|bonus)\s*in/i,
  /уже\s*получ/i,
  /приходи(те)?\s*завтра/i,
  /следующий\s*(подарок|бонус)?\s*через/i
];

function isAlreadyCollected() {
  // Сначала попапы-уведомления сайта (совокупный текст заголовка и сообщения).
  if (readNotifyTexts().some(text => COLLECTED_PATTERNS.some(p => p.test(text)))) {
    return true;
  }

  // Затем видимые «листовые» узлы с коротким текстом (надписи у кнопки и т.п.) —
  // а не весь body, где длинные блоки вроде чата дают ложные совпадения.
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 120) continue;
    if (!isVisible(el)) continue;
    if (COLLECTED_PATTERNS.some(p => p.test(raw))) return true;
  }
  return false;
}

// Тексты видимых попапов-уведомлений сайта (notify() в main.js сайта рендерит
// их в .notifications: <div class="notify"><span>title</span><span>mess</span>).
function readNotifyTexts() {
  return Array.from(document.querySelectorAll('.notifications .notify'))
    .filter(isVisible)
    .map(el => normalizeText(el.textContent))
    .filter(Boolean);
}

// Ищет сообщение сайта об отказе из-за отсутствия маркера в нике
// («add godota2.com to your name» и т.п.). Возвращает текст или null.
// Заголовок и текст попапа лежат в РАЗНЫХ span'ах, поэтому сначала проверяем
// совокупный текст попапов, и лишь потом — одиночные видимые узлы.
function findMarkerRejection() {
  const looksLikeRejection = text =>
    /godota2\.com/i.test(text) && /nick|name|ник|имя/i.test(text);

  const notifyHit = readNotifyTexts().find(looksLikeRejection);
  if (notifyHit) return notifyHit;

  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0 || !isVisible(el)) continue;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 160) continue;
    if (looksLikeRejection(raw)) return raw;
  }
  return null;
}

// ─── Обработчик сообщений ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'checkAuthState':
      handleCheckAuth().then(sendResponse);
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
  const { steamId, loggedIn, loginButton, hasUserPanel, isConnecting } = readAuthState();

  return {
    success: true,
    loggedIn,
    steamId,
    loginButtonFound: Boolean(loginButton),
    isConnecting,
    message: loginButton
      ? t('msgLoginBtnVisible')
      : hasUserPanel
        ? t('msgAuthSigns')
        : t('msgAuthUnknown')
  };
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

// Ждёт сумму выигрыша до timeoutMs: сочетает частый polling и результат
// MutationObserver'а (holder) — выходит сразу, как только сумма поймана любым
// из двух путей, не досиживая таймаут.
async function waitForWinAmount(timeoutMs, holder) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (holder && holder.result !== null) return holder.result;
    const amount = readWinAmountFromPopup();
    if (amount !== null) return amount;
    await sleep(120);
  }
  return holder ? holder.result : null;
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
    const winAmount = await waitForWinAmount(15000, observerHolder);
    observerHolder.stop();

    // Сумма не поймана — проверяем, не ответил ли сайт отказом.
    if (winAmount === null) {
      if (isAlreadyCollected()) {
        return { success: false, alreadyCollected: true, status: 'already_collected', message: t('msgAlreadyCollectedToday') };
      }
      const rejection = findMarkerRejection();
      if (rejection) {
        return { success: false, alreadyCollected: false, status: 'error', markerRejected: true, message: t('errMarkerRejected') };
      }
    }

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
