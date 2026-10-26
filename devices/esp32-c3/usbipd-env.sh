#!/usr/bin/env bash
# usbipd-env.sh — make USB devices shared from Windows via usbipd-win usable
# from this WSL shell.
#
# Sourced automatically by the workspace .envrc. Safe to source by hand:
#
#     source devices/esp32-c3/usbipd-env.sh
#
# What it does:
#   1. Puts the usbipd-win WSL helper binaries (usbip, usbip-auto-attach) on PATH.
#   2. Attaches every shared-but-not-yet-attached device to this distro.
#   3. Fixes permissions on the resulting /dev/ttyACM*, /dev/ttyUSB* and
#      /dev/bus/usb nodes so the current user can flash without sudo.
#
# Everything is best-effort: if usbipd-win is not installed (or we are not in
# WSL) the script quietly does nothing.

_usbipd_env_sourced=0
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  _usbipd_env_sourced=1
fi

_usbipd_env_log() {
  printf 'usbipd-env: %s\n' "$*" >&2
}

# Locate the usbipd-win installation. The WSL helper binaries live in a "WSL"
# subdirectory next to usbipd.exe.
_usbipd_env_find_win_dir() {
  local candidate

  if [ -n "${USBIPD_WIN_DIR:-}" ] && [ -d "$USBIPD_WIN_DIR" ]; then
    printf '%s\n' "$USBIPD_WIN_DIR"
    return 0
  fi

  for candidate in \
    "/mnt/c/Program Files/usbipd-win" \
    "/mnt/c/Program Files (x86)/usbipd-win"; do
    if [ -x "$candidate/usbipd.exe" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  # Fall back to whatever usbipd.exe is on PATH (Windows PATH is inherited).
  candidate="$(command -v usbipd.exe 2>/dev/null)" || return 1
  [ -n "$candidate" ] || return 1
  dirname "$candidate"
}

# usbipd.exe prints CRLF line endings; strip them.
_usbipd_env_win() {
  "$1" "${@:2}" 2>/dev/null | tr -d '\r'
}

# Attach every device that is shared but not attached to this distro.
_usbipd_env_attach() {
  local win_dir="$1" busid state attached=0

  command -v usbipd.exe >/dev/null 2>&1 || return 0

  while read -r busid _ _ state; do
    case "$busid" in
      [0-9]*-[0-9]*) ;;
      *) continue ;;
    esac
    [ "$state" = "Shared" ] || continue

    if _usbipd_env_win usbipd.exe attach --wsl --busid "$busid" >/dev/null; then
      _usbipd_env_log "attached $busid"
      attached=$((attached + 1))
    else
      _usbipd_env_log "could not attach $busid (needs Windows admin rights?)"
    fi
  done < <(_usbipd_env_win usbipd.exe list)

  [ "$attached" -gt 0 ] && return 0
  return 0
}

# Give the current user access to the USB nodes. usbipd-win creates them as
# root:root, so a plain `idf.py flash` would otherwise fail with EACCES.
_usbipd_env_fix_permissions() {
  local nodes=() node

  shopt -s nullglob
  nodes=(/dev/ttyACM* /dev/ttyUSB*)
  shopt -u nullglob

  for node in "${nodes[@]}"; do
    [ -c "$node" ] || continue
    [ -r "$node" ] && [ -w "$node" ] && continue
    if sudo -n chown "$(id -u):$(id -g)" "$node" 2>/dev/null; then
      _usbipd_env_log "granted access to $node"
    else
      _usbipd_env_log "no access to $node (run: sudo chown $(id -un) $node)"
    fi
  done

  # Raw USB access (esptool sometimes needs it, e.g. for JTAG).
  for node in /dev/bus/usb/*/*; do
    [ -c "$node" ] || continue
    [ -r "$node" ] && [ -w "$node" ] && continue
    sudo -n chown "$(id -u):$(id -g)" "$node" 2>/dev/null || true
  done
}

_usbipd_env_load() {
  local win_dir

  # Not WSL — nothing to do.
  [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -n "${WSL_DISTRO_NAME:-}" ] || return 0

  win_dir="$(_usbipd_env_find_win_dir)" || return 0

  if [ -d "$win_dir/WSL" ]; then
    case ":$PATH:" in
      *":$win_dir/WSL:"*) ;;
      *) PATH="$win_dir/WSL:$PATH" ;;
    esac
    export PATH
  fi

  _usbipd_env_attach "$win_dir"
  _usbipd_env_fix_permissions
  return 0
}

_usbipd_env_load
_usbipd_env_status=$?

if [ "$_usbipd_env_sourced" = 1 ]; then
  return "$_usbipd_env_status"
else
  exit "$_usbipd_env_status"
fi
