#!/bin/bash
# Site → Figma: отключить автозапуск сервера и остановить его.

set -u

LABEL="com.sitetofigma.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UI_LABEL="com.sitetofigma.menubar"
UI_PLIST="$HOME/Library/LaunchAgents/$UI_LABEL.plist"

say() { printf '%s\n' "$*"; }

say "Site → Figma — удаление автозапуска"
say ""

# иконка в строке меню
launchctl bootout "gui/$UID/$UI_LABEL" 2>/dev/null
launchctl unload "$UI_PLIST" 2>/dev/null
pkill -f "Site to Figma.app/Contents/MacOS/SiteToFigma" 2>/dev/null
if [ -f "$UI_PLIST" ]; then
  rm -f "$UI_PLIST"
  say "✓ Иконка в строке меню убрана"
fi

# сервер
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
launchctl unload "$PLIST" 2>/dev/null

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  say "✓ Удалён $PLIST"
else
  say "· Автозапуск не был установлен"
fi

# добиваем процесс, если остался
for pid in $(lsof -t -nP -iTCP:4511 -sTCP:LISTEN 2>/dev/null); do
  kill "$pid" 2>/dev/null
done

say "✓ Сервер остановлен"
say ""
say "Логи остались в ~/Library/Logs/site-to-figma.log — удалите вручную, если не нужны."
say "Вернуть автозапуск: двойной клик по install.command"
say ""
say "Окно можно закрыть."
