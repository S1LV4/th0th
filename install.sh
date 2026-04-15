#!/usr/bin/env bash
# ============================================================
#  th0th - Installer
#  https://github.com/S1LV4/th0th
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/S1LV4/th0th/main/install.sh | bash
#
#  Environment overrides (export before piping):
#    TH0TH_MODE=docker|build|source   Installation mode (default: docker)
#    TH0TH_DIR=/path/to/install        Where to install (default: ~/.th0th)
#    TH0TH_API_PORT=3333               API port
#    TH0TH_POSTGRES_PORT=5432          PostgreSQL port
#    POSTGRES_PASSWORD=<pass>          DB password (default: th0th_password)
#    OLLAMA_BASE_URL=http://...        Override Ollama URL
#    TH0TH_BRANCH=main                 Git branch (source/build mode)
#    TH0TH_NO_START=1                  Skip starting services after install
# ============================================================

set -e

# ── Colours ──────────────────────────────────────────────────
BOLD='\033[1m'; DIM='\033[2m'
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'
NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "  ${RED}✗${NC} $*" >&2; }
info() { echo -e "  ${BLUE}•${NC} $*"; }
die()  { err "$*"; exit 1; }

# ── Version detection ─────────────────────────────────────────
# Fetches version from GitHub (non-blocking — shows "latest" on failure).
# install.sh runs before any local clone exists, so we can't source banner.sh.
_TH0TH_INSTALLER_VERSION="$(curl -fsSL --max-time 3 \
  "https://raw.githubusercontent.com/${GITHUB_REPO:-S1LV4/th0th}/main/package.json" \
  2>/dev/null \
  | grep '"version"' | head -1 \
  | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' \
  || echo "latest")"

# ── Banner ────────────────────────────────────────────────────
cat << EOF

              ██             ██████               ██
    ███       ██          ███    ██     ███       ██
   ░████      ██  ██      ███      █    ████      ██  ██
  ███████     ████████   ███       █  ███████     ████████
    ███       ██   ███   ███       █    ███       ██   ███
    ███       ██    ██   ███      ██    ███       ██    ██
    ███   █   ██    ██    ████   ███    ███   █   ██    ██
    ███████  ███   ████    ████████     ███████░ ████  ████
     ░████  █████  █████    █████         ████   ████░ █████

   Ancient knowledge keeper for modern code.  v${_TH0TH_INSTALLER_VERSION}
   https://github.com/S1LV4/th0th

EOF

# ── Constants ─────────────────────────────────────────────────
GITHUB_REPO="S1LV4/th0th"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_REPO}"
GITHUB_URL="https://github.com/${GITHUB_REPO}"
# Docker Hub org is the lowercase GitHub owner (Docker requires lowercase).
_DOCKER_ORG=$(echo "${GITHUB_REPO%%/*}" | tr '[:upper:]' '[:lower:]')
DOCKER_API_IMAGE="${_DOCKER_ORG}/th0th-ai:api-latest"
DOCKER_MCP_IMAGE="${_DOCKER_ORG}/th0th-ai:mcp-latest"

# ── Config (overridable via env) ──────────────────────────────
MODE="${TH0TH_MODE:-}"
INSTALL_DIR="${TH0TH_DIR:-$HOME/.th0th}"
API_PORT="${TH0TH_API_PORT:-3333}"
POSTGRES_PORT="${TH0TH_POSTGRES_PORT:-5432}"
DB_PASS="${POSTGRES_PASSWORD:-th0th_password}"
BRANCH="${TH0TH_BRANCH:-main}"
NO_START="${TH0TH_NO_START:-0}"
OLLAMA_URL="${OLLAMA_BASE_URL:-}"  # auto-detected below if empty

# ── Helpers ───────────────────────────────────────────────────
require_cmd() {
  command -v "$1" &>/dev/null || die "'$1' is required but not installed. $2"
}

