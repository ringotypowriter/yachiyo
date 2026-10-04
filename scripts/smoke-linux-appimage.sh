#!/usr/bin/env bash
# Launches the AppImage the way the AppImage catalog (appimage.github.io) tests it: a bare X
# session with no session D-Bus, so no system wallet, and no network. The app must show a
# window within 30 seconds and keep running.
set -euo pipefail

appimage=$(realpath "$1")
chmod +x "$appimage"

export DISPLAY=:99
home=$(mktemp -d)
log=$(mktemp)

Xvfb "$DISPLAY" -screen 0 1280x1024x24 -ac -nolisten tcp &
xvfb=$!
for _ in $(seq 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

# A private network namespace with only loopback up, then back to the unprivileged user.
sudo unshare --net -- bash -c 'ip link set lo up && exec sudo -u "$0" env "$@"' "$(id -un)" \
  HOME="$home" DISPLAY="$DISPLAY" DBUS_SESSION_BUS_ADDRESS=disabled: "$appimage" >"$log" 2>&1 &
app=$!

finish() {
  sudo kill "$app" 2>/dev/null || true
  kill "$xvfb" 2>/dev/null || true
  echo '::group::Application log'
  cat "$log"
  echo '::endgroup::'
}
trap finish EXIT

# The launcher is root-owned, so read its state instead of signalling it.
running() {
  local state
  state=$(ps -o stat= -p "$app" 2>/dev/null) || return 1
  [[ $state != Z* ]]
}

shown=false
for _ in $(seq 30); do
  if ! running; then
    echo 'ERROR: the application exited instead of showing a window' >&2
    exit 1
  fi
  if timeout 5 xdotool search --onlyvisible --name '.' >/dev/null 2>&1; then
    shown=true
    break
  fi
  sleep 1
done

if [ "$shown" != true ]; then
  echo 'ERROR: no window appeared within 30 seconds' >&2
  exit 1
fi

sleep 5
if ! running; then
  echo 'ERROR: the application exited right after showing its window' >&2
  exit 1
fi
echo 'The application window is visible and the process is still running'
