FROM node:24-bookworm-slim AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release \
  && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY . .
RUN npm run build

FROM base AS runner

ENV NODE_ENV=production \
  PORT=3000 \
  UI_HOST=0.0.0.0 \
  AZURE_CERT_GUI_DB_PATH=/tmp/azure-cert-gui.sqlite

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod +x ./docker/entrypoint.sh \
  && mkdir -p /app/data \
  && chown -R node:node /app/data /app/.next

USER node
EXPOSE 3000

ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["sh", "-c", "node node_modules/next/dist/bin/next start -p \"${PORT:-3000}\" -H \"${UI_HOST:-0.0.0.0}\""]