port_available() {
  ! (ss -tuln 2>/dev/null | grep -q ":$1 ") && \
  ! (netstat -tuln 2>/dev/null | grep -q ":$1 ")
}

find_free_port() {
  local port="$1"
  while ! port_available "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

detect_os() {
  case "$(uname -s)" in
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo "wsl"
      else echo "linux"; fi ;;
    Darwin*) echo "macos" ;;
    *)       echo "unknown" ;;
  esac
}

detect_ollama_url() {
  # Already set via env
  [ -n "$OLLAMA_URL" ] && { echo "$OLLAMA_URL"; return; }

  local candidates=()
  local os; os=$(detect_os)

  # Docker: use host gateway
  if [ "$1" = "docker" ]; then
    candidates+=("http://host.docker.internal:11434")
  fi

  # WSL: try Windows host IP first.
  # Prefer the eth0 default gateway (always the WSL2→Windows bridge) over the
  # /etc/resolv.conf nameserver, which Docker can rewrite to its own bridge IP.
  if [ "$os" = "wsl" ]; then
    local eth0_gw; eth0_gw=$(ip route show 2>/dev/null \
        | awk '/^default/ && $5 == "eth0" {print $3; exit}')
    if [ -n "$eth0_gw" ]; then
      candidates+=("http://${eth0_gw}:11434")
    fi
    # Also add the resolv.conf nameserver as a secondary candidate.
    local resolv_ip; resolv_ip=$(grep nameserver /etc/resolv.conf 2>/dev/null \
        | awk '{print $2}' | head -1)
    [ -n "$resolv_ip" ] && [ "$resolv_ip" != "$eth0_gw" ] \
        && candidates+=("http://${resolv_ip}:11434")
  fi

  # Local fallback
  candidates+=("http://localhost:11434")

  for url in "${candidates[@]}"; do
    if curl -sf --connect-timeout 2 "${url}/api/tags" &>/dev/null; then
      echo "$url"; return
    fi
  done

  echo "http://localhost:11434"  # best guess
}

# ── Mode selection ────────────────────────────────────────────
select_mode() {
  echo -e "${BOLD}Installation mode:${NC}"                               >&2
  echo ""                                                                 >&2
  # Option 1 (Docker pull) is intentionally hidden — code preserved below.
  # echo -e "  ${CYAN}1)${NC} ${BOLD}Docker${NC} ${DIM}(recommended)${NC}" >&2
  # echo -e "     Pull pre-built images from DockerHub. Requires Docker only." >&2
  # echo ""                                                                 >&2
  echo -e "  ${CYAN}1)${NC} ${BOLD}Docker build${NC}"                    >&2
  echo -e "     Clone the repo and build Docker images locally."          >&2
  echo ""                                                                 >&2
  echo -e "  ${CYAN}2)${NC} ${BOLD}From source${NC}"                     >&2
  echo -e "     Clone the repo and run directly with Bun (dev/contributor mode)." >&2
  echo ""                                                                 >&2
  read -rp "  Enter your choice [1]: " choice <>/dev/tty
  case "${choice:-1}" in
    1) echo "build"  ;;
    2) echo "source" ;;
    *) echo "build"  ;;
  esac
}

# ── Preflight ─────────────────────────────────────────────────
preflight_docker() {
  require_cmd docker  "Install Docker: https://docs.docker.com/get-docker/"
  docker info &>/dev/null || die "Docker daemon is not running. Start Docker and retry."
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
}

preflight_bun() {
  if ! command -v bun &>/dev/null; then
    warn "Bun not found — installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  ok "Bun $(bun --version)"
}

preflight_git() {
  require_cmd git "Install git: https://git-scm.com/"
  ok "Git $(git --version | awk '{print $3}')"
}

check_ollama() {
  local url="$1"
  if curl -sf --connect-timeout 2 "${url}/api/tags" &>/dev/null; then
    ok "Ollama reachable at ${url}"
    return 0
  else
    warn "Ollama not reachable at ${url}"
    warn "Start Ollama before using th0th, or set OLLAMA_BASE_URL."
    return 1
  fi
}

