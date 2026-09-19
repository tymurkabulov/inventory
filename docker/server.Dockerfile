# API, миграции и CLI — один образ, разные команды.
#
# Версия базового образа закреплена: в node:22-alpine от 19.09.2026 ломается TLS
# у npm (ERR_SSL_CIPHER_OPERATION_FAILED на загрузке пакетов). Поднимать версию —
# только проверив сборку.
FROM node:22.20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace server --include-workspace-root --ignore-scripts
COPY server server
RUN npm run build -w server

# Зависимости для прода берём из той же установки, что и сборку: второй заход
# в реестр ничего не добавлял, только шансы упасть на сети.
FROM build AS deps
RUN npm prune --omit=dev --workspace server --include-workspace-root

FROM node:22.20-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/server/dist ./dist
COPY server/package.json ./
COPY db /app/db
USER node
CMD ["node", "dist/api.js"]
