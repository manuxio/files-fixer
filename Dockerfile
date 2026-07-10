# --- build the React client ---
FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# --- runtime: Express serving API + built client, plus the Claude CLI ---
# Debian slim (glibc) rather than alpine/musl: node-pty (the web-shell PTY) and
# the Claude Code CLI both build/run more reliably against glibc.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Pin the CLI to the version baked into the image. Claude Code otherwise
# self-updates at runtime (npm-global path), which clobbers the `claude` wrapper
# and drops the executable bit on the binary -> the web shell dies with
# "execvp failed: Permission denied". Updates now happen only on image rebuild.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_AUTOUPDATE=1

# git: Claude Code expects it. build tools: to compile node-pty's native addon
# (installed as an optional server dep). ca-certificates: TLS for the CLI.
# bubblewrap + socat: back Claude Code's OS-level command sandbox for the shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates bubblewrap socat python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Server deps (includes ws + the native node-pty optional dep — build tools present).
COPY package.json ./
RUN npm install --omit=dev

# Compilers are only needed to build node-pty; drop them to keep the image lean.
RUN apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# --- Claude Code CLI + profile launcher -----------------------------------
# Install the CLI, then shadow it with a profile-selecting wrapper so `claude`
# always asks which of the N profile dirs to use (see scripts/claude-profile.sh).
ENV CLAUDE_PROFILES_ROOT=/claude-profiles \
    CLAUDE_PROFILE_COUNT=3
RUN npm install -g @anthropic-ai/claude-code \
 && mv "$(command -v claude)" /usr/local/bin/claude-bin
COPY scripts/claude-profile.sh /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude \
 && mkdir -p /claude-profiles/1 /claude-profiles/2 /claude-profiles/3

COPY server/ ./server/
COPY scripts/ ./scripts/
COPY assets/ ./assets/
COPY --from=client /app/client/dist ./client/dist

EXPOSE 3000
CMD ["node", "server/index.js"]
