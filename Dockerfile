FROM node:22-bookworm-slim

# Firefox/Camoufox runtime + tools for downloading/extracting the browser bundle
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
# Skip postinstall fetch here — explicit retry step below (Coolify network can be flaky)
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV MOZ_DISABLE_CONTENT_SANDBOX=1
ENV MOZ_DISABLE_GMP_SANDBOX=1

# Production uses Camoufox only (proxy ON). Chromium fallback is dev/local only — skip install.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      npx camoufox-js fetch && exit 0; \
      echo "camoufox-js fetch attempt ${attempt} failed, retrying in 25s..."; \
      sleep 25; \
    done; \
    echo "camoufox-js fetch failed after 5 attempts"; \
    exit 1

ENV NODE_ENV=production
ENV PORT=3847
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data/profiles /app/screenshots /opt/camoufox

EXPOSE 3847

CMD ["node", "server.js"]
