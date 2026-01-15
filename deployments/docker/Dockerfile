# Build stage
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build
RUN bun run build

# Runtime stage
FROM oven/bun:1-alpine

WORKDIR /app

# Install opencode CLI
ARG OPENCODE_VERSION=v0.0.55
ARG OPENCODE_SHA256=7f1f41203e7920aec48f3e2216d334e9ce8c6d0a7b107ceb758fefa4d4c98025
RUN apk add --no-cache ca-certificates curl \
  && curl -fsSL "https://github.com/opencode-ai/opencode/releases/download/${OPENCODE_VERSION}/opencode-linux-x86_64.tar.gz" -o /tmp/opencode.tar.gz \
  && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
  && chmod +x /usr/local/bin/opencode \
  && rm /tmp/opencode.tar.gz

# Copy app artifacts
COPY --from=builder /app /app

# Create data directory
RUN mkdir -p /data/groups

EXPOSE 8080

CMD ["bun", "run", "start"]
