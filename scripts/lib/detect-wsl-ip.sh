#!/bin/bash

detect_wsl_windows_ip() {
    local _resolv="${_WSL_RESOLV_CONF:-/etc/resolv.conf}"

    # ── Method 1: eth0 default gateway ──────────────────────────────────
    # WSL2 always places the Windows bridge on eth0.  Docker bridge
    # interfaces (docker0, br-*) are never the eth0 device.
    local _eth0_gw
    # Field layout: default(1) via(2) IP(3) dev(4) IFACE(5) ...
    # Use field comparison instead of \b word boundary, which is not
    # supported by all awk implementations (mawk treats \b as backspace).
    _eth0_gw=$(ip route show 2>/dev/null \
        | awk '/^default/ && $5 == "eth0" {print $3; exit}')
    if [ -n "$_eth0_gw" ]; then
        echo "$_eth0_gw"
        return 0
    fi

    # ── Method 2: /etc/resolv.conf nameserver ───────────────────────────
    local _resolv_ip
    _resolv_ip=$(grep nameserver "$_resolv" 2>/dev/null \
        | awk '{print $2}' | head -1)
    if [ -n "$_resolv_ip" ]; then
        echo "$_resolv_ip"
        return 0
    fi

    # ── Method 3: any default gateway ───────────────────────────────────
    local _any_gw
    _any_gw=$(ip route show 2>/dev/null \
        | awk '/^default/ {print $3; exit}')
    if [ -n "$_any_gw" ]; then
        echo "$_any_gw"
        return 0
    fi

    return 1
}
