// steam-content.js — Content script для steamcommunity.com
'use strict';

// Steam ограничивает имя профиля 32 символами.
const MAX_NICK_LEN = 32;

// ─── Утилиты ────────────────────────────────────────────────────────────────

// Локализованное сообщение из _locales/*/messages.json (фоллбэк — сам ключ).
function t(key, subs) {
  const msg = chrome.i18n.getMessage(key, subs);
  return msg || key;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function waitForElement(selectorOrFinder, timeoutMs = 15000, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const element = typeof selectorOrFinder === 'function'
      ? selectorOrFinder()
      : document.querySelector(selectorOrFinder);
    if (element) return element;
    await sleep(intervalMs);
  }
  return null;
}

function setNativeValue(element, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function findNicknameInput() {
  // Стратегия 1: по имени
  let input = document.querySelector('input[name="personaName"]');
  if (input) return input;

  // Стратегия 2: по id
  input = document.querySelector('#personaName');
  if (input) return input;

  // Стратегия 3: по placeholder или label
  const inputs = document.querySelectorAll('input[type="text"]');
  for (const inp of inputs) {
    const label = inp.closest('.formRow')?.querySelector('.formRowTitle');
    if (label && /profile\s*name|имя\s*профиля/i.test(label.textContent)) {
      return inp;
    }
  }

  // Стратегия 4: первый текстовый input в форме редактирования
  input = document.querySelector('.profile_edit_form input[type="text"]');
  if (input) return input;

  return null;
}

function findSaveButton() {
  // Стратегия 1: кнопка с текстом Save
  const buttons = document.querySelectorAll('button, input[type="submit"], .btn_green_steamui');
  for (const btn of buttons) {
    if (/save|сохранить/i.test(btn.textContent || btn.value || '')) {
      return btn;
    }
  }

  // Стратегия 2: по классу
  let btn = document.querySelector('.profile_edit_save_btn');
  if (btn) return btn;

  btn = document.querySelector('[onclick*="SaveProfile"]');
  if (btn) return btn;

  return null;
}

// ─── Обработка OpenID ───────────────────────────────────────────────────────

function isOpenIdPage() {
  return window.location.href.includes('steamcommunity.com/openid/login');
}

function findSignInButton() {
  const directSelectors = [
    '#imageLogin',
    'input#imageLogin',
    'input[type="submit"][value*="Sign" i]',
    'button[type="submit"]',
    '.btn_green_white_innerfade',
    '.btnv6_green_white_innerfade'
  ];

  for (const selector of directSelectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }

  const candidates = Array.from(document.querySelectorAll('button, input, a, div'));

  return candidates.find(el => {
    const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
    const visible = Boolean(el.offsetParent || el.getClientRects().length);
    return visible && (text === 'sign in' || text.includes('sign in') || text.includes('войти'));
  }) || null;
}

function detectManualActionRequired() {
  const bodyText = (document.body?.innerText || '').toLowerCase();

  return Boolean(
    document.querySelector('input[type="password"]') ||
    document.querySelector('input[name="password"]') ||
    document.querySelector('input[name*="guard" i]') ||
    document.querySelector('input[autocomplete="one-time-code"]') ||
    document.querySelector('#captchaImg, .captcha, [id*="captcha"]') ||
    bodyText.includes('steam guard') ||
    bodyText.includes('captcha') ||
    bodyText.includes('enter the characters')
  );
}

// ─── Обработчик сообщений ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'changeNickname') {
    handleChangeNickname(message.addText).then(sendResponse);
    return true;
  }

  if (message.action === 'restoreNickname') {
    handleRestoreNickname(message.originalNickname).then(sendResponse);
    return true;
  }

  if (message.action === 'confirmSteamOpenId') {
    handleConfirmOpenId().then(sendResponse);
    return true;
  }
});

async function handleChangeNickname(addText) {
  try {
    const input = findNicknameInput();
    if (!input) {
      return { success: false, message: t('errNickFieldNotFound') };
    }

    const currentNickname = input.value;
    const marker = addText;

    // Если ник уже содержит маркер — не добавляем повторно
    if (currentNickname.includes(addText.trim())) {
      const cleanNickname = currentNickname.replace(addText, '').replace(addText.trim(), '');
      return {
        success: true,
        originalNickname: cleanNickname,
        newNickname: currentNickname,
        message: t('msgMarkerPresent')
      };
    }

    // Steam ограничивает имя профиля 32 символами. Маркер обязателен для сбора,
    // поэтому если "ник + маркер" не влезает — обрезаем БАЗОВУЮ часть так, чтобы
    // маркер встал целиком. Полный оригинал всё равно сохраняется для отката,
    // так что обрезка видна только на время сбора и не портит ник навсегда.
    let base = currentNickname;
    let truncated = false;
    if (base.length + marker.length > MAX_NICK_LEN) {
      base = base.slice(0, Math.max(0, MAX_NICK_LEN - marker.length));
      truncated = true;
    }

    const newNickname = base + marker;
    setNativeValue(input, newNickname);
    await sleep(500);

    // Читаем значение обратно: ловим обрезку поля (maxlength/валидация Steam).
    // Маркер ДОЛЖЕН присутствовать целиком, иначе бонус не засчитают.
    if (!input.value.includes(marker.trim())) {
      return {
        success: false,
        message: t('errMarkerNotKept', [input.value])
      };
    }

    const saveBtn = findSaveButton();
    if (!saveBtn) {
      return { success: false, message: t('errSaveBtnNotFound') };
    }

    saveBtn.click();
    await sleep(2000);

    return {
      success: true,
      originalNickname: currentNickname, // ВСЕГДА полный оригинал — для точного отката
      newNickname: newNickname,
      truncated,
      message: truncated ? t('msgNickChangedTrunc') : t('msgNickChanged')
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function handleRestoreNickname(originalNickname) {
  try {
    const input = findNicknameInput();
    if (!input) {
      return { success: false, message: t('errNickFieldNotFound') };
    }

    setNativeValue(input, originalNickname);
    await sleep(500);

    const saveBtn = findSaveButton();
    if (!saveBtn) {
      return { success: false, message: t('errSaveBtnNotFound') };
    }

    saveBtn.click();
    await sleep(2000);

    return { success: true, message: t('msgNickRestored') };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function handleConfirmOpenId() {
  try {
    if (!isOpenIdPage()) {
      return { success: false, manualActionRequired: false, message: t('errNotOpenIdPage') };
    }

    if (detectManualActionRequired()) {
      return {
        success: false,
        manualActionRequired: true,
        message: t('errSteamManual')
      };
    }

    const signInBtn = await waitForElement(findSignInButton, 20000);
    if (!signInBtn) {
      return {
        success: false,
        manualActionRequired: true,
        message: t('errSignInBtnNotFound')
      };
    }

    signInBtn.click();
    return { success: true, manualActionRequired: false, message: t('msgSignInClicked') };
  } catch (e) {
    return { success: false, manualActionRequired: true, message: e.message };
  }
}
