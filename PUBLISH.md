# Публикация плагина в Figma Community

План: 1) выложить код на GitHub → 2) задеплоить сервер в облако → 3) прописать адрес
сервера в плагине → 4) опубликовать плагин в Community.

---

## Шаг 1. GitHub

1. Создайте репозиторий (например, `site-to-figma`) на github.com.
2. Из папки `figma-site-importer`:
   ```bash
   git init
   git add .
   git commit -m "Site to Figma plugin + renderer server"
   git branch -M main
   git remote add origin https://github.com/ВАШ_ЛОГИН/site-to-figma.git
   git push -u origin main
   ```

GitHub нужен и для деплоя (Railway тянет код оттуда), и как «сайт» плагина для карточки.

---

## Шаг 2. Деплой сервера в облако

Сервер уже готов к облаку: `Dockerfile` в папке `server/`, режим включается переменной
`CLOUD=1` (лимиты запросов, защита от обращений к внутренним адресам, отключение
режима «за логином» — всё автоматически).

### Вариант A — Railway (проще всего, всё через сайт)

1. Зарегистрируйтесь на railway.com (план Hobby ~$5/мес).
2. **New Project → Deploy from GitHub repo** → выберите репозиторий.
3. В настройках сервиса: **Root Directory** = `server` (Railway сам найдёт Dockerfile).
4. Variables: `CLOUD=1` (PORT Railway подставит сам — сервер его читает).
5. **Settings → Networking → Generate Domain** — получите адрес вида
   `https://site-to-figma-production.up.railway.app`.
6. Проверьте: откройте `https://ваш-адрес/health` — должно вернуться
   `"cloud":true`.

### Вариант B — Fly.io (дешевле, через терминал)

```bash
brew install flyctl
cd figma-site-importer/server
fly auth signup
fly launch --copy-config --no-deploy   # имя приложения поменяйте на уникальное
fly deploy
```
Конфиг `fly.toml` уже готов (автостоп машин — когда никто не пользуется, не платите).
Адрес будет `https://ваше-имя.fly.dev`.

### Вариант C — свой VPS

```bash
docker build -t site-to-figma ./server
docker run -d -p 4511:4511 -e CLOUD=1 --restart unless-stopped site-to-figma
```
Обязательно поставьте перед ним HTTPS (Caddy/nginx + certbot): Figma в браузере
не даст плагину ходить по голому http (кроме localhost).

**Важно:** переменные `RATE_LIMIT` (импортов в час с IP, по умолчанию 20) и
`MAX_CONCURRENT` (параллельных рендеров, по умолчанию 2) можно менять. Для старта
хватит машины с 1 GB RAM.

---

## Шаг 3. Прописать адрес сервера в плагине

В файле `plugin/ui.html` найдите строку:

```js
const DEFAULT_SERVER = 'http://127.0.0.1:4511';
```

и замените на ваш облачный адрес:

```js
const DEFAULT_SERVER = 'https://ваш-адрес.up.railway.app';
```

Пользователи смогут переключиться на свой локальный сервер в «Дополнительно»
(например, ради режима «Сайт за логином» — в облаке он автоматически скрыт).

---

## Шаг 4. Публикация в Figma Community

1. Откройте Figma (desktop), меню **Plugins → Development → ваш плагин → Publish…**
   (плагин должен быть импортирован через Import plugin from manifest).
2. Заполните карточку — готовые тексты ниже, картинки в папке `assets/`:
   - **Icon**: `assets/icon.png` (128×128)
   - **Cover art**: `assets/cover.png` (1920×960)
3. **Publisher profile** — заполняется один раз (имя, аватар).
4. **Support contact** — ваша почта.
5. Нажмите **Submit for review**. Модерация Figma обычно занимает от пары дней
   до ~2 недель. Ревьюеры увидят `networkAccess` из манифеста — причина уже
   вписана в поле `reasoning`.
6. После одобрения плагин появится в Community — любой сможет установить бесплатно.
   Обновления публикуются той же кнопкой (**Publish new release**).

### Готовые тексты для карточки (на английском)

**Name**
```
Site to Figma
```

**Tagline** (короткий слоган)
```
Import any website into editable Figma layers — free
```

**Description**
```
Import any website into editable Figma layers — just paste a URL. A free, open-source
website-to-Figma importer: convert HTML to design, turn any web page into frames,
text, images and vectors you can actually edit. No subscription, no import limits.

WHAT YOU GET
• Real layers: frames, text, images, vectors — not a screenshot
• Auto Layout: flex containers become proper auto-layout frames with gaps, padding and alignment
• Multiple devices at once: desktop, laptop, tablet, phone or any custom width
• Light & dark theme import (prefers-color-scheme emulation)
• Color and text styles generated from the site's palette and typography
• Pixel-perfect reference screenshot placed next to the import
• SVG icons imported as vectors, webp/avif images converted automatically
• Full-page capture with lazy-load scrolling

PERFECT FOR
• Redesigning an existing website — import it and start editing
• Building a moodboard or competitor analysis from live sites
• Turning your production pages back into design files
• Learning how a landing page is built, layer by layer

BEHIND-LOGIN SITES
Run the open-source renderer locally (one command) and a real browser window opens —
sign in, navigate anywhere, then import the exact page you see. Great for web apps,
paywalled pages and sites behind Cloudflare.

HOW IT WORKS
The plugin talks to a renderer service that opens the page in a real Chrome browser,
reads the computed styles of every element and returns them as Figma layers.
A shared instance is preconfigured — or self-host it with one command
(open source, MIT): see the GitHub link below.

No accounts. No import limits on your own server. Your pages never leave
your machine when self-hosting.

SUPPORT THE PROJECT
The plugin is completely free. If it saved you time, you can support development
with a donation — USDT on the TON network only:
UQBz8oG02Va5OnCUw5mZ7sIUhxcqqWrTwIDlMqqt8Ca0jWbL
(Send only USDT and only on the TON network. TRC20, ERC20 or other
networks/assets will be lost.)

Keywords: website to figma, html to figma, url to figma, import website, web page
import, site to design, convert html to design, figma website importer.
```

**Tags / категория**: Import, Website, HTML, Development / «Design tools».
По тегам и тексту описания работает поиск Figma Community — фразы вроде
«website to figma», «html to figma», «import website» уже вшиты в описание выше.

**Ссылка на сайт плагина**: адрес вашего GitHub-репозитория.

### SEO для GitHub-репозитория (тоже находят через поиск)

- **Description репозитория** (Settings → About):
  `Free open-source Figma plugin: import any website into editable Figma layers with Auto Layout. Website to Figma / HTML to Figma importer.`
- **Topics**: `figma-plugin`, `figma`, `website-to-figma`, `html-to-figma`,
  `design-tools`, `playwright`, `web-scraping`, `url-to-design`, `import`
- README уже содержит ключевые слова на русском и английском — GitHub и Google
  индексируют его текст.

---

## Что учесть после публикации

- **Нагрузка**: если плагином начнут пользоваться массово, облачный сервер станет
  узким местом — поднимайте `MAX_CONCURRENT` и память, или добавьте вторую машину.
- **Стоимость**: Railway Hobby ~$5/мес, Fly.io с автостопом — доллары в месяц.
  Если станет дорого — в описании плагина уже написано, что можно самохоститься.
- **Злоупотребления**: лимит 20 импортов/час на IP уже включён; при желании
  добавьте API-ключи.
- **Обновления плагина**: правите `plugin/*` → в Figma «Publish new release».
  Обновления сервера пользователей не касаются — просто передеплойте.
