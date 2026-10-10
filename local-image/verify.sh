#!/usr/bin/env bash
# Runs verify.cjs against an image in an isolated fixture setup: an internal
# network, a throwaway MongoDB on tmpfs, the fixture model and a loopback proxy.
# Usage: bash local-image/verify.sh IMAGE EVIDENCE_DIR
set -euo pipefail
IMAGE=$1
OUT=$(realpath -m "$2")
LI=$(cd "$(dirname "$0")" && pwd)
MONGO=mongo@sha256:098862b1339f031900ca66cf8fef799e616d6324fa41b9a263f2ec899552c1ef
NET=librechat-image-verify-net
mkdir -p "$OUT"

cleanup() {
  [[ -n ${proxy:-} ]] && kill "$proxy" 2>/dev/null || true
  docker logs librechat-image-verify-app > "$OUT/app.log" 2>&1 || true
  docker rm -f librechat-image-verify-app librechat-image-verify-model librechat-image-verify-mongo >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create --internal "$NET" >/dev/null
docker run -d --name librechat-image-verify-mongo --network "$NET" \
  --tmpfs /data/db:size=2g "$MONGO" >/dev/null
docker run -d --name librechat-image-verify-model --network "$NET" --network-alias image-model \
  -v "$LI/fixtures:/fixtures:ro" --entrypoint node "$IMAGE" /fixtures/model.cjs >/dev/null
docker run -d --name librechat-image-verify-app --network "$NET" \
  -v "$LI/fixtures:/app/local-fixtures:ro" \
  -e HOST=0.0.0.0 -e PORT=3080 -e NODE_ENV=production \
  -e DOMAIN_CLIENT=http://127.0.0.1:3199 -e DOMAIN_SERVER=http://127.0.0.1:3199 \
  -e MONGO_URI=mongodb://librechat-image-verify-mongo:27017/LibreChatImageVerify \
  -e CONFIG_PATH=/app/local-fixtures/config.yaml \
  -e CREDS_KEY="$(openssl rand -hex 32)" -e CREDS_IV="$(openssl rand -hex 16)" \
  -e JWT_SECRET="$(openssl rand -hex 32)" -e JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  -e ALLOW_EMAIL_LOGIN=true -e ALLOW_REGISTRATION=true -e ALLOW_UNVERIFIED_EMAIL_LOGIN=true \
  -e SEARCH=false -e NO_INDEX=true -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  -e SCHEDULES_SINGLE_PROCESS=true \
  "$IMAGE" >/dev/null

ip=$(docker inspect librechat-image-verify-app --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}")
for _ in $(seq 90); do
  curl -sf "http://$ip:3080/health" >/dev/null && break
  sleep 2
done
curl -sf "http://$ip:3080/health" >/dev/null || { echo "app did not come up" >&2; exit 1; }

VERIFY_CONTAINER_IP=$ip node "$LI/proxy.cjs" > "$OUT/proxy.log" 2>&1 &
proxy=$!
sleep 1
VERIFY_OUTPUT=$OUT node "$LI/verify.cjs"