# ── .env writer ───────────────────────────────────────────────
write_env() {
  local dir="$1"
  local ollama_url="$2"
  local db_url="$3"
  # Optional: override image names (default to Docker Hub constants)
  local api_image="${4:-$DOCKER_API_IMAGE}"
  local mcp_image="${5:-$DOCKER_MCP_IMAGE}"
  local env_file="${dir}/.env"

  # Don't overwrite existing .env — just update key fields
  if [ -f "$env_file" ]; then
    warn ".env already exists at ${env_file} — skipping (delete it to regenerate)"
    return
  fi

  cat > "$env_file" << ENVEOF
# th0th - generated by install.sh
# Edit this file to customise your installation.

# ── API ──────────────────────────────────────────────────────
TH0TH_API_PORT=${API_PORT}
TH0TH_API_IMAGE=${api_image}
TH0TH_MCP_IMAGE=${mcp_image}
NODE_ENV=production

# ── Database ─────────────────────────────────────────────────
POSTGRES_PASSWORD=${DB_PASS}
TH0TH_POSTGRES_PORT=${POSTGRES_PORT}
DATABASE_URL=${db_url}

# ── Embeddings (Ollama - local, free) ────────────────────────
OLLAMA_BASE_URL=${ollama_url}
OLLAMA_EMBEDDING_MODEL=bge-m3
OLLAMA_EMBEDDING_DIMENSIONS=1024

# ── Optional: Cloud embedding providers ─────────────────────
#EMBEDDING_PROVIDER=google
#GOOGLE_GENERATIVE_AI_API_KEY=your_key_here
#MISTRAL_API_KEY=your_key_here

# ── Logging ──────────────────────────────────────────────────
LOG_LEVEL=info
ENABLE_METRICS=true
ENVEOF

  ok "Created .env at ${env_file}"
}

# ── docker-compose.yml downloader ────────────────────────────
fetch_compose() {
  local dir="$1"
  local compose_file="${dir}/docker-compose.yml"

  if [ -f "$compose_file" ]; then
    ok "docker-compose.yml already exists"
    return
  fi

  echo -e "  Downloading docker-compose.yml..."
  curl -fsSL "${GITHUB_RAW}/${BRANCH}/docker-compose.yml" -o "$compose_file" \
    || die "Failed to download docker-compose.yml from ${GITHUB_URL}"
  ok "docker-compose.yml downloaded"
}

# ── Port conflict resolution ──────────────────────────────────
resolve_ports() {
  if ! port_available "$API_PORT"; then
    warn "Port ${API_PORT} is in use — finding next available..."
    API_PORT=$(find_free_port $((API_PORT + 1)))
    info "Using API port: ${API_PORT}"
  fi
  if ! port_available "$POSTGRES_PORT"; then
    warn "Port ${POSTGRES_PORT} is in use — finding next available..."
    POSTGRES_PORT=$(find_free_port $((POSTGRES_PORT + 1)))
    info "Using PostgreSQL port: ${POSTGRES_PORT}"
  fi
}

