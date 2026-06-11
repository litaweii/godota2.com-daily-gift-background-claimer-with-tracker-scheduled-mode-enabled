# GoDota2 Daily Claimer

A Chrome extension that automatically claims the daily bonus (DAILY GIFT) on [godota2.com](https://godota2.com).

The website only grants the bonus when `godota2.com` appears in your Steam name, so the extension handles the entire process:

1. Temporarily adds ` godota2.com` to your Steam name.
2. Signs in to godota2.com through Steam OpenID when needed.
3. Opens the DAILY GIFT tab and clicks OPEN DAILY.
4. Reads the prize amount and saves it to the history.
5. Restores your original name.

Everything runs in a separate background browser window, so you can continue working while the claim is in progress.

## Languages

The interface automatically follows your browser language: **Russian**, **English**, **Spanish**, or **Filipino**. English is used as the fallback for all other languages.

## Installation

The extension must be installed in developer mode because it is not available in the Chrome Web Store:

1. Download and extract the archive, or clone the entire project folder.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the extension icon to the browser toolbar for easy access.

## Usage

1. Sign in to Steam in the same browser. The extension uses your current session and never requests or stores your password.
2. Open the extension popup and paste your Steam profile URL, such as `https://steamcommunity.com/id/your_name` or `https://steamcommunity.com/profiles/7656...`.
3. Click **Claim**. The extension will run the full process and display the result.
4. The **Test** button claims the bonus without changing your name. Use it when the marker is already present or when you only want to verify authorization.
5. The **Stop** button cancels the process and automatically restores your name.

### Scheduled automatic claims

You can enable daily automatic claims and select a time in the popup. The browser must be running at the scheduled time.

### History and diagnostics

The popup shows the total amount, average, streak, and the latest 100 claims. If the prize amount cannot be detected automatically, click **Balance diagnostics** to view a snapshot of the page from the latest claim.

## Important warnings

- **Changing your Steam name blocks trades for approximately 3 hours.** Each full claim changes the name twice: once to add the marker and once to restore it. If you trade actively, schedule claims for a time when you do not need to trade.
- Steam names are limited to 32 characters. If the name does not fit with the marker, its base part is temporarily shortened and fully restored after the claim.
- If the extension cannot restore the name, for example because the browser was closed during the process, it will finish the rollback on the next browser launch. As a last resort, the status displays the original name so it can be restored manually.
- If Steam requests a password, Steam Guard confirmation, or CAPTCHA, the extension displays the window and waits for you to complete the sign-in manually.
- This extension is not affiliated with godota2.com or Valve. Automation may violate the website's rules; use it at your own risk.

## Privacy

The extension sends data only to steamcommunity.com and godota2.com, the same websites you visit during the process. Claim history and settings are stored locally in the browser (`chrome.storage`). Passwords are never read or stored.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker: process orchestration, scheduling, and history |
| `steam-content.js` | Content script for steamcommunity.com: name changes, rollback, and OpenID confirmation |
| `godota-content.js` | Content script for godota2.com: authorization, DAILY GIFT interaction, balance and prize reading |
| `popup.html` / `popup.js` | Popup interface: start, status, statistics, and schedule |
| `_locales/` | Interface translations (en, ru, es, fil) |
