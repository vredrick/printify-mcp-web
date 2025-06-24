FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev)
# Use --no-audit to speed up installation and --max-old-space-size to prevent memory issues
RUN NODE_OPTIONS="--max-old-space-size=2048" npm ci --no-audit

# Copy source files
COPY src ./src
COPY public ./public

# Build the TypeScript code
RUN npm run build

# Production stage
FROM node:20-alpine

# Install runtime dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Create .npmrc to skip postinstall in production
RUN echo "ignore-scripts=true" > .npmrc

# Install only production dependencies
# Use --omit=dev instead of deprecated --only=production
RUN NODE_OPTIONS="--max-old-space-size=1024" npm ci --omit=dev --no-audit

# Remove .npmrc after installation
RUN rm .npmrc

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Create temp directory for image storage
RUN mkdir -p /app/temp

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "dist/server.js"]