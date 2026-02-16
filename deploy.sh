#!/bin/bash
set -e
cd /root/messaging-engine

echo "📦 Installing dependencies..."
npm install --production=false 2>&1 | tail -3
cd admin && npm install 2>&1 | tail -3 && cd ..

echo "🔨 Building backend..."
npm run build 2>&1 | tail -3

echo "🔨 Building admin UI..."
cd admin && npm run build 2>&1 | tail -3 && cd ..

echo "📤 Committing and pushing..."
git add -A
git diff --cached --quiet || git commit -m "deploy: $(date +%Y-%m-%d_%H:%M:%S)"
git push origin master 2>&1 | tail -3

echo "♻️  Restarting PM2..."
pm2 restart messaging-engine --update-env
sleep 2
pm2 logs messaging-engine --lines 5 --nostream

echo "✅ Deploy complete!"
