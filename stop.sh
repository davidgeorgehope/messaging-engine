#!/bin/bash
cd /root/messaging-engine
echo "Stopping messaging-engine..."
pm2 stop messaging-engine
echo "✅ messaging-engine stopped"
