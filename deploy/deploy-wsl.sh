#!/usr/bin/env bash
# CoDoc 同写 · WSL 一键部署（单容器：nginx + 后端同镜像）
# 用法：在 WSL 的 hermes-latest 中执行
#   bash /mnt/e/workbuddy/2026-09-21-19-42-23/deploy/deploy-wsl.sh
set -euo pipefail

# Windows 源代码路径（从 WSL 通过 /mnt/e 访问）
SRC="/mnt/e/workbuddy/2026-09-21-19-42-23"
# WSL 内 ext4 工作目录（避免 /mnt 下 npm 性能与权限问题）
DST="$HOME/codoc"

echo "==> 检查 docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker，请先在 WSL 内安装 Docker（或启用 Docker Desktop 的 WSL2 集成后重试）。"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

# server/data 由容器 bind mount 持久化到 $DST/server/data，
# 属于运行数据而非源码：同步时排除，避免 Windows 端旧数据覆盖 WSL 端容器产生的新数据。
echo "==> 同步源码到 $DST （排除 node_modules / dist / _tmp / server/data）"
mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude node_modules --exclude _tmp --exclude '*.tsbuildinfo' \
    --exclude dist --exclude .git --exclude .workbuddy --exclude prototype \
    --exclude server/data \
    "$SRC/" "$DST/"
else
  ( cd "$SRC" && tar --exclude=node_modules --exclude=_tmp --exclude='*.tsbuildinfo' \
      --exclude=dist --exclude=.git --exclude=.workbuddy --exclude=prototype \
      --exclude=server/data \
      -cf - . ) | ( cd "$DST" && tar -xf - )
fi

cd "$DST"

# ---- 基础镜像（codoc:base）：系统包 + 前后端 node_modules，极少变动 ----
# 仅首次、或改了 package.json（增删依赖）时才需重建
if [ "${REBUILD_BASE:-0}" = "1" ] || ! docker image inspect codoc:base >/dev/null 2>&1; then
  echo "==> 构建基础镜像 codoc:base（仅首次 / 改依赖时需要，耗时较长）"
  docker build -f docker/Dockerfile.base -t codoc:base "$DST"
else
  echo "==> 基础镜像 codoc:base 已存在，跳过（改依赖时可用 REBUILD_BASE=1 强制重建）"
fi

echo "==> 清理残留容器/网络（如有）"
$DC down 2>/dev/null || true

# ---- 数据目录：确保挂载源存在（绑定挂载要求宿主机路径必须存在，否则会以 root 建目录） ----
mkdir -p "$DST/server/data"

# ---- 分享链接对外地址：自动写入 .env（仅当用户未显式配置过时） ----
# 优先用用户 .env 里已有的 PUBLIC_BASE；没有则自动推导当前访问地址。
# 公网部署想固定域名：在 $DST/.env 里写 PUBLIC_BASE=https://你的域名 即可。
# 宿主机对外端口（默认 8686；想换端口在 .env 里写 WEB_PORT=xxxx，或部署时 WEB_PORT=xxxx 传入）
WEB_PORT="${WEB_PORT:-8686}"
if ! grep -q '^PUBLIC_BASE=' .env 2>/dev/null; then
  WSL_IP_DERIVED="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$WSL_IP_DERIVED" ]; then
    AUTO_PUBLIC="http://$WSL_IP_DERIVED:$WEB_PORT"
  else
    AUTO_PUBLIC="http://localhost:$WEB_PORT"
  fi
  echo "PUBLIC_BASE=$AUTO_PUBLIC" >> .env
  echo "==> 已写入 .env：PUBLIC_BASE=$AUTO_PUBLIC（分享链接将使用该地址）"
fi

echo "==> 构建应用镜像并启动（FROM codoc:base → codoc:latest）"
$DC up -d --build

echo "==> 等待容器健康（最多 60s）"
for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' codoc 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then break; fi
  sleep 2
done

echo
docker ps --filter name=codoc --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

WSL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PUBLIC_BASE_FINAL="$(grep '^PUBLIC_BASE=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
echo
echo "==> 部署完成！访问地址："
echo "    Windows 浏览器： http://localhost:$WEB_PORT   （Docker Desktop + WSL2 集成时）"
[ -n "$WSL_IP" ] && echo "    WSL / 局域网：     http://$WSL_IP:$WEB_PORT"
echo "    分享链接地址：   ${PUBLIC_BASE_FINAL:-（未设置，自动推导）}"
echo
echo "管理命令（在 $DST 目录执行）："
echo "    日志：   $DC logs -f"
echo "    重启：   $DC restart"
echo "    停止：   $DC down"
