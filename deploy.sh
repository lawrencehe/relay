#!/usr/bin/env bash
# 用法: ./deploy.sh <ssh主机> [域名]
#   ./deploy.sh kong relay.lightup.host
# 把中继同步到远程机器的 ~/paseo-relay 并用 docker compose 启动/更新。
# 第一次部署必须给域名；之后省略则沿用远程已有的 .env。
set -euo pipefail
HOST="${1:?usage: ./deploy.sh <ssh-host> [domain]}"
DOMAIN="${2:-}"
DIR="paseo-relay"
cd "$(dirname "$0")"

ssh "$HOST" "mkdir -p ~/$DIR"
scp -q relay.mjs package.json package-lock.json Dockerfile .dockerignore Caddyfile compose.yaml "$HOST:~/$DIR/"
if [ -n "$DOMAIN" ]; then
  ssh "$HOST" "printf 'RELAY_DOMAIN=%s\n' '$DOMAIN' > ~/$DIR/.env"
fi
ssh "$HOST" "test -f ~/$DIR/.env" || { echo "远程没有 .env，请带上域名参数重新运行" >&2; exit 1; }
ssh "$HOST" "cd ~/$DIR && docker compose up -d --build && docker compose ps"

D="$(ssh "$HOST" "sed -n 's/^RELAY_DOMAIN=//p' ~/$DIR/.env")"
echo "等待证书/服务就绪..."
for i in $(seq 1 20); do
  if curl -fsS -m5 "https://$D/health" 2>/dev/null; then echo; echo "OK: https://$D/health"; exit 0; fi
  sleep 3
done
echo "健康检查未通过：检查 DNS 是否指向该机器、443 是否开放，并查看 'docker compose logs caddy'" >&2
exit 1
