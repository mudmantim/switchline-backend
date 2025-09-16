# =============================================================================
# Switchline Backend Dockerfile
# Multi-stage build for optimized production image
# =============================================================================

# Build stage
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies)
RUN npm ci

# Copy source code
COPY . .

# Run any build processes (if needed)
# RUN npm run build

# =============================================================================
# Production stage
# =============================================================================

FROM node:18-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    dumb-init \
    curl \
    tzdata \
    python3 \
    make \
    g++

# Create app directory and user
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S switchline -u 1001 -G nodejs

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code from builder stage
COPY --from=builder --chown=switchline:nodejs /app .

# Create necessary directories
RUN mkdir -p logs uploads && \
    chown -R switchline:nodejs /app

# Health check script
COPY --chown=switchline:nodejs healthcheck.js ./

# Set proper permissions
RUN chmod +x healthcheck.js

# Switch to non-root user
USER switchline

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node healthcheck.js || exit 1

# Expose port
EXPOSE 3001

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]

# =============================================================================
# Development stage
# =============================================================================

FROM node:18-alpine AS development

# Install development dependencies
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S switchline -u 1001 -G nodejs

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies)
RUN npm ci

# Copy source code
COPY --chown=switchline:nodejs . .

# Create necessary directories
RUN mkdir -p logs uploads && \
    chown -R switchline:nodejs /app

# Switch to non-root user
USER switchline

# Expose port
EXPOSE 3001

# Start with nodemon for development
CMD ["npm", "run", "dev"]