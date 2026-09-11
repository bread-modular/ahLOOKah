#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
export PORT

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid PORT: ${PORT}" >&2
  exit 1
fi

# --- Startup fingerprint: makes "which code am I actually building/serving?" obvious. ---
# Guards against the wrong-cwd failure mode where ./run.sh is launched from a
# different checkout (e.g. main) and silently builds/serves stale code.
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "== run.sh startup fingerprint =="
echo "script dir (APP_ROOT): ${APP_ROOT}"
echo "invocation cwd:        $(pwd)"
if [[ "$(pwd)" != "${APP_ROOT}" ]]; then
  echo "NOTE: cwd differs from APP_ROOT; building/serving from APP_ROOT." >&2
fi
if command -v git >/dev/null 2>&1 && git -C "${APP_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "git branch:            $(git -C "${APP_ROOT}" branch --show-current)"
  echo "git commit:            $(git -C "${APP_ROOT}" rev-parse HEAD)"
  DIRTY="$(git -C "${APP_ROOT}" status --porcelain | head -20)"
  if [[ -n "${DIRTY}" ]]; then
    echo "git dirty files (uncommitted changes ARE included in this build):"
    printf '%s\n' "${DIRTY}" | sed 's/^/    /'
  else
    echo "git status: clean (build contains committed code only)"
  fi
else
  echo "git: ${APP_ROOT} is not a git work tree"
fi
echo "== end startup fingerprint =="

# Build and serve from the script's own directory, regardless of invocation cwd.
cd "${APP_ROOT}"

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

echo "== build asset fingerprint (sha256) =="
if [[ -d dist ]]; then
  (cd dist && find . -type f -print0 | sort -z | xargs -0 sha256sum)
else
  echo "WARNING: dist/ not found after build" >&2
fi
echo "== end build fingerprint =="

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