# ── Post-install optional setup scripts ──────────────────────
post_install() {
  local mode="$1"
  local install_dir="$2"

  [ "$NO_START" = "1" ] && return  # services not running — skip interactive steps

  local scripts_dir="${install_dir}/scripts"
  local wsl_script="${install_dir}/apps/tools-api/setup-ollama-wsl.sh"

  # Docker mode: only docker-compose.yml was downloaded; fetch scripts from GitHub
  if [ "$mode" = "docker" ]; then
    mkdir -p "${scripts_dir}" "${install_dir}/apps/tools-api"
    local need_fetch=false
    for s in banner.sh setup-vscode.sh validate-vscode-integration.sh; do
      [ -f "${scripts_dir}/${s}" ] || need_fetch=true && break
    done
    if [ "$need_fetch" = true ]; then
      info "Fetching setup scripts from GitHub..."
      for s in banner.sh setup-vscode.sh validate-vscode-integration.sh; do
        curl -fsSL --silent "${GITHUB_RAW}/${BRANCH}/scripts/${s}" \
          -o "${scripts_dir}/${s}" 2>/dev/null || true
      done
      curl -fsSL --silent \
        "${GITHUB_RAW}/${BRANCH}/apps/tools-api/setup-ollama-wsl.sh" \
        -o "$wsl_script" 2>/dev/null || true
      chmod +x "${scripts_dir}"/*.sh "$wsl_script" 2>/dev/null || true
    fi
  fi

  local os; os=$(detect_os)

  while true; do
    echo ""
    echo -e "${BOLD}Optional setup steps:${NC}"
    echo ""
    if [ "$os" = "wsl" ] && [ -f "$wsl_script" ]; then
      echo -e "  ${CYAN}w)${NC} Setup Ollama for WSL (Windows host connectivity)"
    fi
    if [ -f "${scripts_dir}/setup-vscode.sh" ]; then
      echo -e "  ${CYAN}v)${NC} Configure VSCode / Antigravity MCP integration"
    fi
    if [ -f "${scripts_dir}/validate-vscode-integration.sh" ]; then
      echo -e "  ${CYAN}t)${NC} Run integration tests"
    fi
    echo -e "  ${CYAN}s)${NC} Skip (finish)"
    echo ""

    read -rp "  Choice [s]: " _post_choice <>/dev/tty
    case "${_post_choice:-s}" in
      w|W)
        [ -f "$wsl_script" ] && bash "$wsl_script" || warn "WSL setup script not found" ;;
      v|V)
        [ -f "${scripts_dir}/setup-vscode.sh" ] \
          && bash "${scripts_dir}/setup-vscode.sh" \
          || warn "VSCode setup script not found" ;;
      t|T)
        [ -f "${scripts_dir}/validate-vscode-integration.sh" ] \
          && bash "${scripts_dir}/validate-vscode-integration.sh" \
          || warn "Validation script not found" ;;
      s|S|"") return ;;
      *) warn "Unknown choice. Enter w, v, t, or s." ;;
    esac
  done
}

# ── Show MCP integration instructions ────────────────────────
show_integration() {
  local mode="$1"
  local api_port="$2"
  local install_dir="$3"

  echo ""
  echo -e "${BOLD}╔═══════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║              th0th is ready!                          ║${NC}"
  echo -e "${BOLD}╚═══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${GREEN}API:${NC}     http://localhost:${api_port}"
  echo -e "  ${GREEN}Health:${NC}  curl http://localhost:${api_port}/health"
  echo -e "  ${GREEN}Swagger:${NC} http://localhost:${api_port}/swagger"
  echo ""
  echo -e "${BOLD}  Connect to Claude / OpenCode:${NC}"
  echo ""

  if [ "$mode" = "docker" ] || [ "$mode" = "build" ]; then
    echo -e "  ${CYAN}Option A — Docker MCP (recommended):${NC}"
    echo -e '  Add to ~/.config/opencode/opencode.json or Claude Desktop config:'
    echo ""
    echo -e '  {'
    echo -e '    "mcpServers": {'
    echo -e '      "th0th": {'
    echo -e '        "type": "local",'
    echo -e "        \"command\": [\"docker\", \"compose\", \"-f\", \"${install_dir}/docker-compose.yml\", \"run\", \"--rm\", \"-i\", \"mcp\"],"
    echo -e '        "enabled": true'
    echo -e '      }'
    echo -e '    }'
    echo -e '  }'
    echo ""
    echo -e "  ${CYAN}Option B — npm MCP (no Docker required for MCP):${NC}"
  fi

  echo -e '  {'
  echo -e '    "mcpServers": {'
  echo -e '      "th0th": {'
  echo -e '        "type": "local",'
  echo -e '        "command": ["npx", "@th0th-ai/mcp-client"],'
  echo -e "        \"env\": { \"TH0TH_API_URL\": \"http://localhost:${api_port}\" },"
  echo -e '        "enabled": true'
  echo -e '      }'
  echo -e '    }'
  echo -e '  }'
  echo ""
  echo -e "  ${BOLD}Manage services:${NC}"
  echo -e "    docker compose -f ${install_dir}/docker-compose.yml up -d"
  echo -e "    docker compose -f ${install_dir}/docker-compose.yml down"
  echo -e "    docker compose -f ${install_dir}/docker-compose.yml logs -f api"
  echo ""
  echo -e "  ${BOLD}Diagnose:${NC}"
  if [ "$mode" = "source" ] || [ "$mode" = "build" ]; then
    echo -e "    cd ${install_dir} && bun run diagnose"
  else
    echo -e "    curl -s http://localhost:${api_port}/health | jq"
  fi
  echo ""
}

# ══════════════════════════════════════════════════════════════
#  MODES
# ══════════════════════════════════════════════════════════════

install_docker() {
  echo -e "${BOLD}[1/4] Checking prerequisites...${NC}"
  preflight_docker
  echo ""

  echo -e "${BOLD}[2/4] Resolving ports & configuration...${NC}"
  resolve_ports
  mkdir -p "$INSTALL_DIR"

  local ollama_url; ollama_url=$(detect_ollama_url "docker")
  check_ollama "$ollama_url" || true

  local db_url="postgresql://th0th:${DB_PASS}@localhost:${POSTGRES_PORT}/th0th"
  fetch_compose "$INSTALL_DIR"
  write_env "$INSTALL_DIR" "$ollama_url" "$db_url"
  echo ""

  echo -e "${BOLD}[3/4] Pulling Docker images...${NC}"
  (cd "$INSTALL_DIR" && \
    env TH0TH_API_PORT="$API_PORT" TH0TH_POSTGRES_PORT="$POSTGRES_PORT" \
        POSTGRES_PASSWORD="$DB_PASS" OLLAMA_BASE_URL="$ollama_url" \
    docker compose pull)
  ok "Images pulled"
  echo ""

  if [ "$NO_START" != "1" ]; then
    echo -e "${BOLD}[4/4] Starting services...${NC}"
    (cd "$INSTALL_DIR" && \
      env TH0TH_API_PORT="$API_PORT" TH0TH_POSTGRES_PORT="$POSTGRES_PORT" \
          POSTGRES_PASSWORD="$DB_PASS" OLLAMA_BASE_URL="$ollama_url" \
      docker compose up -d postgres)
    ok "PostgreSQL started"

    info "Waiting for database to be ready..."
    local tries=0
    until (cd "$INSTALL_DIR" && docker compose exec -T postgres pg_isready -U th0th &>/dev/null) \
          || [ $tries -ge 15 ]; do
      sleep 2; tries=$((tries + 1))
    done

    (cd "$INSTALL_DIR" && \
      env TH0TH_API_PORT="$API_PORT" TH0TH_POSTGRES_PORT="$POSTGRES_PORT" \
          POSTGRES_PASSWORD="$DB_PASS" OLLAMA_BASE_URL="$ollama_url" \
      docker compose up -d api)
    ok "API started (migrations run automatically on first boot)"
    echo ""
  fi

  show_integration "docker" "$API_PORT" "$INSTALL_DIR"
  post_install "docker" "$INSTALL_DIR"
}

# ──────────────────────────────────────────────────────────────

install_build() {
  echo -e "${BOLD}[1/5] Checking prerequisites...${NC}"
  preflight_docker
  preflight_git
  preflight_bun
  echo ""

  echo -e "${BOLD}[2/5] Cloning repository...${NC}"
  if [ -d "${INSTALL_DIR}/.git" ]; then
    ok "Repo already cloned at ${INSTALL_DIR} — pulling latest"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git clone --depth=1 --branch "$BRANCH" "${GITHUB_URL}.git" "$INSTALL_DIR"
    ok "Cloned ${GITHUB_URL} → ${INSTALL_DIR}"
  fi
  echo ""

  echo -e "${BOLD}[3/5] Resolving ports & configuration...${NC}"
  resolve_ports
  local ollama_url; ollama_url=$(detect_ollama_url "docker")
  check_ollama "$ollama_url" || true
  local db_url="postgresql://th0th:${DB_PASS}@localhost:${POSTGRES_PORT}/th0th"
  # Pass local image names so the .env points at what was actually built,
  # not the Docker Hub constants (which may not exist or be stale).
  write_env "$INSTALL_DIR" "$ollama_url" "$db_url" "th0th-api:local" "th0th-mcp:local"
  echo ""

  echo -e "${BOLD}[4/5] Building Docker images...${NC}"
  (cd "$INSTALL_DIR" && docker build --target api -t th0th-api:local .)
  (cd "$INSTALL_DIR" && docker build --target mcp -t th0th-mcp:local .)
  ok "Images built"
  export TH0TH_API_IMAGE="th0th-api:local"
  export TH0TH_MCP_IMAGE="th0th-mcp:local"
  echo ""

  if [ "$NO_START" != "1" ]; then
    echo -e "${BOLD}[5/5] Starting services...${NC}"
    (cd "$INSTALL_DIR" && \
      env TH0TH_API_PORT="$API_PORT" TH0TH_POSTGRES_PORT="$POSTGRES_PORT" \
          POSTGRES_PASSWORD="$DB_PASS" OLLAMA_BASE_URL="$ollama_url" \
          TH0TH_API_IMAGE="th0th-api:local" TH0TH_MCP_IMAGE="th0th-mcp:local" \
      docker compose up -d postgres api)
    ok "Services started"
    echo ""
  fi

  show_integration "build" "$API_PORT" "$INSTALL_DIR"
  post_install "build" "$INSTALL_DIR"
}

# ──────────────────────────────────────────────────────────────

install_source() {
  echo -e "${BOLD}[1/4] Checking prerequisites...${NC}"
  preflight_git
  preflight_bun
  echo ""

  echo -e "${BOLD}[2/4] Cloning repository...${NC}"
  if [ -d "${INSTALL_DIR}/.git" ]; then
    ok "Repo already cloned at ${INSTALL_DIR} — pulling latest"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    git clone --depth=1 --branch "$BRANCH" "${GITHUB_URL}.git" "$INSTALL_DIR"
    ok "Cloned ${GITHUB_URL} → ${INSTALL_DIR}"
  fi
  echo ""

  echo -e "${BOLD}[3/4] Installing dependencies & building...${NC}"
  (cd "$INSTALL_DIR" && bun install)
  (cd "$INSTALL_DIR" && bun run build)
  ok "Build complete"
  echo ""

  echo -e "${BOLD}[4/4] Running local setup wizard...${NC}"
  bash "${INSTALL_DIR}/scripts/setup-local-first.sh"

  show_integration "source" "$API_PORT" "$INSTALL_DIR"
  post_install "source" "$INSTALL_DIR"
}

# ══════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════

main() {
  echo ""
  echo -e "${BOLD}Installation directory:${NC} ${INSTALL_DIR}"
  echo ""

  # Select mode interactively if not set via env
  if [ -z "$MODE" ]; then
    MODE=$(select_mode)
  fi

  echo ""
  echo -e "${BOLD}Mode: ${CYAN}${MODE}${NC}"
  echo ""

  case "$MODE" in
    docker) install_docker ;;
    build)  install_build  ;;
    source) install_source ;;
    *)      die "Unknown mode '${MODE}'. Valid: docker, build, source" ;;
  esac
}

main "$@"
