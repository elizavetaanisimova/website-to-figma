# Бесплатный сервер на Oracle Cloud Always Free

> Для работы на своём компьютере облако не нужно — хватит `mac/install.command`
> (см. [mac/README.md](mac/README.md)). Эта инструкция нужна для **публикации плагина
> в Figma Community**: там требуется общий сервер по HTTPS, к которому плагин обращается
> сразу после установки. Oracle Always Free — единственный из вариантов, который стоит $0.
> Остальные варианты перечислены в [PUBLISH.md](PUBLISH.md).

Итог: виртуалка с 4 ARM-ядрами и 24 GB RAM — бесплатно навсегда, сервер работает
быстро и без «засыпаний». Настройка ~40–60 минут, из них большая часть — регистрация.

## Шаг 1. Регистрация Oracle Cloud (~15 минут)

1. Откройте **oracle.com/cloud/free** → **Start for free**.
2. Заполните данные. **Home Region** выбирайте с запасом ARM-мощностей и поближе:
   `Germany Central (Frankfurt)`, `Netherlands Northwest (Amsterdam)` или
   `Sweden Central (Stockholm)`. Регион потом сменить нельзя.
3. Понадобится банковская карта для верификации (спишут и вернут ~1 $).
   Пока вы на Free-аккаунте, платные ресурсы физически нельзя создать.
4. Дождитесь письма о создании аккаунта и войдите в консоль **cloud.oracle.com**.

## Шаг 2. SSH-ключ на вашем Mac (2 минуты)

В Терминале на Mac:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/oracle -N ""
cat ~/.ssh/oracle.pub
```

Скопируйте выведенную строку (`ssh-ed25519 AAAA…`) — она понадобится на шаге 3.

## Шаг 3. Создание виртуалки (~10 минут)

1. В консоли Oracle: меню ☰ → **Compute → Instances → Create instance**.
2. Name: `website-to-figma`.
3. **Image and shape → Edit**:
   - Image: **Ubuntu 24.04** (важно: вариант **aarch64/ARM**);
   - Shape: **Ampere → VM.Standard.A1.Flex**, поставьте **4 OCPU / 24 GB**
     (это максимум Always Free; можно 2/12 — тоже хватит).
4. **Add SSH keys → Paste public keys** → вставьте ключ из шага 2.
5. Networking оставьте по умолчанию (создастся VCN), но убедитесь, что стоит
   галка **Assign a public IPv4 address**.
6. **Create**. Через минуту-две статус станет Running — скопируйте **Public IP**.

> **«Out of capacity»?** Частая история с бесплатными ARM. Что помогает:
> попробовать другой Availability Domain (AD-1/2/3), уменьшить до 2 OCPU / 12 GB,
> повторить в другое время суток. Мощность можно поднять позже
> (Instance → Edit → Shape).

## Шаг 4. Открыть порты 80/443 в облачном фаерволе (5 минут)

1. Instance → вкладка **Networking** → кликните её **Subnet** → **Security Lists**
   → откройте Default Security List.
2. **Add Ingress Rules** — добавьте два правила:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **80**
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **443**

## Шаг 5. Бесплатный домен DuckDNS (5 минут)

HTTPS-сертификату нужен домен. Бесплатно:

1. Зайдите на **duckdns.org**, войдите через GitHub.
2. Придумайте поддомен (например `website-to-figma`) → **add domain**.
3. В поле **current ip** вставьте Public IP виртуалки → **update ip**.

Ваш домен: `website-to-figma.duckdns.org` (дальше подставляйте свой).

## Шаг 6. Установка сервера — один скрипт (~10 минут)

С Mac подключитесь к виртуалке:

```bash
ssh -i ~/.ssh/oracle ubuntu@ПУБЛИЧНЫЙ_IP
```

И запустите установщик:

```bash
curl -fsSL https://raw.githubusercontent.com/elizavetaanisimova/website-to-figma/main/deploy/oracle-setup.sh | bash
```

Скрипт поставит Docker, откроет порты, склонирует репозиторий, спросит ваш домен
и поднимет два контейнера: сервер рендеринга и Caddy (он сам получит и будет
продлевать HTTPS-сертификат Let's Encrypt).

## Шаг 7. Проверка

В браузере на Mac откройте:

```
https://ВАШ-ДОМЕН.duckdns.org/health
```

Должно вернуться `{"ok":true, …, "cloud":true}`. Всё — пришлите этот адрес,
и я впишу его в плагин как сервер по умолчанию.

## Обслуживание

| Что | Команда (по SSH на виртуалке) |
| --- | --- |
| Логи сервера | `cd ~/website-to-figma/deploy && sudo docker compose logs -f app` |
| Обновить до свежего кода | `cd ~/website-to-figma && git pull && cd deploy && sudo docker compose up -d --build` |
| Перезапустить | `cd ~/website-to-figma/deploy && sudo docker compose restart` |
| Поменять лимиты | отредактировать `deploy/docker-compose.yml` (RATE_LIMIT, MAX_CONCURRENT) и перезапустить |
| Личный обход лимита | задать `RATE_BYPASS` (секрет) в `deploy/docker-compose.yml`, перезапустить и вписать тот же секрет в плагине: Дополнительно → «Токен доступа» |

Контейнеры стартуют сами после перезагрузки виртуалки (`restart: unless-stopped`).
