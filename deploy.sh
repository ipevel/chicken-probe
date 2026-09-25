#!/usr/bin/env bash
# 一键部署 chicken-probe 养鸡探针（主题 + 联机服务）
# 从 GitHub 拉下来就能直接用，不需要手动调配置。
#
# 用法：
#   sudo bash deploy.sh [选项]
#
# 选项（全部可选，有默认值）：
#   --hub-port <n>    monitor hub 的端口（默认自动探测：9911 或 28080）
#   --domain <d>      面板域名（用于反向代理，默认自动从 nginx/1panel 探测）
#   --port <n>        联机服务监听端口（默认 7789）
#   --install-dir <p> 安装目录（默认 /opt/chicken-probe）
#   --no-theme        不装主题（只起联机服务）
#   --no-proxy        不配反向代理
#   --no-systemd      不起 systemd（前台跑，调试用）
#   --help            打印本帮助
#
# 它会自动：装依赖 → 生成 config.json → 起联机服务(systemd) → 配反向代理 → 装主题。
# 全程只读公开接口，不需要任何密钥。

set -euo pipefail

# ---- 参数解析 ----
HUB_PORT=""
DOMAIN=""
PORT=7789
INSTALL_DIR=/opt/chicken-probe
DO_THEME=1
DO_PROXY=1
DO_SYSTEMD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-port) HUB_PORT="$2"; shift 2;;
    --domain)   DOMAIN="$2"; shift 2;;
    --port)     PORT="$2"; shift 2;;
    --install-dir) INSTALL_DIR="$2"; shift 2;;
    --no-theme) DO_THEME=0; shift;;
    --no-proxy) DO_PROXY=0; shift;;
    --no-systemd) DO_SYSTEMD=0; shift;;
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -40; exit 0;;
    *) echo "未知参数: $1 (用 --help 看帮助)"; exit 1;;
  esac
done

log() { echo -e "\033[1;32m[chicken]\033[0m $*"; }
err() { echo -e "\033[1;31m[chicken]\033[0m $*" >&2; }

# ---- 0. 前置检查 ----
command -v node >/dev/null || { err "需要 Node.js 18+（含 npm）。"; exit 1; }
command -v npm  >/dev/null || { err "需要 npm。"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 18 ]]; then err "Node.js 版本太低（$NODE_MAJOR），需要 18+。"; exit 1; fi

# ---- 1. 定位/克隆仓库 ----
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "安装目录已存在，拉取最新代码…"
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || log "git pull 失败（忽略，用现有代码）"
else
  log "克隆仓库到 $INSTALL_DIR …"
  mkdir -p "$INSTALL_DIR"
  git clone --depth 1 https://github.com/ipevel/chicken-probe.git "$INSTALL_DIR" \
    || { err "克隆失败，检查网络/GitHub 访问。"; exit 1; }
fi
cd "$INSTALL_DIR"

# ---- 2. 探测 hub 端口 ----
if [[ -z "$HUB_PORT" ]]; then
  for p in 9911 28080; do
    if curl -sf --max-time 3 "http://127.0.0.1:$p/api/me" >/dev/null 2>&1; then
      HUB_PORT="$p"; break
    fi
  done
fi
if [[ -z "$HUB_PORT" ]]; then
  err "没探测到 monitor hub（试了 9911/28080 的 /api/me）。用 --hub-port 指定。"
  exit 1
fi
log "monitor hub 端口 = $HUB_PORT"

# ---- 3. 装依赖 ----
log "安装依赖（生产模式）…"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

# ---- 4. 生成 config.json（不覆盖已有）----
if [[ ! -f server/config.json ]]; then
  log "生成 server/config.json（hub=$HUB_PORT, port=$PORT）…"
  sed -e "s|http://127.0.0.1:9911|http://127.0.0.1:$HUB_PORT|" \
      -e "s/\"port\": 7789/\"port\": $PORT/" \
      server/config.example.json > server/config.json
  # 默认清空 websites（example 里的 example.com 是占位，别真去探测）
  python3 - "$INSTALL_DIR/server/config.json" <<'PY' 2>/dev/null || true
import json,sys
p=sys.argv[1]
d=json.load(open(p))
d['websites']=[]
json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)
PY
  log "已生成。可编辑 server/config.json 加「网站鸡」（websites），或留空。"
