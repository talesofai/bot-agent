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

CMD ["bun", "run", "start"]
