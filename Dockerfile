# Stage 1: Build
FROM node:22-alpine AS builder

# Install build dependencies for native modules (e.g. bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

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

# Install build dependencies again for potential native module rebuilds in prod deps
RUN apk add --no-cache python3 make g++

RUN npm ci --only=production

# Copy built assets from builder
COPY --from=builder /app/dist ./dist

# Copy the generated Prisma Client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Remove build dependencies to keep image light
RUN apk del python3 make g++

EXPOSE 3000

CMD ["node", "-r", "./dist/src/tracing.js", "dist/src/main.js"]
