# ---- Build stage ----
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile --unsafe-perm

COPY . .
RUN pnpm run db:generate
RUN pnpm exec tsc

# ---- Production stage ----
FROM node:20-bookworm-slim AS production

WORKDIR /app

# Install mongodump / mongorestore (mongodb-database-tools).
# Notes:
#   - Debian's repo component is `main`, NOT `multiverse` (that's Ubuntu).
#   - `apt-key` is deprecated in Debian 12; use a keyring file + signed-by instead.
RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
  install -d -m 0755 /etc/apt/keyrings && \
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
    | gpg --dearmor -o /etc/apt/keyrings/mongodb-server-7.0.gpg && \
  echo "deb [ arch=amd64,arm64 signed-by=/etc/apt/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends mongodb-database-tools && \
  rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --no-frozen-lockfile --unsafe-perm

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

# Re-generate Prisma client in the production stage so the binary is built
# against this stage's glibc and pnpm's node_modules layout is correct.
# prisma CLI is a devDep so not present after --prod install; add it
# temporarily, generate, then remove it to keep the image lean.
RUN pnpm add prisma --save-dev --no-frozen-lockfile && \
    pnpm exec prisma generate && \
    pnpm remove prisma

EXPOSE 3001

CMD ["node", "dist/index.js"]

# ---- Development stage ----
FROM node:20-bookworm-slim AS development

WORKDIR /app

# Install mongodump / mongorestore (mongodb-database-tools).
# Notes:
#   - Debian's repo component is `main`, NOT `multiverse` (that's Ubuntu).
#   - `apt-key` is deprecated in Debian 12; use a keyring file + signed-by instead.
RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
  install -d -m 0755 /etc/apt/keyrings && \
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
    | gpg --dearmor -o /etc/apt/keyrings/mongodb-server-7.0.gpg && \
  echo "deb [ arch=amd64,arm64 signed-by=/etc/apt/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends mongodb-database-tools && \
  rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

COPY . .

EXPOSE 3001

CMD ["pnpm", "dev"]
