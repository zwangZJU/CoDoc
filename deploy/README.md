# CoDoc 同写 · 部署说明（镜像打包 + 离线一键部署）

适用场景：**目标机无外网、甚至没有 node/npm/vite（只有 Docker）**。源码在联网的「构建机」上编译成 Docker 镜像并导出，拷到目标机后 `docker load` 直用——目标机全程不联网、不需要 Node 工具链。

```
┌ 构建机（有网、有 Docker） ────────┐        ┌ 目标机（无网、有 Docker） ────────┐
│ bash deploy/build.sh          │ 拷贝 tar │ bash deploy/deploy.sh             │
│ → deploy/release/codoc-*.tar  │ ──────► │ 自动 docker load + 一键启动      │
└───────────────────────────────┘   复用    └───────────────────────────────────┘
                                             复用同一份代码 + 同一份 tar 可更新
```

---

## 0. README 设定

- 部署产物：**一个有网络/工具的「构建机」** 加 **任意无网的「目标机」**，两者都要能装 Docker。
- 镜像只在构建机生成，目标机只 `docker load`、绝不联网 pull / build。
- 代码在**构建机**上编译（`docker build` 内部完成前端 `tsc + vite build` + 后端运行），
  因此**只要构建机能联网、能跑 Docker，Linux 和 Windows（WSL/Docker）平台的构建方式完全相同**（见第 4 节）。

---

## 1. 需要的东西

| 机器 | 需要 | 不需要 |
|------|------|--------|
| 构建机 | Docker；可联网 | node/npm（构建在容器内完成）|
| 目标机 | Docker；能访问构建机产出的 tar | 外网；node/npm/vite 工具链 |

> 若你是单人 + 一台有网机：它在「构建机」上生成 tar，再拷贝到无网的部署机器即可。

---

## 2. 首次部署（离线）

全部在**构建机**上完成：

```bash
cd <项目根目录>
bash deploy/build.sh              # 默认 tag=latest，输出 deploy/release/codoc-latest.tar.gz
bash deploy/build.sh v1.2.0      # 指定版本号
REBUILD_BASE=1 bash deploy/build.sh   # 只改了 package.json（增删依赖）时，强制重建基础镜像
```

生成的离线包：`deploy/release/codoc-latest.tar.gz`（内含 `codoc:latest` 与 `codoc:base` 两个镜像）。

把 **整个项目目录**（脚本 + 代码 + 上面的 tar，`deploy/release/` 一起）拷到目标机，然后**在目标机**运行：

```bash
# 目标机（无外网）
cd <目标机上的项目目录>
bash deploy/deploy.sh
# 脚本会自动：检测 docker → 同步源码 → 若没镜像则从 release/codoc-*.tar.gz 转 load → 启动容器
```

> 为什么目标机还要带代码？`deploy.sh` 会先把源码同步到 `$HOME/codoc`（使 compose 上下文/目录结构就位、并创建 `server/data`），但**目标机绝不运行 npm/build、也不需要 node**——真正编译产物全在 tar 里。虽不能联网编译，却必须有这份源码树，所以整体拷贝即可。

可选参数（`deploy.sh`）：

| 环境变量 | 作用 |
|----------|------|
| `IMAGE_TAR=/path/codoc-xxx.tar.gz` | 指定镜像包路径（默认自动找 `deploy/release/codoc-*.tar.gz`）|
| `WEB_PORT=8080` | 改宿主映射端口（默认 8686）|
| `PUBLIC_IP=192.168.1.50` | 手动指定对外 IP，写入分享链接（默认自动/回退 localhost）|
| `DST_DIR=/data/codoc` | 改目标工作目录（默认 `$HOME/codoc`，免 /mnt 性能问题）|
| `BUILD=1` | 目标机本身可联网时，跳过镜像包直接 `up --build`（有网目标机专用）|

