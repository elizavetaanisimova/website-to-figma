# Публикация в Figma Community

Порядок: 1) репозиторий на GitHub → 2) сервер в облако → 3) прописать его адрес
в плагине → 4) отправить плагин на ревью.

Тексты карточки и теги внизу — они собраны не на глаз, а по разбору выдачи Figma
Community. Логика решений записана в разделе «Почему тексты такие».

---

## Шаг 1. Репозиторий

Репозиторий: `elizavetaanisimova/website-to-figma`.

**Description** (Settings → About) — его показывает и GitHub, и Google:

```
Import any website into editable Figma layers — frames, text, images, vectors and Auto Layout. Free website to Figma / HTML to Figma importer with a self-hosted renderer.
```

**Topics:** `figma-plugin` · `figma` · `website-to-figma` · `html-to-figma`
· `url-to-figma` · `design-tools` · `playwright` · `web-scraping` · `figma-import`

Лицензия — `LICENSE` в корне: код открыт для чтения и запуска, переиздавать копию
в Community нельзя.

---

## Шаг 2. Сервер в облако

Без облачного сервера плагин на ревью не пройдёт. Правила Figma прямо запрещают
требовать от пользователя установки отдельных пакетов, а принципы безопасности —
ходить по HTTP. Плагин, который сразу после установки работает по HTTPS с общим
сервером, обе претензии снимает; свой сервер остаётся опцией для сайтов за логином
и для тех, кому нужен безлимит.

Режим включается переменной `CLOUD=1` — вместе с ней поднимаются лимиты запросов,
защита от обращений к внутренним адресам и отключается режим «за логином».

### Вариант A — Oracle Cloud Always Free ($0)

Отдельная инструкция: [DEPLOY-ORACLE.md](DEPLOY-ORACLE.md). Виртуалка ARM с 24 ГБ
памяти навсегда бесплатно, docker-compose и Caddy с автоматическим HTTPS уже
описаны в `deploy/`. Дольше в настройке, дальше — бесплатно.

### Вариант B — Railway (~$5/мес, всё через сайт)

1. **New Project → Deploy from GitHub repo** → выберите репозиторий.
2. **Root Directory** = `server` (Dockerfile Railway найдёт сам).
3. Variables: `CLOUD=1`. Порт Railway подставит сам, сервер его читает.
4. **Settings → Networking → Generate Domain**.
5. Проверка: `https://ваш-адрес/health` должен вернуть `"cloud":true`.

### Вариант C — Fly.io (доллары в месяц)

```bash
brew install flyctl
cd figma-site-importer/server
fly auth signup
fly launch --copy-config --no-deploy   # имя приложения поменяйте на уникальное
fly deploy
```

`fly.toml` готов, машины останавливаются на простое.

### Вариант D — свой VPS

```bash
docker build -t website-to-figma ./server
docker run -d -p 4511:4511 -e CLOUD=1 --restart unless-stopped website-to-figma
```

HTTPS обязателен (Caddy или nginx + certbot): Figma не пустит плагин на голый http,
кроме localhost.

`RATE_LIMIT` (импортов в час с одного адреса, по умолчанию 20) и `MAX_CONCURRENT`
(параллельных рендеров, по умолчанию 2) настраиваются переменными. Для старта хватит
1 ГБ памяти.

---

## Шаг 3. Адрес сервера в плагине

В `plugin/ui.html`:

```js
const DEFAULT_SERVER = 'http://127.0.0.1:4511';
```

заменить на облачный адрес:

```js
const DEFAULT_SERVER = 'https://ваш-адрес';
```

Свой сервер пользователь пропишет в «Дополнительно» — там же, где включается режим
«Сайт за логином», недоступный в облаке.

---

## Шаг 4. Отправка на ревью

1. Figma (desktop) → **Plugins → Development → ваш плагин → Publish…**
2. Заполнить карточку текстами ниже. Картинки в `assets/`: `icon.png` (128×128),
   `cover.png` (1920×960 — **проверьте, Figma просит 1920×1080**).
3. **Publisher profile** — один раз: имя и аватар.
4. **Support contact** — почта.
5. **Submit for review.** Ревью занимает от нескольких дней до пары недель.

---

## Тексты карточки

### Name

```
Website to Figma — HTML to Figma, URL to Figma — Import any site into editable layers (free)
```

92 символа. Самое длинное имя, встреченное в выдаче, — ровно 100, так что запас есть.

### Tagline

```
Import any website into editable Figma layers — frames, text, images, vectors. Free, no limits.
```

### Description

