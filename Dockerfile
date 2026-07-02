FROM node:22-bookworm-slim

# Firefox/Camoufox runtime libraries (browser binary installed at container start, not build)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 xz-utils \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libgtk-3-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcb-shm0 libxext6 libxrender1 libxt6 libxi6 libxss1 \
    libglib2.0-0 libdbus-1-3 libdbus-glib-1-2 libfontconfig1 libfreetype6 libegl1 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# Do not use --ignore-scripts: better-sqlite3 needs its install script for the native .node binary
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3847
ENV DATA_DIR=/app/data
# Persisted on Coolify volume — survives redeploys; downloaded once on first start
ENV CAMOUFOX_INSTALL_DIR=/app/data/camoufox
ENV PLAYWRIGHT_BROWSERS_PATH=/app/data/playwright
ENV MOZ_DISABLE_CONTENT_SANDBOX=1
ENV MOZ_DISABLE_GMP_SANDBOX=1
ENV NODE_OPTIONS=--max-old-space-size=1024

RUN mkdir -p /app/data/profiles /app/screenshots

EXPOSE 3847

CMD ["node", "server.js"]