> `server/data`（Yjs 实时协作数据）在部署时**不会**被覆盖：它由容器 bind mount 到目标机本地的 `deploy/server/data`，与代码/代码/镜像无关，更新部署不会丢协作文档。

---

## 3. 代码修改后一键更新

**核心思想：在构建机重新 build 一次，生成**新**的 tar，拷贝到目标机重跑 deploy.sh。**

```bash
cd <项目根>
bash deploy/build.sh               # 或多用一个版本 tag: bash deploy/build.sh v1.3.0
# → deploy/release/codoc-v1.3.0.tar.gz  新包

# 把新的 tar 拷到目标机 deploy/release/ 下（覆盖旧的）
# 目标机：
cd /目标机上的项目目录
bash deploy/deploy.sh              # 自动 load 新包 → compose up 重建容器（数据卷不丢）
```

关键点：
- 改了**业务代码 / 前端**（每次）：直接 `build.sh`，无需重建基础镜像（秒级，走缓存）。
- 改了**(package.json / 依赖)**（偶尔）：用 `REBUILD_BASE=1 bash build.sh` 重建 base（node_modules 层）。
- 目标机 `deploy.sh` 检测到镜像并 `up -d`，若镜像变了会重建容器；绑定卷 `server/data` 不变，协作文档保留。

---

## 4. 编译：Linux / Windows 双平台说明

这里“编译”= 在**构建机上把前后端打成镜像**。因为编译全发生在 Docker 镜像内部，**同一份源码、同一套 build.sh，在 Linux、Windows（WSL/Docker）上都产出同样的 `codoc:latest`**，不用针对平台改 build 命令。

Linux 构建机：
```bash
bash deploy/build.sh
```

Windows 构建机（两种任选）：
1. **WSL2（推荐）**：在 WSL 里执行 Linux 版命令，直接复用同一套脚本。需要 `ssh`/`scp` 或直接在 `/mnt` 下跑。
2. **Docker Desktop（Windows 原生 PowerShell）**：用 `bash.exe` 或 WSL 里的 bash 调 `deploy/build.sh` 亦可；脚本本身是纯 bash，装个 Git Bash / WSL 即跑（不支持 cmd.exe）。

> 保证底线：**Linux 上编译一定可行**（脚本全部经 Linux/bash 验证）。若在 Windows 上不跑 bash（只装 PowerShell 无 WSL），请用第一节的 WSL/Docker 方案，或提供一个 `.ps1` 包装器（本项目未内置）。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
|------|------|
| 目标机报「未发现 codoc:latest 镜像」 | tar 没拷贝/目录不对。确认 `deploy/release/codoc-*.tar.gz` 存在或用 `IMAGE_TAR=/绝对路径/codoc-xxx.tar.gz` 指定 |
| 目标机报「docker load」找不到 docker | 目标机要先装 Docker；Docker Desktop 需开启 WSL2 集成 |
| 想换端口 | `WEB_PORT=xxxx bash deploy.sh`；要固定下来，可在 `$DST/.env` 里加一行 `WEB_PORT=xxxx`（compose 读取）|
| 想固定分享域名 | 在目标机 `$DST/.env`（默认 `$HOME/codoc/.env`，由 deploy.sh 生成）里写 `PUBLIC_BASE=https://你的域名`，比自动 IP 更稳 |
| 数据会丢吗 | 不会。「server/data」挂载在目标机本地，`build.sh`/`deploy.sh` 都排除它，更新仅重建代码镜像 |

---

## 结构速览

```
deploy/
  build.sh   # 构建机：把源码打进镜像 + 导出 tar（联网）
  deploy.sh  # 目标机：同步源码 + load 镜像 + 一键启动（离线）
  README.md  # 本文档
docker/
  Dockerfile.base  # 基础镜像：系统包(node:22-alpine + nginx+supervisor)+ 前后端 node_modules
  Dockerfile       # 应用镜像：FROM base，COPY 业务源码 + 前端 tsc/vite build
  docker-compose.yml # 项目根，服务名 codoc
```