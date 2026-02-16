#!/bin/bash
set -e

cd /root/messaging-engine

echo "🔨 Building backend..."
npm run build 2>&1 | tail -3

echo "🔨 Building admin UI..."
cd admin && npm run build 2>&1 | tail -3 && cd ..

echo "🧪 Running unit tests..."
npm run test:unit 2>&1 | tail -5

echo "📦 Committing..."
git add -A
if git diff --cached --quiet; then
  echo "  Nothing to commit"
else
  git commit -m "${1:-deploy: build + test + restart}"
  echo "🚀 Pushing..."
  git push origin master
fi

echo "♻️  Restarting PM2..."
pm2 restart messaging-engine --update-env
sleep 2
pm2 logs messaging-engine --lines 5 --nostream

echo "✅ Deployed!"
