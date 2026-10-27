#!/usr/bin/env bash
# 一条命令内完成：启动带调试端口的 Edge → 等待端口就绪 → 实测 4 个分 P → 关闭
set -u
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
WD='C:/Users/<你的用户名>/AppData/Local/pluma-edge-copy'

echo "[1/3] 启动 Edge（profile 副本）"
"$EDGE" --remote-debugging-port=9222 \
  --user-data-dir="$WD" \
  --profile-directory=Default \
  --remote-allow-origins='*' \
  > /tmp/edge3.log 2>&1 &
EDGE_PID=$!

echo "[2/3] 等待调试端口"
for i in $(seq 1 40); do
  if curl -s --noproxy '*' --max-time 2 http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "  端口就绪（第 ${i} 次探测）"
    break
  fi
  sleep 1
done

echo "[3/3] 开始实测"
HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= ALL_PROXY= all_proxy= NO_PROXY='*' \
  node poc/probe/probe-cdp.mjs
RC=$?

# 收尾：关掉这次启动的 Edge
echo "--- 收尾 ---"
taskkill //F //IM msedge.exe > /dev/null 2>&1
exit $RC
