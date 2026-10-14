# Railway builds this file automatically (it always prefers a file called "Dockerfile").
FROM node:24-slim

# git is required: one of bedrock-protocol's dependencies is installed straight from GitHub.
# The "insteadOf" lines make npm download it over https (no SSH keys needed).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --global --add url."https://github.com/".insteadOf "git@github.com:" \
 && git config --global --add url."https://github.com/".insteadOf "git://github.com/"

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --ignore-scripts skips the optional native RakNet build; the bot uses the pure-JavaScript one.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src

CMD ["node", "src/index.js"]
