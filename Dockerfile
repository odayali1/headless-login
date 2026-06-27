FROM node:22-bookworm-slim

# Firefox/Camoufox runtime libraries (headless in Docker)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libgtk-3-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcb-shm0 libxext6 libxrender1 libxt6 libxi6 libxss1 \
    libglib2.0-0 libdbus-1-3 libdbus-glib-1-2 libfontconfig1 libfreetype6 libegl1 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV MOZ_DISABLE_CONTENT_SANDBOX=1
ENV MOZ_DISABLE_GMP_SANDBOX=1
RUN npx camoufox-js fetch && npx playwright install chromium

ENV NODE_ENV=production
ENV PORT=3847
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data/profiles /app/screenshots

EXPOSE 3847

CMD ["node", "server.js"]
