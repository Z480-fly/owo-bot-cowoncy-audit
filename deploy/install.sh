#!/usr/bin/env bash
set -euo pipefail

# Installs the companion on a dedicated Ubuntu/Debian host.
# Run from the repository root: sudo bash deploy/install.sh
# The token is read with echo disabled and written only to the root-owned env file.

REPO_URL="${REPO_URL:-https://github.com/Z480-fly/owo-bot-cowoncy-audit.git}"
INSTALL_DIR="/opt/owo-blackjack-companion"
ENV_FILE="/etc/owo-blackjack-companion.env"
SERVICE_NAME="owo-bot.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required." >&2
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  echo "Cannot identify this operating system." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *)
    echo "This installer supports Ubuntu and Debian only (found: ${ID:-unknown})." >&2
    exit 1
    ;;
esac

if [ -e "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR already exists. Refusing to overwrite an existing install." >&2
  exit 1
fi

if [ ! -t 0 ]; then
  echo "Run this interactively so the token prompt can hide your input." >&2
  exit 1
fi

apt-get update
apt-get install -y git curl ca-certificates

node_is_supported() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1)'
}

if ! node_is_supported; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm ci --omit=dev

if ! id -u owobot >/dev/null 2>&1; then
  useradd --system --user-group --home "$INSTALL_DIR" --shell /usr/sbin/nologin owobot
fi
chown -R owobot:owobot "$INSTALL_DIR"

install -m 600 -o root -g root "$INSTALL_DIR/env.example" "$ENV_FILE"

printf 'Discord bot token (input hidden): '
IFS= read -rsp '' TOKEN
printf '\n'
if [ -z "$TOKEN" ]; then
  echo "No token entered; aborting." >&2
  exit 1
fi

printf 'Blackjack channel ID (optional; press Enter to activate with /owo): '
IFS= read -r CHANNEL_ID

ENV_FILE="$ENV_FILE" TOKEN="$TOKEN" CHANNEL_ID="$CHANNEL_ID" node <<'NODE'
const fs = require('node:fs');
const file = process.env.ENV_FILE;
let text = fs.readFileSync(file, 'utf8');
text = text.replace(/^DISCORD_TOKEN=.*$/m, () => `DISCORD_TOKEN=${process.env.TOKEN}`);
if (process.env.CHANNEL_ID) {
  text = text.replace(/^TRACK_CHANNEL_IDS=.*$/m, () => `TRACK_CHANNEL_IDS=${process.env.CHANNEL_ID}`);
}
fs.writeFileSync(file, text, { mode: 0o600 });
NODE
unset TOKEN

install -m 644 "$INSTALL_DIR/deploy/owo-bot.service" "$SERVICE_PATH"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME" || true

cat <<'EOF'

Installation finished. The bot is in setup mode because ALLOW_LIVE_OWO is false.

Next:
  1. Invite the bot with the bot + applications.commands scopes and permissions 68608.
  2. In your server, run /owo and confirm it responds (it will say live tracking is gated).
  3. Complete the live-format, Message Content Intent, and OwO-permission checks in README.md.
  4. Only then run:
       sudo nano /etc/owo-blackjack-companion.env
       # set ALLOW_LIVE_OWO=true
       sudo systemctl restart owo-bot.service
  5. Logs: journalctl -u owo-bot.service -n 50 --no-pager
EOF
