# Stage 1: Build
FROM node:22-alpine AS builder

# Install build dependencies for native modules (e.g. bcrypt)
RUN apk upgrade --no-cache \
    && apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build the application
RUN npm run build

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install build dependencies again for potential native module rebuilds in prod deps
RUN apk upgrade --no-cache \
    && apk add --no-cache --virtual .build-deps python3 make g++

RUN npm ci --omit=dev

# Keep the migration CLI and config in the final image for pre-rollout deploys.
RUN test -x ./node_modules/.bin/prisma

# Copy built assets from builder
COPY --from=builder /app/dist ./dist

# Copy the generated Prisma Client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Remove build dependencies to keep image light
RUN apk del .build-deps \
    && npm cache clean --force

# PM2 is a runtime tool, not an application dependency. Pin it so the image is
# reproducible and the in-process metrics exporter never needs a legacy PM2.
RUN npm install pm2@7.0.4 -g \
    && npm cache clean --force

# Copy PM2 config
COPY ecosystem.config.js .

EXPOSE 3000

CMD ["pm2-runtime", "start", "ecosystem.config.js"]
