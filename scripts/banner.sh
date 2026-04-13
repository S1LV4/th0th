#!/usr/bin/env bash
# ============================================================
#  th0th - Shared CLI utilities
#  Source this file from other scripts — do not run directly.
#
#  Usage:
#    source "$(dirname "${BASH_SOURCE[0]}")/banner.sh"
#    th0th_banner
# ============================================================

# ── Colours ──────────────────────────────────────────────────
BOLD='\033[1m'; DIM='\033[2m'
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "  ${RED}✗${NC} $*" >&2; }
info() { echo -e "  ${BLUE}•${NC} $*"; }
die()  { err "$*"; exit 1; }

# ── Version detection ─────────────────────────────────────────
# Resolves project root from the location of this file (scripts/).
_TH0TH_BANNER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd 2>/dev/null)"

_th0th_detect_version() {
  [ -n "${TH0TH_VERSION:-}" ] && return
  local pkg="${_TH0TH_BANNER_ROOT}/package.json"
  if [ -f "$pkg" ]; then
    if command -v node &>/dev/null; then
      TH0TH_VERSION="$(node -e "process.stdout.write(require('${pkg}').version)" 2>/dev/null)"
    elif command -v python3 &>/dev/null; then
      TH0TH_VERSION="$(python3 -c "import json; print(json.load(open('${pkg}'))['version'],end='')" 2>/dev/null)"
    elif command -v jq &>/dev/null; then
      TH0TH_VERSION="$(jq -r .version "${pkg}" 2>/dev/null)"
    fi
  fi
  TH0TH_VERSION="${TH0TH_VERSION:-?}"
}

# ── Banner ────────────────────────────────────────────────────
th0th_banner() {
  _th0th_detect_version
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

   Ancient knowledge keeper for modern code.  v${TH0TH_VERSION}
   https://github.com/S1LV4/th0th

EOF
}
