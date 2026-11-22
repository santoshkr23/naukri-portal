#!/usr/bin/env bash
# Job portal — install or update on an Ubuntu VPS (Hostinger KVM etc.), next to any other sites.
#   curl -fsSL https://raw.githubusercontent.com/santoshkr23/naukri-portal/main/deploy/install.sh | sudo bash
# It only creates /opt/naukri-portal and its own two containers (naukri-portal, naukri-tunnel).
# It never stops, changes or reuses other containers, web servers, ports 80/443 or firewall rules.
# First run asks a few questions and saves the answers in /opt/naukri-portal/.env. Later runs just update.
set -euo pipefail
DIR=/opt/naukri-portal
REPO=https://github.com/santoshkr23/naukri-portal.git
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ask() { local v; read -rp "$1" v </dev/tty; printf '%s' "$v"; }
[ "$(id -u)" = 0 ] || { echo "Run as root (or with sudo)."; exit 1; }

command -v git >/dev/null || { say "Installing git"; apt-get update -y && apt-get install -y git; }
command -v docker >/dev/null || { say "Installing Docker"; curl -fsSL https://get.docker.com | sh; }
docker compose version >/dev/null 2>&1 || { say "Installing Docker Compose"; apt-get update -y && apt-get install -y docker-compose-plugin; }

if [ -d "$DIR/.git" ]; then say "Getting the latest code"; git -C "$DIR" fetch --depth 1 origin main && git -C "$DIR" reset --hard origin/main
else say "Downloading the job portal"; git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"; mkdir -p backups; chown 1000:1000 backups

if [ ! -f .env ]; then
  say "A few questions (saved in $DIR/.env — only root can read it)"
  echo "1) Your website address without https://, e.g. sarkarialert.in"
  while :; do DOMAIN=$(ask "   Domain: "); DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}; [[ "$DOMAIN" == *.* ]] && break; echo "   That doesn't look like a domain."; done
  echo "2) Owner login for $DOMAIN/admin"
  AU=$(ask "   Username [admin]: "); AU=${AU:-admin}
  while :; do read -rsp "   Password (12+ characters, no ' quote): " AP </dev/tty; echo; [ ${#AP} -ge 12 ] && [[ "$AP" != *"'"* ]] && break; echo "   Too short, or contains a ' quote."; done
  echo "3) Cloudflare Tunnel token (Cloudflare → Zero Trust → Networks → Tunnels → Create → Docker; copy the long text after --token)"
  while :; do TT=$(ask "   Token: "); TT=${TT##*--token }; TT=${TT// /}; [ ${#TT} -ge 80 ] && break; echo "   That looks too short — copy the whole token."; done
  {
    echo "BASE_URL=https://$DOMAIN"
    echo "ADMIN_USER=$AU"
    echo "ADMIN_PASSWORD='$AP'"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "INDEXNOW_KEY=$(openssl rand -hex 16)"
    echo "TUNNEL_TOKEN=$TT"
    echo "PERSISTENT_DISK=1"
  } > .env
  echo "4) Optional: paste the lines from Admin → Keep settings on your old site (Render), then press Enter on an empty line."
  echo "   (Telegram token, social accounts, team, notification keys…). Just press Enter to skip."
  while IFS= read -r line </dev/tty; do [ -z "$line" ] && break
    case "$line" in BASE_URL=*|ADMIN_USER=*|ADMIN_PASSWORD=*|SESSION_SECRET=*|TUNNEL_TOKEN=*|DATA_DIR=*|PORT=*) continue;; [A-Z]*=*) echo "$line" >> .env;; esac
  done
  chmod 600 .env
fi

say "Building and starting (2–4 minutes the first time)"
docker compose up -d --build
say "Waiting for the site to start"
for i in $(seq 1 40); do curl -fsS -o /dev/null http://127.0.0.1:3100/robots.txt && break; sleep 3; done
if curl -fsS -o /dev/null http://127.0.0.1:3100/robots.txt; then echo "Site is running on the VPS."; else echo "The site did not start — showing its log:"; docker logs naukri-portal --tail 40; exit 1; fi
sleep 3
if docker logs naukri-tunnel 2>&1 | grep -q "Registered tunnel connection"; then echo "Cloudflare Tunnel connected."
else echo "Cloudflare Tunnel not connected yet — check the token:"; docker logs naukri-tunnel --tail 15; fi

say "Daily backup at 03:15 (kept 14 days in $DIR/backups)"
echo "15 3 * * * root docker exec naukri-portal node src/backup.js >> /var/log/naukri-backup.log 2>&1" > /etc/cron.d/naukri-portal-backup
docker exec naukri-portal node src/backup.js || true

DOMAIN=$(grep '^BASE_URL=' .env | cut -d= -f2-)
say "Done"
echo "Website:  $DOMAIN        Admin: $DOMAIN/admin"
echo "Update later:  sudo bash $DIR/deploy/install.sh"
echo "Logs:          docker logs naukri-portal --tail 50"
