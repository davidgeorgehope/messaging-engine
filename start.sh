#!/bin/bash
cd /root/messaging-engine
echo "Starting messaging-engine..."
pm2 start ecosystem.config.cjs --env production
sleep 2
pm2 status messaging-engine
echo "✅ messaging-engine started"