else
  log "server/config.json 已存在，保留。"
fi

# ---- 5. 起联机服务 ----
if [[ "$DO_SYSTEMD" -eq 1 ]] && command -v systemctl >/dev/null; then
  log "配置 systemd 服务 chicken-room …"
  # 网络服务不跟部署者同权限：root 部署时落到专用系统用户下跑，建不出来就退回并提醒
  SVC_USER=$(id -un)
  if [[ "$(id -u)" -eq 0 ]] && command -v useradd >/dev/null; then
    if id -u chicken-room >/dev/null 2>&1 || useradd --system --home-dir "$INSTALL_DIR" --no-create-home --shell /usr/sbin/nologin chicken-room; then
      chown -R chicken-room "$INSTALL_DIR"
      SVC_USER=chicken-room
    else
      log "建不了 chicken-room 系统用户，服务将以 $(id -un) 运行（建议手动建用户）"
    fi
  fi
  cat > /etc/systemd/system/chicken-room.service <<EOF
[Unit]
Description=Chicken Farm room (monitor theme multiplayer)
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server/index.js --config server/config.json
Restart=always
RestartSec=3
User=$SVC_USER

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now chicken-room
  sleep 1
  if curl -sf --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    log "联机服务已启动 ✓ (127.0.0.1:$PORT)"
  else
    err "服务没起来，看日志: journalctl -u chicken-room -f"
    exit 1
  fi
else
  log "前台启动联机服务（Ctrl+C 停止）…"
  exec node server/index.js --config server/config.json
fi

# ---- 6. 配反向代理 ----
if [[ "$DO_PROXY" -eq 1 ]]; then
  if [[ -z "$DOMAIN" ]]; then
    # 尝试从 nginx/1panel 探测面板域名
    DOMAIN=$(grep -rhoE 'server_name [^;]+' /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ /www/server/panel/vhost/nginx/ 2>/dev/null | awk '{print $2}' | grep -vE '^_|localhost' | head -1 || true)
  fi
  if [[ -n "$DOMAIN" ]]; then
    log "为域名 $DOMAIN 配反向代理 /room/ → 127.0.0.1:$PORT …"
    if [[ -d /www/server/panel/vhost/nginx ]]; then  # 宝塔/1panel
      CONF=/www/server/panel/vhost/nginx/chicken-room.conf
      cat > "$CONF" <<EOF
location /room/ {
    proxy_pass http://127.0.0.1:$PORT/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
}
EOF
      echo "  已写入 $CONF —— 请把它 include 进 $DOMAIN 的站点配置，或手动加 location。"
    else
      err "没找到 nginx 站点目录，跳过反向代理。请手动加:"
      echo "  location /room/ { proxy_pass http://127.0.0.1:$PORT/; proxy_http_version 1.1; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \"upgrade\"; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; }"
    fi
  else
    err "没探测到面板域名，跳过反向代理。请手动加 /room/ → $PORT 的转发。"
  fi
fi

# ---- 7. 装主题 ----
if [[ "$DO_THEME" -eq 1 ]]; then
  log "打包主题…"
  # 只吞 stdout：构建失败时 stderr 要露出来，set -e 会让部署当场停下，而不是
  # 拿着不存在的 tar 报一句看不懂的错
  npm run build:theme >/dev/null
  TAR=build/theme.tar.gz
  log "主题包: $TAR ($(du -h "$TAR" | cut -f1))"
  echo
  echo "  下一步（二选一）："
  echo "  1) hub 面板「主题 → 上传」选 $INSTALL_DIR/$TAR"
  echo "  2) 或手动解压到主题目录："
  echo "     mkdir -p /opt/monitor/data/themes/chicken-farm && tar xzf $TAR -C /opt/monitor/data/themes/chicken-farm && chown -R monitor:monitor /opt/monitor/data/themes/chicken-farm"
  echo "     然后切主题：sqlite3 /opt/monitor/data/monitor.db \"INSERT OR REPLACE INTO setting(key,value) VALUES('theme','chicken-farm');\""
fi

log "完成。鸡场联机服务在 127.0.0.1:$PORT，主题包已生成。"