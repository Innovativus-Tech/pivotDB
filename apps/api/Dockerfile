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

# Copy the entire node_modules from the build stage (includes prisma CLI and
# all prod deps). Both stages use the same base image so native binaries are
# compatible. This avoids a second pnpm install and any network calls here.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

# Re-generate the Prisma client so the query-engine binary is linked against
# this stage's glibc (same image, so it's a no-op rebuild — fast and safe).
RUN node_modules/.bin/prisma generate

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
