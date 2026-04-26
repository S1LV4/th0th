#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SCRIPT="${PROJECT_ROOT}/scripts/setup-local-first.sh"

# ── Colours ───────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

# ── Counters ──────────────────────────────────────────────────
PASS=0
FAIL=0
ERRORS=()

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }

# assert_eq LABEL ACTUAL EXPECTED
assert_eq() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        ok "$label"
        PASS=$((PASS + 1))
    else
        fail "$label  →  got='${actual}'  want='${expected}'"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label")
    fi
}

# assert_exit_zero LABEL CMD...
assert_exit_zero() {
    local label="$1"; shift
    local exit_code=0
    "$@" >/dev/null 2>&1 || exit_code=$?
    if [ "$exit_code" -eq 0 ]; then
        ok "$label"
        PASS=$((PASS + 1))
    else
        fail "$label  (expected exit 0, got ${exit_code})"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label")
    fi
}

# assert_exit_nonzero LABEL CMD...
assert_exit_nonzero() {
    local label="$1"; shift
    local exit_code=0
    "$@" >/dev/null 2>&1 || exit_code=$?
    if [ "$exit_code" -ne 0 ]; then
        ok "$label"
        PASS=$((PASS + 1))
    else
        fail "$label  (expected non-zero exit, got 0)"
        FAIL=$((FAIL + 1))
        ERRORS+=("$label")
    fi
}

# ================================================================
echo ""
echo -e "${BOLD}Setup Wizard DB Selection — Tests (Issue #24)${NC}"
echo "  script: ${SETUP_SCRIPT}"
echo ""

# ── Static analysis ───────────────────────────────────────────

echo "Static analysis: source contains the fix"

# Test 1: main DB choice read uses /dev/tty redirect
DB_CHOICE_READ=$(grep -n 'read.*DB_CHOICE' "$SETUP_SCRIPT" || true)
if echo "$DB_CHOICE_READ" | grep -q '/dev/tty'; then
    ok "DB_CHOICE read redirects stdin from /dev/tty"
    PASS=$((PASS + 1))
else
    fail "DB_CHOICE read is missing /dev/tty redirect — original bug not fixed"
    FAIL=$((FAIL + 1))
    ERRORS+=("DB_CHOICE read redirects stdin from /dev/tty")
fi

# Test 2: main DB choice read has || true guard
if echo "$DB_CHOICE_READ" | grep -q '|| true'; then
    ok "DB_CHOICE read has '|| true' guard against set -e"
    PASS=$((PASS + 1))
else
    fail "DB_CHOICE read is missing '|| true' — set -e can still trigger on EOF"
    FAIL=$((FAIL + 1))
    ERRORS+=("DB_CHOICE read has '|| true' guard against set -e")
fi

# Test 3: DATABASE_URL prompt read uses /dev/tty redirect
DATABASE_URL_READ=$(grep -n 'read.*DATABASE_URL' "$SETUP_SCRIPT" || true)
if echo "$DATABASE_URL_READ" | grep -q '/dev/tty'; then
    ok "DATABASE_URL read redirects stdin from /dev/tty"
    PASS=$((PASS + 1))
else
    fail "DATABASE_URL read is missing /dev/tty redirect"
    FAIL=$((FAIL + 1))
    ERRORS+=("DATABASE_URL read redirects stdin from /dev/tty")
fi

# Test 4: DATABASE_URL read has || true guard
if echo "$DATABASE_URL_READ" | grep -q '|| true'; then
    ok "DATABASE_URL read has '|| true' guard against set -e"
    PASS=$((PASS + 1))
else
    fail "DATABASE_URL read is missing '|| true'"
    FAIL=$((FAIL + 1))
    ERRORS+=("DATABASE_URL read has '|| true' guard against set -e")
fi

# Test 5: no bare 'read -p' without /dev/tty remains in the DB selection section
BARE_READS=$(grep -n 'read -p\b' "$SETUP_SCRIPT" | grep -v '#' || true)
if [ -z "$BARE_READS" ]; then
    ok "no bare 'read -p' (without /dev/tty) remains in the script"
    PASS=$((PASS + 1))
else
    fail "found bare 'read -p' calls that may break in piped mode: ${BARE_READS}"
    FAIL=$((FAIL + 1))
    ERRORS+=("no bare 'read -p' without /dev/tty remains in the script")
fi

# ── Functional: regression — old broken snippet ───────────────

echo ""
echo "Functional: demonstrate original bug (plain read -p with set -e)"

# Test 6: REGRESSION — old plain read exits non-zero on EOF stdin (the original bug)
OLD_SNIPPET='
set -e
DB_CHOICE=""
read -p "" DB_CHOICE
DB_CHOICE=${DB_CHOICE:-1}
echo "DB_CHOICE=$DB_CHOICE"
'
assert_exit_nonzero \
    "plain 'read -p' with set -e exits non-zero on EOF (original bug reproduced)" \
    bash -c "$OLD_SNIPPET"

# ── Functional: fixed snippet ──────────────────────────────────

echo ""
echo "Functional: fixed snippet survives piped/EOF stdin"

# Test 7: fixed read with /dev/tty + || true exits 0 even when stdin is EOF
FIXED_SNIPPET='
set -e
DB_CHOICE=""
read -rp "" DB_CHOICE </dev/tty || true
DB_CHOICE=${DB_CHOICE:-1}
echo "DB_CHOICE=$DB_CHOICE"
'
assert_exit_zero \
    "fixed read with </dev/tty || true exits 0 on EOF stdin" \
    bash -c "$FIXED_SNIPPET"

# Test 8: DB_CHOICE defaults to "1" when no input is provided (EOF stdin)
RESULT=$(bash -c '
set -e
DB_CHOICE=""
read -rp "" DB_CHOICE </dev/tty || true
DB_CHOICE=${DB_CHOICE:-1}
echo "$DB_CHOICE"
' < /dev/null 2>/dev/null || echo "ERROR")
assert_eq "DB_CHOICE defaults to '1' on EOF stdin" "$RESULT" "1"

# Test 9: DATABASE_URL prompt also exits 0 on EOF stdin
DATABASE_URL_SNIPPET='
set -e
DATABASE_URL=""
read -rp "" DATABASE_URL </dev/tty || true
echo "DATABASE_URL=${DATABASE_URL}"
'
assert_exit_zero \
    "DATABASE_URL prompt with </dev/tty || true exits 0 on EOF stdin" \
    bash -c "$DATABASE_URL_SNIPPET"

# Test 10: DATABASE_URL is empty (not crashing) when stdin is piped
URL_RESULT=$(bash -c '
set -e
DATABASE_URL=""
read -rp "" DATABASE_URL </dev/tty || true
echo "$DATABASE_URL"
' < /dev/null 2>/dev/null || echo "ERROR")
assert_eq "DATABASE_URL is empty string on EOF stdin (no crash)" "$URL_RESULT" ""

# ── Summary ───────────────────────────────────────────────────

echo ""
echo -e "${BOLD}────────────────────────────────────────${NC}"
TOTAL=$((PASS + FAIL))
echo -e "  Results: ${GREEN}${PASS}${NC} passed, ${RED}${FAIL}${NC} failed  (${TOTAL} total)"

if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    echo -e "  ${RED}Failed tests:${NC}"
    for e in "${ERRORS[@]}"; do
        echo "    - $e"
    done
    echo ""
    exit 1
fi

echo ""
exit 0
