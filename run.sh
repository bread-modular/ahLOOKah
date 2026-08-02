#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
export PORT

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid PORT: ${PORT}" >&2
  exit 1
fi

echo "Ensuring port ${PORT} is free..."

get_port_pids() {
  {
    if command -v lsof >/dev/null 2>&1; then
      lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
    fi

    if command -v fuser >/dev/null 2>&1; then
      fuser "${PORT}/tcp" 2>/dev/null || true
    fi
  } | tr ' ' '\n' | sed '/^$/d' | sort -u
}

PIDS="$(get_port_pids | tr '\n' ' ' | xargs || true)"

if [[ -n "${PIDS}" ]]; then
  echo "Stopping process(es) on port ${PORT}: ${PIDS}"
  kill ${PIDS} 2>/dev/null || true
  sleep 2

  REMAINING_PIDS="$(get_port_pids | tr '\n' ' ' | xargs || true)"
  if [[ -n "${REMAINING_PIDS}" ]]; then
    echo "Force stopping process(es) on port ${PORT}: ${REMAINING_PIDS}"
    kill -9 ${REMAINING_PIDS} 2>/dev/null || true
    sleep 1
  fi
fi

if [[ -n "$(get_port_pids | tr '\n' ' ' | xargs || true)" ]]; then
  echo "Failed to free port ${PORT}." >&2
  exit 1
fi

echo "Building app..."
npm run build

echo "Starting app on port ${PORT}..."
VITE_BIN="./node_modules/.bin/vite"

if [[ ! -x "${VITE_BIN}" ]]; then
  echo "Cannot find Vite binary at ${VITE_BIN}. Run npm install first." >&2
  exit 1
fi

# Run Vite's preview server directly instead of through `npm run preview`.
# The Code Project terminal stop button may only signal the top-level process;
# avoiding npm's extra wrapper process ensures the actual server receives it.
exec "${VITE_BIN}" preview --port "${PORT}" --strictPort --host
