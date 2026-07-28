#!/bin/bash
# Site → Figma: установка сервера как фонового приложения macOS.
# Двойной клик по этому файлу — сервер стартует сам при входе в систему
# и работает, пока компьютер включён.

set -u

LABEL="com.sitetofigma.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UI_LABEL="com.sitetofigma.menubar"
UI_PLIST="$HOME/Library/LaunchAgents/$UI_LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_OUT="$LOG_DIR/site-to-figma.log"
LOG_ERR="$LOG_DIR/site-to-figma.error.log"
PORT="${PORT:-4511}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"

say()  { printf '%s\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*"; printf '\nОкно можно закрыть.\n'; exit 1; }

say "Site → Figma — установка сервера"
say "Папка проекта: $ROOT_DIR"
say ""

# ---------- 1. Node ----------
NODE_BIN=""
for candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
[ -n "$NODE_BIN" ] || fail "Не найден Node.js. Установите его с https://nodejs.org (LTS) и запустите install.command снова."

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || fail "Нужен Node.js 18 или новее (сейчас $("$NODE_BIN" -v 2>/dev/null)). Обновите с https://nodejs.org."
say "✓ Node.js $("$NODE_BIN" -v) — $NODE_BIN"

[ -f "$SERVER_DIR/index.js" ] || fail "Не найден $SERVER_DIR/index.js — положите mac/ рядом с папкой server/."

# ---------- 2. Зависимости ----------
if [ ! -d "$SERVER_DIR/node_modules/playwright" ]; then
  say "Устанавливаю зависимости (это разово, пара минут)…"
  NPM_BIN="$(command -v npm 2>/dev/null || echo "$(dirname "$NODE_BIN")/npm")"
  [ -x "$NPM_BIN" ] || fail "Не найден npm рядом с Node.js."
  ( cd "$SERVER_DIR" && "$NPM_BIN" install --omit=dev ) || fail "npm install завершился с ошибкой."
fi
say "✓ Зависимости на месте"

# ---------- 3. Браузер ----------
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "/Applications/Microsoft Edge.app" ]; then
  if [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
    say "Google Chrome не найден — ставлю Chromium для Playwright…"
    ( cd "$SERVER_DIR" && "$NODE_BIN" node_modules/playwright/cli.js install chromium ) \
      || say "⚠️  Не удалось поставить Chromium. Установите Google Chrome — сервер подхватит его сам."
  fi
fi
say "✓ Браузер для рендеринга готов"

# ---------- 4. LaunchAgent ----------
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# снимаем прошлую версию, если была
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
launchctl unload "$PLIST" 2>/dev/null

python3 - "$PLIST" "$LABEL" "$NODE_BIN" "$SERVER_DIR" "$LOG_OUT" "$LOG_ERR" "$PORT" <<'PY'
import sys
from xml.sax.saxutils import escape

plist, label, node, workdir, out, err, port = sys.argv[1:8]
e = escape
body = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{e(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{e(node)}</string>
    <string>{e(workdir)}/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>{e(workdir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>{e(port)}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>{e(out)}</string>
  <key>StandardErrorPath</key><string>{e(err)}</string>
</dict>
</plist>
'''
open(plist, 'w', encoding='utf-8').write(body)
PY
[ -f "$PLIST" ] || fail "Не удалось создать $PLIST"

launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null
launchctl enable "gui/$UID/$LABEL" 2>/dev/null
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null

say "✓ Автозапуск сервера установлен"

# ---------- 5. Иконка в строке меню ----------
APP="$SCRIPT_DIR/Site to Figma.app"
MENUBAR_OK=""

if command -v swiftc >/dev/null 2>&1; then
  if [ ! -d "$APP" ]; then
    say "Собираю иконку для строки меню…"
    bash "$SCRIPT_DIR/build-menubar.sh" >/dev/null 2>&1 || say "⚠️  Не удалось собрать иконку — сервер это не затрагивает."
  fi
else
  say "· Xcode Command Line Tools не установлены — иконка в строке меню пропущена."
  say "  Поставить: xcode-select --install, потом запустите install.command снова."
fi

if [ -x "$APP/Contents/MacOS/SiteToFigma" ]; then
  launchctl bootout "gui/$UID/$UI_LABEL" 2>/dev/null
  pkill -f "Site to Figma.app/Contents/MacOS/SiteToFigma" 2>/dev/null

  python3 - "$UI_PLIST" "$UI_LABEL" "$APP/Contents/MacOS/SiteToFigma" "$PORT" <<'PY'
import sys
from xml.sax.saxutils import escape

plist, label, program, port = sys.argv[1:5]
e = escape
open(plist, 'w', encoding='utf-8').write(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{e(label)}</string>
  <key>ProgramArguments</key>
  <array><string>{e(program)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>{e(port)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
''')
PY

  # RunAtLoad поднимает иконку сам — отдельный `open` создал бы второй значок
  launchctl bootstrap "gui/$UID" "$UI_PLIST" 2>/dev/null || launchctl load "$UI_PLIST" 2>/dev/null
  launchctl enable "gui/$UID/$UI_LABEL" 2>/dev/null
  launchctl kickstart "gui/$UID/$UI_LABEL" 2>/dev/null
  MENUBAR_OK="1"
  say "✓ Иконка в строке меню установлена"
fi

# ---------- 6. Проверка ----------
say ""
printf 'Проверяю сервер'
OK=""
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then OK="1"; break; fi
  printf '.'
  sleep 1
done
printf '\n'

if [ -n "$OK" ]; then
  say ""
  say "✅ Готово. Сервер работает: http://127.0.0.1:$PORT"
  say "   Он запускается сам при входе в систему и живёт, пока компьютер включён."
  say ""
  if [ -n "$MENUBAR_OK" ]; then
    say "   В строке меню сверху появился значок слоёв — статус сервера,"
    say "   перезапуск, логи и выключение."
    say ""
  fi
  say "   В Figma: Plugins → Development → Site → Figma (Local)"
  say "   Логи: $LOG_OUT"
  say "   Удалить автозапуск: двойной клик по uninstall.command"
else
  say "⚠️  Сервер не ответил за 30 секунд. Последние строки лога:"
  say ""
  tail -n 20 "$LOG_ERR" 2>/dev/null
  tail -n 20 "$LOG_OUT" 2>/dev/null
fi

say ""
say "Окно можно закрыть."
