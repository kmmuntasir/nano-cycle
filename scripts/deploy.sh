#!/usr/bin/env bash
# nano-cycle deployment — credentials from .env, prerequisites, optional tools.
#
#   scripts/deploy.sh                 # full setup (credentials + checks + install + build)
#   scripts/deploy.sh --force-auth    # overwrite an existing ~/.pi/agent/auth.json
#   scripts/deploy.sh --skip-install  # skip npm install
#   scripts/deploy.sh --skip-build    # skip the web GUI build
#   scripts/deploy.sh --systemd       # also write ./nano-cycle.service (systemd unit)
#   scripts/deploy.sh --env FILE      # use a specific .env (default: <repo>/.env)
#
# The script never echoes secret values. .env is gitignored — fill it from
# .env.example (PI_AUTH_JSON comes from a machine where pi is logged in:
#   cat ~/.pi/agent/auth.json
set -euo pipefail

FORCE_AUTH=0 SKIP_INSTALL=0 SKIP_BUILD=0 SYSTEMD=0
ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force-auth) FORCE_AUTH=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --systemd) SYSTEMD=1 ;;
    --env) ENV_FILE="$2"; shift ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m✗\033[0m %s\n' "$*"; exit 1; }

# --- .env -----------------------------------------------------------------------
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  ok ".env loaded from $ENV_FILE"
else
  warn "no .env at $ENV_FILE — copy .env.example and fill in PI_AUTH_JSON"
fi

# --- hard prerequisites ----------------------------------------------------------
command -v node >/dev/null || die "node not found — nano-cycle needs Node >= 24 (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 24 ]] || die "node $(node -v) is too old — nano-cycle needs >= 24"
ok "node $(node -v)"
command -v git >/dev/null || die "git not found — required for queue runs (verdict-gated merges)"
ok "git $(git --version | awk '{print $3}')"

# --- credentials → ~/.pi/agent ---------------------------------------------------
if [[ -z "${PI_AUTH_JSON:-}" ]]; then
  warn "PI_AUTH_JSON not set — agents will have NO models. Fill it in .env (see .env.example) and re-run."
elif [[ ! "$PI_AUTH_JSON" =~ ^\{ ]]; then
  die "PI_AUTH_JSON does not look like JSON (expected a provider→credentials map starting with '{') — in .env, wrap the value in SINGLE quotes: PI_AUTH_JSON='...}'"
else
  AGENT_DIR="${HOME}/.pi/agent"
  mkdir -p "$AGENT_DIR"
  if node -e 'JSON.parse(process.argv[1])' "$PI_AUTH_JSON" >/dev/null 2>&1; then
    ok "PI_AUTH_JSON is valid JSON"
  else
    die "PI_AUTH_JSON is not parseable JSON — check quoting in .env"
  fi
  if [[ -f "$AGENT_DIR/auth.json" && "$FORCE_AUTH" -ne 1 ]]; then
    warn "$AGENT_DIR/auth.json already exists — NOT overwriting (pass --force-auth to replace)"
  else
    printf '%s' "$PI_AUTH_JSON" > "$AGENT_DIR/auth.json"
    chmod 600 "$AGENT_DIR/auth.json"
    ok "wrote $AGENT_DIR/auth.json (0600, $(node -e 'console.log(Object.keys(JSON.parse(process.argv[1])).length)' "$PI_AUTH_JSON") provider(s))"
  fi
  if [[ -n "${PI_MODELS_STORE_JSON:-}" ]]; then
    printf '%s' "$PI_MODELS_STORE_JSON" > "$AGENT_DIR/models-store.json"
    chmod 600 "$AGENT_DIR/models-store.json"
    ok "wrote $AGENT_DIR/models-store.json"
  fi
fi

# --- searxng (installed by default — local docker container) ----------------------
# The server probes http://127.0.0.1:8888 at boot: web_search turns on when
# this container answers, so no .env entry is needed.
SEARXNG_URL="${NANO_SEARXNG_URL:-http://127.0.0.1:8888}"
if curl -s -m 6 "${SEARXNG_URL}/search?q=test&format=json" 2>/dev/null | grep -q '"results"'; then
  ok "searxng already answering at $SEARXNG_URL"
elif command -v docker >/dev/null; then
  say "installing searxng (docker container on 127.0.0.1:8888)…"
  SEARXNG_CFG="${HOME}/.nano-cycle/searxng"
  mkdir -p "$SEARXNG_CFG"
  if [[ ! -f "$SEARXNG_CFG/settings.yml" ]]; then
    # json format ON (the API web_search uses), limiter OFF (loopback only),
    # random secret (searxng refuses to boot without one).
    SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
    cat > "$SEARXNG_CFG/settings.yml" << EOF
use_default_settings: true
server:
  secret_key: "$SECRET"
  limiter: false
search:
  formats:
    - html
    - json
EOF
    chmod 600 "$SEARXNG_CFG/settings.yml"
  fi
  if docker inspect nano-cycle-searxng >/dev/null 2>&1; then
    # re-run: start the existing container (settings/state preserved) — never recreate
    docker start nano-cycle-searxng >/dev/null 2>&1 || true
    ok "searxng container already exists — started"
  elif docker run -d --name nano-cycle-searxng --restart unless-stopped \
    -p 127.0.0.1:8888:8080 -v "$SEARXNG_CFG:/etc/searxng" searxng/searxng:latest >/dev/null 2>&1; then
    ok "searxng container created (restart: unless-stopped)"
  else
    warn "searxng container failed to start — web_search stays off (registry unreachable?)"
  fi
  # first boot initializes the DB — wait briefly for the API
  SEARXNG_UP=0
  for _ in $(seq 1 15); do
    if curl -s -m 2 "${SEARXNG_URL}/search?q=test&format=json" 2>/dev/null | grep -q '"results"'; then
      SEARXNG_UP=1
      break
    fi
    sleep 2
  done
  [[ "$SEARXNG_UP" -eq 1 ]] && ok "searxng healthy — web_search enabled" \
    || warn "searxng not answering yet — web_search enables once it is (check: docker logs nano-cycle-searxng)"

# --- searxng STANDALONE tier (no docker): venv from source + systemd --user ------
elif command -v python3 >/dev/null && command -v git >/dev/null; then
  say "installing searxng standalone (venv from source → ~/.nano-cycle/searxng)…"
  SRC="$HOME/.nano-cycle/searxng-src"
  VENV="$HOME/.nano-cycle/searxng-venv"
  CFG="$HOME/.nano-cycle/searxng"
  mkdir -p "$CFG"
  if [[ ! -f "$SRC/searx/webapp.py" ]]; then
    git clone --depth 1 https://github.com/searxng/searxng "$SRC" \
      || die "searxng clone failed — check network access to github.com"
  fi
  python3 -m venv "$VENV" || die "python3 venv unavailable — install python3-venv"
  # Run-from-source, per searxng's dev flow: requirements into the venv, then
  # `python -m searx.webapp` from the src dir. (pip install -e . is fragile:
  # setup.py imports runtime deps at metadata time.)
  "$VENV/bin/pip" install -q -r "$SRC/requirements.txt" \
    || die "searxng requirements install failed — see the error above (python3-dev/build tools may be needed)"
  if [[ ! -f "$CFG/settings.yml" ]]; then
    SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
    cat > "$CFG/settings.yml" << EOF
use_default_settings: true
server:
  secret_key: "$SECRET"
  limiter: false
  bind_address: "127.0.0.1"
  port: 8888
search:
  formats:
    - html
    - json
EOF
    chmod 600 "$CFG/settings.yml"
  fi
  # persistence: systemd --user service when available, else a background process
  if command -v systemctl >/dev/null && systemctl --user status >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/nano-cycle-searxng.service" << EOF
[Unit]
Description=SearXNG (nano-cycle web_search)
After=network.target

[Service]
WorkingDirectory=$SRC
ExecStart=$VENV/bin/python -m searx.webapp
Environment=SEARXNG_SETTINGS_PATH=$CFG/settings.yml
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now nano-cycle-searxng.service 2>/dev/null || true
    say "  boot persistence needs one-time: sudo loginctl enable-linger $USER"
  else
    warn "systemd user session unavailable — starting searxng in the background (nohup; it will not survive reboot)"
    ( cd "$SRC" && SEARXNG_SETTINGS_PATH="$CFG/settings.yml" nohup "$VENV/bin/python" -m searx.webapp > "$CFG/searxng.log" 2>&1 & )
  fi
  SEARXNG_UP=0
  for _ in $(seq 1 20); do
    if curl -s -m 2 "${SEARXNG_URL}/search?q=test&format=json" 2>/dev/null | grep -q '"results"'; then
      SEARXNG_UP=1
      break
    fi
    sleep 2
  done
  [[ "$SEARXNG_UP" -eq 1 ]] && ok "searxng (standalone) healthy — web_search enabled" \
    || warn "searxng not answering yet — check $CFG/searxng.log or the user service logs"
else
  warn "searxng not reachable; docker AND python3/git missing — web_search stays off"
fi

# --- optional tools (recommended; each degrades gracefully) ----------------------
hint_line() { # name status hint
  if [[ "$2" == "ok" ]]; then ok "$1 — $3"; else warn "$1 missing — $3"; fi
}
command -v rtk >/dev/null && hint_line "rtk" ok "token-optimized command proxy — agents will use it" \
  || hint_line "rtk" missing "install your rtk build (token hygiene falls back silently without it)"

if command -v obscura >/dev/null; then
  hint_line "obscura" ok "headless browser — web_reader tool available"
else
  # Standalone install from the obscura release tarball (github.com/h4ckf0r0day/obscura)
  OBSCURA_ASSET="obscura-$(uname -m)-linux.tar.gz"
  say "installing obscura ($OBSCURA_ASSET) → ~/.local/bin…"
  mkdir -p "$HOME/.local/bin"
  TMPD="$(mktemp -d)"
  if curl -sL --max-time 120 "https://github.com/h4ckf0r0day/obscura/releases/latest/download/$OBSCURA_ASSET" -o "$TMPD/obscura.tar.gz" \
    && tar -xzf "$TMPD/obscura.tar.gz" -C "$TMPD" \
    && find "$TMPD" -type f -name obscura -exec install -m 755 {} "$HOME/.local/bin/obscura" \; ; then
    command -v obscura >/dev/null && ok "obscura installed — web_reader tool available" \
      || warn "obscura binary installed to ~/.local/bin — ensure ~/.local/bin is on PATH"
  else
    warn "obscura download failed — web_reader stays off (manual: https://docs.obscura.sh/quickstart/installation)"
  fi
  rm -rf "$TMPD"
fi

command -v gh >/dev/null && hint_line "gh" ok "remote-CI verification available (owner opt-in)" \
  || hint_line "gh" missing "optional — only for remoteChecks runs (https://cli.github.com)"

for scanner in gitleaks semgrep; do
  command -v "$scanner" >/dev/null && hint_line "$scanner" ok "security scan active" \
    || hint_line "$scanner" missing "optional — the security step skips it (install per your distro)"
done

# --- app install + build ----------------------------------------------------------
if [[ "$SKIP_INSTALL" -ne 1 ]]; then
  say "npm install…"
  npm install --no-fund --no-audit
fi
if [[ "$SKIP_BUILD" -ne 1 ]]; then
  say "building web GUI…"
  npm run build
fi

# --- systemd unit (optional) -------------------------------------------------------
if [[ "$SYSTEMD" -eq 1 ]]; then
  cat > "$ROOT/nano-cycle.service" << EOF
[Unit]
Description=nano-cycle
After=network.target

[Service]
User=$USER
WorkingDirectory=$ROOT
ExecStart=$(command -v node) host/server.mjs
Environment=PORT=${NANO_PORT:-4177}
Environment=NANO_HOST=${NANO_HOST:-127.0.0.1}
EnvironmentFile=$ENV_FILE
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  ok "wrote $ROOT/nano-cycle.service — enable with:"
  say "  sudo cp $ROOT/nano-cycle.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now nano-cycle"
fi

say "done — start with: NANO_PORT=${NANO_PORT:-4177} node host/server.mjs"
