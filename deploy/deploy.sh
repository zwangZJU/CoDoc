#!/usr/bin/env bash
# CoDoc 同写 · 一键部署（单容器：nginx + 后端同镜像）
# 可移植：可 WSL / 裸 Linux / macOS**** 上运行；代码 + 镜像可拷贝到其他机器部署。
# 用法：
#   bash deploy/deploy.sh                       # 在当前机器上部署
#   SRC_DIR=/path/to/project bash deploy/deploy.sh   # 指定源码目录
#   PUBLIC_IP=192.168.1.50 bash deploy/deploy.sh     # 手动指定对外 IP
set -euo pipefail

# ---- 源码目录：默认取脚本所在目录的父目录（deploy/ 的上一级 = 项目根）----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SRC_DIR:-$(dirname "$SCRIPT_DIR")}"

# 目标工作目录（避免 /mnt 下的性能与权限问题；可用 DST_DIR 覆盖，例如指向本地 ext4/磁盘）
DST="${DST_DIR:-$HOME/codoc}"

# 对外端口与 IP（可用 WEB_PORT / PUBLIC_IP 覆盖）
WEB_PORT="${WEB_PORT:-8686}"
# 离线部署镜像包路径（docker load 用）；不指定时自动查找 $DST 下的 codoc-*.tar.gz
IMAGE_TAR="${IMAGE_TAR:-}"
# 构建模式开关：BUILD=1 表示在目标机上联网重build（开发/有网环境）
BUILD="${BUILD:-0}"

echo "==> 源码目录: $SRC"
echo "==> 目标目录: $DST"
if [ ! -d "$SRC" ]; then
  echo "错误：源码目录不存在：$SRC"
  echo "  请把脚本放到项目根目录的 deploy/ 子目录，或用 SRC_DIR=/path bash deploy/deploy.sh 指定。"
  exit 1
fi

echo "==> 检查 docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker，请先安装 Docker（或用 Docker Desktop）。"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

# ---- 架构检查：镜像跨架构无法运行 ----
IMG_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo '?')"
echo "==> 目标机 Docker 架构: $IMG_ARCH"

# server/data 由容器持久化到 $DST/server/data，同步时排除
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

# ---- 基础镜像（codoc:base）：系统包 + node_modules，极少改动 ----
# 仅在显式离线构建（BUILD=1）或强制重建（REBUILD_BASE=1）时联网 build；
# 纯镜像部署（导入镜像启动）不碰它，避免误拉 node:22-alpine 导致联网失败。
if [ "${BUILD:-0}" = "1" ] || [ "${REBUILD_BASE:-0}" = "1" ]; then
  if [ "${REBUILD_BASE:-0}" = "1" ] || ! docker image inspect codoc:base >/dev/null 2>&1; then
    echo "==> 构建基础镜像 codoc:base（仅首次 / 改依赖时需要，需联网）"
    docker build -f docker/Dockerfile.base -t codoc:base "$DST"
  else
    echo "==> 基础镜像 codoc:base 已存在，跳过（REBUILD_BASE=1 可强制重建）"
  fi
else
  echo "==> 跳过基础镜像构建（纯镜像部署模式；需本地构建时加 BUILD=1）"
fi

echo "==> 清理残留容器/网络（如有）"
$DC down 2>/dev/null || true

mkdir -p "$DST/server/data"

# ---- 分享链接对外地址 ----
# 优先级：① .env 已配置 PUBLIC_BASE ② 环境变量 PUBLIC_IP ③ 自动探测；没有再回退 localhost。
if ! grep -q '^PUBLIC_BASE=' .env 2>/dev/null; then
  AUTO_PUBLIC=""
  if [ -n "${PUBLIC_IP:-}" ]; then
    AUTO_PUBLIC="http://$PUBLIC_IP:$WEB_PORT"
  else
    # 跨平台探测本机 IP（Linux / macOS）
    DETECTED_IP=""
    if command -v hostname >/dev/null 2>&1; then
      if hostname -I >/dev/null 2>&1; then
        DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
      elif hostname -i >/dev/null 2>&1; then
        DETECTED_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
      fi
    fi
    [ -n "$DETECTED_IP" ] && AUTO_PUBLIC="http://$DETECTED_IP:$WEB_PORT"
  fi
  if [ -n "$AUTO_PUBLIC" ]; then
    echo "PUBLIC_BASE=$AUTO_PUBLIC" >> .env
    echo "==> 已写入 .env：PUBLIC_BASE=$AUTO_PUBLIC（分享链接将使用该地址）"
  else
    echo "PUBLIC_BASE=http://localhost:$WEB_PORT" >> .env
    echo "==> 无法自动探测 IP，PUBLIC_BASE 回退 http://localhost:$WEB_PORT（可用 PUBLIC_IP=... 覆盖）"
  fi
fi

# ---- 应用镜像：离线场景优先用导入镜像直启，否则在目标机上联网构建 ----
HAS_LATEST=0
docker image inspect codoc:latest >/dev/null 2>&1 && HAS_LATEST=1

if [ "$BUILD" = "1" ]; then
  echo "==> BUILD=1：在目标机上联网构建并启动 codoc:latest"
  $DC up -d --build
elif [ "$HAS_LATEST" = "1" ]; then
  echo "==> 检测到 codoc:latest 已存在，直接启动（离线/增量模式）"
  $DC up -d
else
  # 无镜像且未要求联网构建 → 无回退尝试导入镜像包
  local_tar="$IMAGE_TAR"
  [ -z "$local_tar" ] && local_tar="$( { ls -1 "$DST"/codoc-*.tar.gz "$DST"/deploy/release/codoc-*.tar.gz 2>/dev/null; } | head -1 || true)"
  if [ -n "$local_tar" ] && [ -f "$local_tar" ]; then
    echo "==> 从镜像包导入并直启：$local_tar"
    docker load -i "$local_tar"
    $DC up -d
  else
    echo "==> 未发现 codoc:latest 镜像，也未找到镜像包（$DST/codoc-*.tar.gz）。"
    echo "    · 离线部署：请先把镜像包拷到目标机，用 IMAGE_TAR=/路径/codoc-xxx.tar.gz 指定"
    echo "    · 或目标机有网：BUILD=1 bash deploy/deploy.sh 直接联网构建"
    exit 1
  fi
fi

echo "==> 等待容器健康（最多 60s）"
for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' codoc 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then break; fi
  sleep 2
done

echo
docker ps --filter name=codoc --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

DETECTED_IP=""
if command -v hostname >/dev/null 2>&1; then
  hostname -I >/dev/null 2>&1 && DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$DETECTED_IP" ] && command -v hostname >/dev/null 2>&1 && \
    hostname -i >/dev/null 2>&1 && DETECTED_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
fi
PUBLIC_BASE_FINAL="$(grep '^PUBLIC_BASE=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
echo
echo "==> 部署完成！访问地址："
echo "    本机浏览器：     http://localhost:$WEB_PORT"
[ -n "$DETECTED_IP" ] && echo "    局域网访问：     http://$DETECTED_IP:$WEB_PORT"
echo "    分享链接地址：   ${PUBLIC_BASE_FINAL:-（未配置，使用 localhost）}"
echo
echo "管理命令（在 $DST 目录执行）："
echo "    日志：   $DC logs -f"
echo "    重启：   $DC restart"
echo "    停止：   $DC down"