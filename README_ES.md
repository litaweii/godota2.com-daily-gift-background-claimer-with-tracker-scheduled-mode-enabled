# GoDota2 Daily Claimer

Una extensión para Chrome que reclama automáticamente el bono diario (DAILY GIFT) en [godota2.com](https://godota2.com).

El sitio solo concede el bono cuando `godota2.com` aparece en tu nombre de Steam, por lo que la extensión realiza todo el proceso:

1. Añade temporalmente ` godota2.com` a tu nombre de Steam.
2. Inicia sesión en godota2.com mediante Steam OpenID cuando es necesario.
3. Abre la pestaña DAILY GIFT y pulsa OPEN DAILY.
4. Lee el importe del premio y lo guarda en el historial.
5. Restaura tu nombre original.

Todo se ejecuta en una ventana independiente del navegador en segundo plano, así que puedes seguir trabajando durante el proceso.

## Idiomas

La interfaz adopta automáticamente el idioma del navegador: **ruso**, **inglés**, **español** o **filipino**. Para los demás idiomas se utiliza el inglés.

## Instalación

La extensión debe instalarse en modo desarrollador porque no está disponible en Chrome Web Store:

1. Descarga y descomprime el archivo, o clona la carpeta completa del proyecto.
2. Abre `chrome://extensions` en Chrome o `edge://extensions` en Edge.
3. Activa el **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida** y selecciona la carpeta que contiene `manifest.json`.
5. Fija el icono de la extensión en la barra del navegador para acceder a ella fácilmente.

## Uso

1. Inicia sesión en Steam en el mismo navegador. La extensión usa tu sesión actual y nunca solicita ni almacena tu contraseña.
2. Abre la ventana emergente de la extensión y pega la URL de tu perfil de Steam, por ejemplo `https://steamcommunity.com/id/tu_nombre` o `https://steamcommunity.com/profiles/7656...`.
3. Pulsa **Reclamar**. La extensión realizará todo el proceso y mostrará el resultado.
4. El botón **Prueba** reclama el bono sin cambiar tu nombre. Úsalo si el marcador ya está presente o si solo quieres comprobar la autorización.
5. El botón **Detener** cancela el proceso y restaura automáticamente tu nombre.

### Reclamación automática programada

En la ventana emergente puedes activar la reclamación automática diaria y elegir una hora. El navegador debe estar abierto a la hora programada.

### Historial y diagnóstico

La ventana emergente muestra el importe total, el promedio, la racha y las últimas 100 reclamaciones. Si no se detecta automáticamente el premio, pulsa **Diagnóstico de saldo** para ver una captura de la página de la última reclamación.

## Advertencias importantes

- **Cambiar el nombre de Steam bloquea los intercambios durante unas 3 horas.** Cada reclamación completa cambia el nombre dos veces: al añadir el marcador y al restaurarlo. Si realizas intercambios con frecuencia, programa la reclamación para un momento en que no los necesites.
- Los nombres de Steam tienen un límite de 32 caracteres. Si el nombre no cabe con el marcador, la parte base se acorta temporalmente y se restaura por completo al finalizar.
- Si la extensión no puede restaurar el nombre, por ejemplo porque el navegador se cerró durante el proceso, terminará la restauración la próxima vez que se inicie. Como último recurso, el estado muestra el nombre original para poder restaurarlo manualmente.
- Si Steam solicita una contraseña, Steam Guard o un CAPTCHA, la extensión mostrará la ventana y esperará a que completes el inicio de sesión manualmente.
- Esta extensión no está afiliada con godota2.com ni con Valve. La automatización puede infringir las reglas del sitio; úsala bajo tu propia responsabilidad.

## Privacidad

La extensión solo envía datos a steamcommunity.com y godota2.com, los mismos sitios que visitas durante el proceso. El historial y la configuración se almacenan localmente en el navegador (`chrome.storage`). Las contraseñas nunca se leen ni se guardan.

## Estructura del proyecto

| Archivo | Función |
|---|---|
| `manifest.json` | Manifiesto de la extensión (Manifest V3) |
| `background.js` | Service worker: coordinación del proceso, programación e historial |
| `steam-content.js` | Content script para steamcommunity.com: cambio y restauración del nombre, confirmación de OpenID |
| `godota-content.js` | Content script para godota2.com: autorización, DAILY GIFT, lectura del saldo y del premio |
| `popup.html` / `popup.js` | Interfaz emergente: inicio, estado, estadísticas y programación |
| `_locales/` | Traducciones de la interfaz (en, ru, es, fil) |
