#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-212.56.35.191}"
USER="${DEPLOY_USER:-root}"
REMOTE_PATH="${DEPLOY_REMOTE_PATH:-/app}"
TARGET="${USER}@${HOST}:${REMOTE_PATH}/"
SSHPASS='VfZ4j@9fhx!S5PqT2uWr'
export SSHPASS

cd "$ROOT"

echo ">>> git add, commit, push"
git add .
git commit -m "$(date +%Y-%m-%d)"
git push -u origin main

echo ">>> rsync"

rsync -avz --delete \
  -e 'sshpass -e ssh' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude '.env.local' \
  ./ "${TARGET}"

echo ">>> remote: deps?, build, pm2 restart + logs"
sshpass -e ssh "${USER}@${HOST}" env REMOTE_PATH="$REMOTE_PATH" bash -s <<'EOS'
set -euo pipefail
cd "$REMOTE_PATH"
HASH_FILE="$HOME/.nextjs-deploy-deps-sha"
CURRENT="$(cat package-lock.json package.json | sha256sum | awk '{print $1}')"
PRIOR=""
[[ -f "$HASH_FILE" ]] && PRIOR="$(cat "$HASH_FILE")"
if [[ ! -d node_modules ]] || [[ "$CURRENT" != "$PRIOR" ]]; then
  echo "--- npm ci (no node_modules or lock/package changed) ---"
  npm ci
  printf '%s\n' "$CURRENT" >"$HASH_FILE"
else
  echo "--- skip npm ci (deps unchanged) ---"
fi
echo "--- npm run build ---"
npm run build
echo "--- pm2 restart or start ---"
if pm2 describe next >/dev/null 2>&1; then
  pm2 restart next --update-env
else
  pm2 start npm --name next -- start
  pm2 save
fi
echo "--- pm2 list ---"
pm2 ls
echo "--- pm2 logs next (last 120) ---"
pm2 logs next --lines 120 --nostream
EOS
