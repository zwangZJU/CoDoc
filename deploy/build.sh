#!/usr/bin/env bash
# CoDoc 同写 · 离线部署包构建脚本（在【联网的构建机】上运行）
#
# 作用：把前后端编译产物 + 依赖打进 Docker 镜像，并导出为一个 codoc-<tag>.tar.gz，
#       拷到无外网的目标机即可用 deploy.sh 直启。
#
# 用法（构建机需要联网 + 装了 Docker）：
#   bash deploy/build.sh                 # 构建并导出为 deploy/release/codoc-latest.tar.gz
#   bash deploy/build.sh <tag>           # 指定版本，如 bash deploy/build.sh v1.2.0
#   REBUILD_BASE=1 bash deploy/build.sh  # 改了 package.json（增删依赖）后强制重建基础镜像
#
# 目标机侧：IMAGE_TAR=release/codoc-latest.tar.gz bash deploy/deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

TAG="${1:-latest}"
OUT_DIR="$ROOT/deploy/release"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

echo "==> 构建机依赖检查"
for c in docker; do
  command -v "$c" >/dev/null 2>&1 || { echo "缺少命令：$c（构建机需安装）"; exit 1; }
done
if ! docker info >/dev/null 2>&1; then
  echo "docker 无法连接。请确认 Docker 已启动（Linux 服务，或打开 Docker Desktop）。"
  exit 1
fi

# ---- 架构提示（跨架构镜像无法运行）----
IMG_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo '?')"
echo "==> 构建机 Docker 架构: $IMG_ARCH"
echo "提示：镜像含当前架构的编译产物与二进制。若目标机 CPU 架构不同（如构建机 x86_64、目标机 arm64），"
echo "      镜像无法运行——需在目标机（或同架构机）BUILD=1 联网构建，或用多架构构建（超出本脚本范围）。"

# 依赖（Dockerfile.base 里固定 FROM node:22-alpine，故无需单独拉）
echo "==> 构建基础镜像 codoc:base（需联网；首次 / 改依赖时重建）"
if [ "${REBUILD_BASE:-0}" = "1" ] || ! docker image inspect codoc:base >/dev/null 2>&1; then
  docker build -f docker/Dockerfile.base -t codoc:base .
else
  echo "==> codoc:base 已存在，跳过（REBUILD_BASE=1 强制重建）"
fi

echo "==> 构建应用镜像 codoc:latest（FROM codoc:base，含前端 build）"
docker build -f docker/Dockerfile -t codoc:latest .

echo "==> 为版本打 tag：codoc:${TAG}"
docker tag codoc:latest "codoc:${TAG}"

TAR="$OUT_DIR/codoc-${TAG}.tar.gz"
echo "==> 导出镜像（codoc:latest + codoc:base）→ $TAR"
docker save "codoc:latest" "codoc:${TAG}" "codoc:base" | gzip > "$TAR"

ls -lh "$TAR"
echo
echo "==> 完成！到目标机（无外网）：
#     1) 拷贝本文件(或整个项目) + $TAR 到目标机目录
#     2) IMAGE_TAR=$TAR bash deploy/deploy.sh    # 自动 docker load 并直启
#     也可以不指定 IMAGE_TAR：deploy.sh 会去找 \$DST/codoc-*.tar.gz"