# Build stage
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV npm_config_registry=https://registry.npmjs.org

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip build-essential bash git \
  && curl -fsSL https://bun.sh/install | bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN git init \
  && git config --global --add safe.directory /app \
  && bun install --frozen-lockfile --ignore-scripts

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY configs ./configs
COPY docs/discord_commands ./docs/discord_commands

RUN rm -rf .git

# Runtime stage
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV npm_config_registry=https://registry.npmjs.org

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip bash \
  && curl -fsSL https://bun.sh/install | bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install opencode CLI from npm to pick the correct platform binary.
# NOTE: CI enables cache, so we pass a changing build-arg to ensure `@latest` isn't stuck on an old layer.
ARG OPENCODE_AI_VERSION=latest
ARG OPENCODE_INSTALL_CACHE_BUST=0
RUN echo "opencode install cache bust: ${OPENCODE_INSTALL_CACHE_BUST}" \
  && bun install -g "opencode-ai@${OPENCODE_AI_VERSION}" --ignore-scripts \
  && bun install -g "opencode-linux-x64@${OPENCODE_AI_VERSION}" --ignore-scripts

# Copy app artifacts
COPY --from=builder /app/src /app/src
COPY --from=builder /app/configs /app/configs
COPY --from=builder /app/docs /app/docs
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/bun.lock /app/bun.lock
COPY --from=builder /app/tsconfig.json /app/tsconfig.json
COPY --from=builder /app/node_modules /app/node_modules

# Create data directory
RUN mkdir -p /data/groups

EXPOSE 8080

CMD ["bun", "run", "start:adapter"]
