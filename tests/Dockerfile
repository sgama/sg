FROM node:20-bookworm

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-common \
    libgconf-2-4 \
    libnss3 \
    libxss1 \
    libasound2 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome environment variables
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Lighthouse CI
RUN npm install -g @lhci/cli puppeteer

WORKDIR /app

# Check versions
RUN chromium --version && lhci --version
