#!/usr/bin/env bash
#
# ST-Auto-Sync 一键安装 / 更新脚本
#
# 用法：
#   bash install.sh /path/to/SillyTavern        # 安装到指定酒馆目录
#   bash install.sh                             # 在当前目录（酒馆根目录）安装
#
# 它会做两件事（SillyTavern 的服务端插件与前端扩展是两个独立机制）：
#   1) 服务端：plugins/st-auto-sync/            + npm install（提供 /api/plugins/st-auto-sync/* 接口）
#   2) 前端：  public/scripts/extensions/third-party/st-auto-sync/（提供设置面板 UI）
#
# 重复执行即为“更新”，不会动你的酒馆数据。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/st-plugin"
ST_DIR="${1:-$(pwd)}"

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "▶ $*"; }

[ -d "$SRC_DIR" ] || die "找不到 st-plugin 目录（请在仓库根目录运行本脚本）"

# ---- 1. 校验目标目录确实是 SillyTavern ----
[ -d "$ST_DIR" ] || die "目录不存在：$ST_DIR"
if [ ! -f "$ST_DIR/package.json" ] && [ ! -f "$ST_DIR/config.yaml" ] && [ ! -f "$ST_DIR/server.js" ]; then
    die "这看起来不是 SillyTavern 目录：$ST_DIR（没找到 package.json / config.yaml / server.js）"
fi

PLUGIN_DIR="$ST_DIR/plugins/st-auto-sync"
EXT_DIR="$ST_DIR/public/scripts/extensions/third-party/st-auto-sync"

info "SillyTavern: $ST_DIR"

# ---- 2. 服务端插件 ----
info "安装服务端插件 → plugins/st-auto-sync/"
mkdir -p "$PLUGIN_DIR"
cp -R "$SRC_DIR/." "$PLUGIN_DIR/"

if command -v npm >/dev/null 2>&1; then
    info "安装依赖（ws）…"
    (cd "$PLUGIN_DIR" && npm install --omit=dev --no-audit --no-fund --silent) \
        || echo "⚠️ npm install 失败，请手动进入 $PLUGIN_DIR 执行 npm install"
else
    echo "⚠️ 未找到 npm，请自行进入 $PLUGIN_DIR 执行 npm install"
fi

# ---- 3. 前端扩展 ----
info "安装前端扩展到 → public/scripts/extensions/third-party/st-auto-sync/"
mkdir -p "$EXT_DIR"
cp -R "$SRC_DIR/manifest.json" "$SRC_DIR/public" "$EXT_DIR/"

# ---- 4. 自检 ----
[ -f "$PLUGIN_DIR/server/index.js" ] || die "服务端文件缺失：$PLUGIN_DIR/server/index.js"
[ -d "$PLUGIN_DIR/node_modules/ws" ] || echo "⚠️ 未检测到 plugins/st-auto-sync/node_modules/ws，插件可能无法连接 Hub"
[ -f "$EXT_DIR/manifest.json" ] || die "前端 manifest 缺失：$EXT_DIR/manifest.json"
[ -f "$EXT_DIR/public/index.js" ] || die "前端脚本缺失：$EXT_DIR/public/index.js"
grep -q "info" "$PLUGIN_DIR/server/index.js" || echo "⚠️ 服务端模块似乎缺少 info 导出，SillyTavern 1.15+ 会拒绝加载"

cat <<'EOF'

✅ 安装完成。接下来：
  1. 重启 SillyTavern（服务端插件只在启动时加载）
  2. 启动日志中应出现：
       [ST-Auto-Sync] Initializing server plugin...
       [ST-Auto-Sync] Plugin server routes registered successfully.
  3. 打开酒馆 → 扩展面板（拼图图标）→ 展开「ST-Auto-Sync 多端同步」
     · 中继服务地址：http://<hub 地址>:8765   （用 HTTPS 就会自动走 wss）
     · 同步秘钥：所有设备填同一个
     · 设备名称：给这台设备起个名
  4. 确认该扩展的开关是打开的

EOF
