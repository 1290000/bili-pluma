#!/bin/sh
#
# find-node —— 给 git 钩子解析 node 可执行文件。
#
# 背景（2026-10-29）：Git 在 Windows 上通过 Git Bash 跑钩子，这个 shell 的
# PATH 不一定包含 node。DSH / WorkBuddy 等 Agent 运行时自带 node，但只在
# 它自己的进程环境里；于是钩子里的裸 `node` 报 "node: command not found"，
# 随后被误报成「暂存区含敏感信息」。
#
# 解析顺序：
#   1. NODE_BIN 环境变量（显式覆盖，最可靠）
#   2. PATH 里的 node / node.exe
#   3. 常见安装位置（Program Files / nvm / volta / fnm / ~/.local/bin）
#   4. 本机 Agent 运行时（DSH / WorkBuddy）
#
# 用法（钩子里）：
#   HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
#   . "$HOOK_DIR/lib/find-node.sh"
#   NODE=$(find_node) || { echo "找不到 node..."; exit 1; }
#   "$NODE" scripts/check-secrets.mjs ...

find_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if command -v node.exe >/dev/null 2>&1; then
    command -v node.exe
    return 0
  fi

  for candidate in \
    "/c/Program Files/nodejs/node.exe" \
    "/c/Program Files (x86)/nodejs/node.exe" \
    "$HOME/.volta/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.local/bin/node" \
    "$HOME/.dsh/dsh-runtimes"/*/dependencies/node/bin/node \
    "$HOME/.workbuddy-ai/binaries/node/versions"/*/node
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}
