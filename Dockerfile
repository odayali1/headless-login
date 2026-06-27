FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx camoufox-js fetch && npx playwright install chromium

ENV NODE_ENV=production
ENV PORT=3847
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data/profiles /app/screenshots

EXPOSE 3847

CMD ["node", "server.js"]
