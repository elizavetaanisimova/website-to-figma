#!/usr/bin/env bash
# Настройка сервера Site to Figma на свежей Ubuntu-виртуалке (Oracle Cloud Always Free).
# Запуск на виртуалке:
#   curl -fsSL https://raw.githubusercontent.com/miro-creator-site/site-to-figma/main/deploy/oracle-setup.sh | bash
set -euo pipefail

echo "== Site to Figma: установка сервера =="

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "-- Ставлю Docker…"
  curl -fsSL https://get.docker.com | sudo sh
fi

# 2. Открываем порты 80/443 (образы Oracle по умолчанию режут всё, кроме SSH)
echo "-- Открываю порты 80 и 443…"
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT || true
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save || true
fi

# 3. Код
cd "$HOME"
if [ ! -d site-to-figma ]; then
  echo "-- Клонирую репозиторий…"
  sudo apt-get install -y git >/dev/null 2>&1 || true
  git clone https://github.com/miro-creator-site/site-to-figma.git
fi
cd site-to-figma/deploy

# 4. Домен
if [ ! -f .env ]; then
  read -rp "Введите домен (например, mysite.duckdns.org): " DOMAIN
  echo "DOMAIN=${DOMAIN}" > .env
fi
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)

# 5. Запуск
echo "-- Собираю и запускаю (первый раз ~5 минут)…"
sudo docker compose up -d --build

echo ""
echo "== Готово =="
echo "Проверка:  https://${DOMAIN}/health"
echo "Логи:      sudo docker compose logs -f app"
echo "Обновить:  cd ~/site-to-figma && git pull && cd deploy && sudo docker compose up -d --build"
