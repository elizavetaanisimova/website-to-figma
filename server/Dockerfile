# Официальный образ Playwright — Chromium и все системные зависимости уже внутри.
# Версия образа ДОЛЖНА совпадать с версией playwright в package.json.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js extract.js ./

ENV CLOUD=1
ENV PORT=4511
ENV NODE_ENV=production

EXPOSE 4511

CMD ["node", "index.js"]
