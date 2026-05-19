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

# Install mongodump / mongorestore (mongodb-database-tools)
RUN apt-get update && apt-get install -y wget gnupg curl && \
  wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | apt-key add - && \
  echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
  apt-get update && \
  apt-get install -y mongodb-database-tools && \
  rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --no-frozen-lockfile --unsafe-perm

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3001

CMD ["node", "dist/index.js"]

# ---- Development stage ----
FROM node:20-bookworm-slim AS development

WORKDIR /app

# Install mongodump / mongorestore (mongodb-database-tools)
RUN apt-get update && apt-get install -y wget gnupg curl && \
  wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | apt-key add - && \
  echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
  apt-get update && \
  apt-get install -y mongodb-database-tools && \
  rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

COPY . .

EXPOSE 3001

CMD ["pnpm", "dev"]
