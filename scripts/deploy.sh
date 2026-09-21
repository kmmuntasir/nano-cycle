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

# --- optional tools (recommended; each degrades gracefully) ----------------------
hint_line() { # name status hint
  if [[ "$2" == "ok" ]]; then ok "$1 — $3"; else warn "$1 missing — $3"; fi
}
command -v rtk >/dev/null && hint_line "rtk" ok "token-optimized command proxy — agents will use it" \
  || hint_line "rtk" missing "install your rtk build (token hygiene falls back silently without it)"

if command -v obscura >/dev/null; then
  hint_line "obscura" ok "headless browser — web_reader tool available"
elif command -v cargo >/dev/null && [[ -n "${NANO_OBSCURA_DIR:-}" && -f "${NANO_OBSCURA_DIR}/obscura/Cargo.toml" ]]; then
  say "building obscura from $NANO_OBSCURA_DIR (a few minutes)…"
  cargo install --path "${NANO_OBSCURA_DIR}/obscura" --locked && ok "obscura installed" \
    || warn "obscura build failed — web_reader stays disabled (non-fatal)"
else
  hint_line "obscura" missing "set NANO_OBSCURA_DIR to a checkout containing obscura/Cargo.toml (needs cargo) — web_reader stays disabled without it"
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
