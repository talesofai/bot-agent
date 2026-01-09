# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies when package.json is present
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f package.json ]; then \
      if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
      elif [ -f package-lock.json ]; then npm ci; \
      else npm install; \
      fi; \
    fi

# Copy source code
COPY . .

# Build when scripts are available
RUN if [ -f package.json ]; then \
      if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm run build; \
      else npm run build; \
      fi; \
    fi

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Install opencode
ARG OPENCODE_INSTALL_URL=https://get.opencode.ai
ARG OPENCODE_INSTALL_SHA256=
RUN apk add --no-cache ca-certificates curl
RUN curl -fsSL "$OPENCODE_INSTALL_URL" -o /tmp/opencode-install.sh \
  && if [ -n "$OPENCODE_INSTALL_SHA256" ]; then \
       echo "$OPENCODE_INSTALL_SHA256  /tmp/opencode-install.sh" | sha256sum -c -; \
     fi \
  && sh /tmp/opencode-install.sh \
  && rm /tmp/opencode-install.sh

# Copy app artifacts
COPY --from=builder /app /app

# Create data directory
RUN mkdir -p /data/groups

EXPOSE 8080

CMD ["sh", "-c", "[ -f dist/index.js ] || { echo 'dist/index.js not found. Build the app first.' >&2; exit 1; }; node dist/index.js"]