```
Paste a URL. Get the page back as layers you can actually edit — frames, text in the
right fonts, images, SVG vectors, gradients, shadows. Not a screenshot, not a flattened
image sitting in a frame.

A free website to Figma importer: HTML to Figma, URL to Figma, one page or a whole site,
with no cap on how much you bring across.

WHAT COMES ACROSS

• Auto Layout — flex containers arrive as real auto-layout frames with gap, padding and
  alignment. Where the layout does not survive a check against the real coordinates, the
  layer keeps its exact position rather than a plausible-looking wrong one.
• A whole site, not one page — the plugin reads the sitemap, or follows internal links
  when there is none, lists every page it found, and imports the ones you tick. Each page
  lands in its own row of frames.
• Several devices at once — 1440, 1280, 768, 390, or a width you type. Every variant
  imports side by side.
• Light and dark — prefers-color-scheme is emulated, so both themes can come in one run.
• Color and text styles built from the site's own palette and typography.
• A locked reference screenshot beside the import, for checking pixel by pixel.
• webp and avif converted on the way in, SVG icons imported as vectors, lazy images
  scrolled into view before capture.

WHAT PEOPLE USE IT FOR

Redesigning a site that already exists. Building a competitor board out of live pages
instead of screenshots. Pulling production pages back into a design file. Taking a
landing page apart to see how it was put together.

SITES BEHIND A LOGIN

Run the renderer on your own machine and a real Chrome window opens. Sign in, click
through to the page you need, then import exactly what you are looking at — session,
cookies and all. This is how you get web apps, paywalled articles and anything guarded
by Cloudflare.

HOW IT WORKS

The plugin sends a URL to a renderer, which opens the page in real Chrome, reads the
computed style of every element, and hands the result back as layers. A shared renderer
is already running, so the plugin works the moment you install it — nothing to set up.
You can also run your own in one command and import as much as you want; the source is
on GitHub.

Как перенести сайт в фигму: вставьте ссылку — плагин скопирует сайт в Figma
редактируемыми слоями, с Auto Layout, тёмной темой и несколькими устройствами сразу.
Импорт сайта в Figma бесплатно и без лимитов.

FREE, AND STAYING FREE

No account, no import quota, no trial that runs out. If it saved you an afternoon, you
can send USDT on the TON network:
UQBz8oG02Va5OnCUw5mZ7sIUhxcqqWrTwIDlMqqt8Ca0jWbL
USDT on TON only — TRC20, ERC20 or anything else sent to this address is lost.
```

### Category и теги

**Category:** Design tools → **Import & export**.

**Кураторские подкатегории:** отметить **HTML** и **Web**. Это не косметика — они
ведут на страницы `/community/import-export/html` и `/web`, где плагины листают
руками. **html.to.design не выбрал ни одной**, так что на этих страницах его просто
нет.

**Пять своих тегов** — все фразой целиком, не одиночными словами:

```
#html to figma
#website to figma
#url to figma
#import website
#site to figma
```

**Ссылка на сайт плагина:** адрес репозитория на GitHub.

---

## Почему тексты такие

Разбор живой выдачи Figma Community, июль 2026. Что подтвердилось на замерах:

**Совпадение по тексту сильнее популярности.** По запросу `url to figma` плагин
Vellum с 23 пользователями стоит на пятом месте, а html.to.design с 2,53 млн — на
пятнадцатом. Популярность работает как решающий голос внутри группы одинаково
релевантных, а не как самостоятельный фактор.

**Описание индексируется.** В справке Figma сказано про поиск по имени, тегам и
хэндлу, но запрос `moodboard benchmark` находит html.to.design, у которого этих слов
нет ни в имени, ни в теглайне, ни в тегах — только в глубине описания. Поэтому
ключевые фразы вплетены в живые предложения, а не свалены списком в подвал.

**Точная фраза в теге — самый дешёвый рычаг.** CodeTea с 18,6 тыс. пользователей
держит первое место по `url to figma` благодаря тегу `#url to figma`. Теги
многословные, и почти все листинги используют ровно пять, хотя в справке говорится
про двенадцать.

**У лидера дыра ровно там, где нам надо.** В имени html.to.design нет
последовательности «html to figma», и по этому запросу его нет в первых 23
результатах. Это самый частотный запрос в теме.

**Русский внутри Community пуст.** `сайт в фигму` → 0 плагинов, `перенести сайт` → 1,
и тот про мудборды. Русская фраза в описании стоит там намеренно и содержит
формулировки, которые люди реально набирают: «перенести сайт в фигму», «импорт сайта
в Figma». Рынок маленький, конкурентов нет вообще.

**Чего в текстах намеренно нет:** имени html.to.design. Правила Figma его не
запрещают, но чужие торговые марки разбираются по жалобе, и решение остаётся
целиком на усмотрении Figma. Ставить чужой бренд в название ради трафика — рискнуть
листингом.

---

## После публикации

- **Нагрузка.** Облачный сервер станет узким местом первым: поднимайте
  `MAX_CONCURRENT` и память или добавляйте вторую машину.
- **Стоимость.** Oracle Always Free — $0, Railway Hobby ~$5/мес, Fly.io с автостопом —
  доллары. Если станет дорого, в описании уже сказано, что сервер можно поднять свой.
- **Злоупотребления.** Лимит 20 импортов в час с адреса включён; при желании
  добавляются API-ключи.
- **Обновления.** Правки в `plugin/*` → «Publish new release». Обновления сервера
  пользователей не касаются, просто передеплойте.
- **Продавать плагин не выйдет,** даже если захочется: Figma не пускает новых
  продавцов в платные ресурсы Community. Донат остаётся единственным вариантом.
