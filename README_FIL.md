# GoDota2 Daily Claimer

Isang Chrome extension na awtomatikong kumukuha ng araw-araw na bonus (DAILY GIFT) sa [godota2.com](https://godota2.com).

Ibinibigay lamang ng website ang bonus kapag kasama ang `godota2.com` sa iyong Steam name, kaya ang extension ang gumagawa ng buong proseso:

1. Pansamantalang idinaragdag ang ` godota2.com` sa iyong Steam name.
2. Nagla-log in sa godota2.com gamit ang Steam OpenID. Kung may bukas nang session sa site, nire-refresh ng extension ang profile gamit ang `?update` (nananatili ang session at mga taya) — kung hindi, hindi makikita ng site ang marker sa pangalan mo. Kung tatanggihan pa rin ng site ang pagkolekta, magsa-sign in ulit ang extension sa Steam at susubukan muli.
3. Binubuksan ang DAILY GIFT tab at pinipindot ang OPEN DAILY.
4. Binabasa ang halaga ng premyo at sine-save ito sa history.
5. Ibinabalik ang orihinal mong pangalan.

Ang lahat ay tumatakbo sa hiwalay na background window ng browser, kaya maaari kang magpatuloy sa trabaho habang kinukuha ang bonus.

## Mga wika

Awtomatikong sumusunod ang interface sa wika ng browser: **Russian**, **English**, **Spanish**, o **Filipino**. English ang ginagamit para sa lahat ng iba pang wika.

## Pag-install

Kailangang i-install ang extension sa developer mode dahil wala ito sa Chrome Web Store:

1. I-download at i-extract ang archive, o i-clone ang buong project folder.
2. Buksan ang `chrome://extensions` sa Chrome o `edge://extensions` sa Edge.
3. I-enable ang **Developer mode**.
4. I-click ang **Load unpacked** at piliin ang folder na naglalaman ng `manifest.json`.
5. I-pin ang icon ng extension sa browser toolbar para madaling mabuksan.

## Paggamit

1. Mag-sign in sa Steam sa parehong browser. Ginagamit ng extension ang kasalukuyan mong session at hindi nito hinihingi o sine-save ang iyong password.
2. Buksan ang popup ng extension at ilagay ang URL ng iyong Steam profile, halimbawa `https://steamcommunity.com/id/iyong_pangalan` o `https://steamcommunity.com/profiles/7656...`.
3. I-click ang **Claim**. Gagawin ng extension ang buong proseso at ipapakita ang resulta.
4. Kinukuha ng **Test** button ang bonus nang hindi binabago ang iyong pangalan. Gamitin ito kung nasa pangalan na ang marker o kung gusto mo lamang subukan ang authorization.
5. Kinakansela ng **Stop** button ang proseso at awtomatikong ibinabalik ang iyong pangalan.

### Naka-iskedyul na awtomatikong pag-claim

Maaari mong i-enable ang araw-araw na awtomatikong pag-claim at pumili ng oras sa popup. Kailangang nakabukas ang browser sa nakatakdang oras.

### History at diagnostics

Ipinapakita ng popup ang kabuuang halaga, average, streak, at huling 100 claim. Kung hindi awtomatikong matukoy ang halaga ng premyo, i-click ang **Balance diagnostics** upang makita ang snapshot ng page mula sa pinakahuling claim.

## Mahahalagang babala

- **Ang pagpapalit ng Steam name ay nagba-block ng trades nang humigit-kumulang 3 oras.** Dalawang beses binabago ng bawat buong claim ang pangalan: sa pagdagdag ng marker at sa pagpapanumbalik nito. Kung madalas kang makipag-trade, magtakda ng oras kung kailan hindi mo kailangan ang trades.
- Hanggang 32 character lamang ang Steam name. Kung hindi kasya ang pangalan kasama ang marker, pansamantalang paiikliin ang pangunahing bahagi nito at ibabalik nang buo pagkatapos ng claim.
- Kung hindi maibalik ng extension ang pangalan, halimbawa dahil isinara ang browser habang tumatakbo ang proseso, tatapusin nito ang rollback sa susunod na pagbukas ng browser. Bilang huling paraan, ipinapakita ng status ang orihinal na pangalan upang maibalik ito nang manu-mano.
- Kung humingi ang Steam ng password, Steam Guard, o CAPTCHA, ipapakita ng extension ang window at maghihintay hanggang makumpleto mo nang manu-mano ang pag-sign in.
- Hindi konektado ang extension na ito sa godota2.com o Valve. Maaaring labagin ng automation ang mga patakaran ng website; gamitin ito sa sarili mong pananagutan.

## Privacy

Nagpapadala lamang ang extension ng data sa steamcommunity.com at godota2.com, ang parehong mga website na binibisita mo habang tumatakbo ang proseso. Lokal na naka-store sa browser (`chrome.storage`) ang claim history at settings. Hindi kailanman binabasa o sine-save ang mga password.

## Istruktura ng proyekto

| File | Gamit |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker: pamamahala ng proseso, schedule, at history |
| `steam-content.js` | Content script para sa steamcommunity.com: pagbabago at pagpapanumbalik ng pangalan, OpenID confirmation |
| `godota-content.js` | Content script para sa godota2.com: authorization, DAILY GIFT, pagbasa ng balance at premyo |
| `popup.html` / `popup.js` | Popup interface: pagsisimula, status, statistics, at schedule |
| `_locales/` | Mga salin ng interface (en, ru, es, fil) |
