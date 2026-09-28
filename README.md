# CoDoc 同写

多人实时协同的在线办公套件，对标飞书文档。先用 **Excel 表格** 跑通协同内核，再扩展 **Word 文档**，后续持续补齐表单、幻灯片、白板等。

核心目标：打开链接就能一起编辑，权限清晰，不丢数据。

## 功能特性

- **实时协同**：基于 Yjs（CRDT）的多人同时编辑，光标和改动实时同步，断线自动恢复。
- **表格（Sheet）**：在线电子表格，支持导入/导出 `.xlsx`（SheetJS），单元格编辑、格式、协同光标。
- **文档（Word）**：富文本文档编辑器，多人协同书写。
- **工作台**：个人文档列表、搜索、新建、删除、最近访问。
- **团队空间**：文档可归属团队，按团队维度组织与管理（TeamAdmin）。
- **权限模型**：文档归属到「人（userId）」而非临时凭证，三档权限 `查看 / 编辑 / 管理`。
- **分享与访客**：支持开放链接直接进入、或仅协作者（需申请、所有者审批）两种分享范围；访客无需注册即可凭链接参与。
- **账号与登录**：内置账号体系，会话用 HttpOnly Cookie，换浏览器/清缓存仍是同一个人；标准 OIDC 登录可插拔（飞书 / 企业微信 / Authing / Casdoor / Okta 等）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 + Vite 5 + TypeScript + Yjs + y-websocket + SheetJS |
| 后端 | Node.js + Fastify + Yjs + WebSocket（`ws`）+ `tsx` 热重载 |
| 协同内核 | Yjs CRDT，服务端按文档维护协同房间，增量落盘 |
| 数据存储 | 轻量 JSON 文件持久化（`server/data/`），无需外部数据库即可运行 |
| 部署 | 单容器 Docker（nginx + supervisord 同管前后端） |

> 说明：当前数据保存在 `server/data/` 下的 JSON 文件（文档内容、权限、用户、会话）。单机或小团队开箱即用；后续可平滑替换为数据库，接口层已隔离。

## 快速开始（本地开发）

要求 Node.js 18+。

```bash
# 1. 安装前后端依赖（一次性）
npm run install:all

# 2. 一条命令同时启动前后端
npm run dev
```

- 前端：http://localhost:5173
- 后端 API / 协同：`http://localhost:1234`

也可以分别启动：

```bash
npm run dev:server   # 仅后端（1234）
npm run dev:web      # 仅前端（5173）
```

打开 http://localhost:5173，先用「dev 登录」填一个名字即可进入工作台，新建文档、邀请协作、分享链接都能跑通。

## 项目结构

```
codoc/
├── server/            # 后端：Fastify + Yjs 协同服务
│   └── src/
│       ├── index.ts   # HTTP 接口（文档 CRUD / 分享 / 审批）
│       ├── auth.ts    # 账号、会话、dev 登录、OIDC
│       ├── perm.ts    # 权限模型（userId 归属）
│       ├── wsserver.ts# WebSocket 协同房间与权限拦截
│       └── aiSkill.ts / aiStream.ts  # AI 相关能力
├── web/               # 前端：React + Vite
│   └── src/
│       ├── pages/     # Workspace / Editor(表格) / WordEditor / Login / TeamAdmin
│       ├── store/     # 用户态、API、协同 hook
│       └── components/# GuestGate(访客申请) 等
├── docker/            # Dockerfile + nginx + supervisord 配置
├── deploy/            # 部署脚本（WSL / 通用）
├── design-system/     # 设计令牌与样式规范
├── prototype/         # 交互原型与参考素材
└── docker-compose.yml # 单容器一键部署
```

## 认证与 SSO

账号体系以 `userId` 为身份锚点，会话凭证是 `HttpOnly Cookie`，前端不保管任何令牌，WebSocket 握手自动携带。

登录方式可插拔：

- **dev 登录**（默认开启，仅本地）：无需配置，填名字即登录，用于开发调试。
- **OIDC 登录**：配置以下环境变量后即自动启用企业账号登录入口（会替代 dev 登录）。换 IdP 只改环境变量，业务代码不动。

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OIDC_ISSUER` | IdP 的 issuer 地址（配置后启用 OIDC） | 空 |
| `OIDC_CLIENT_ID` | OIDC 客户端 ID | 空 |
| `OIDC_CLIENT_SECRET` | OIDC 客户端密钥 | 空 |
| `OIDC_REDIRECT_URI` | 回调地址 | `http://localhost:1234/api/auth/callback` |
| `OIDC_SCOPES` | 请求的 scope | `openid profile email` |
| `OIDC_LABEL` | 登录按钮文案 | `企业账号` |
| `ALLOW_DEV_LOGIN` | 是否允许 dev 登录（生产建议关闭） | 未配置 OIDC 时允许 |
| `SESSION_TTL_DAYS` | 会话有效期（天） | `14` |
| `APP_ORIGIN` | 前端来源（用于回调跳转与 CORS） | `http://localhost:5173` |

> 注意：飞书 / 企业微信等扫码登录要求**公网可达的回调域名**（企业微信还要求已备案域名）。本地开发可先用 dev 登录，或用 Casdoor 等可自建的 OIDC 服务跑通，再切换到目标 IdP。

## 权限模型

- 文档归属创建者（owner），协作者分三档：`查看 / 编辑 / 管理`。
- 分享范围：`any`（开放链接，按链接权限直接进入）或 `off`（仅协作者，他人需提交申请、所有者批准后进入）。
- 权限判定基于登录账号的 `userId`，因此换设备、换浏览器、清缓存都不会把「自己创建的文档」判成无权限。

## 部署

### Docker 一键部署

```bash
docker compose up --build -d
```

默认访问地址：http://localhost:8686（端口可用 `.env` 中的 `WEB_PORT` 覆盖，默认 8686）。

文档内容通过卷挂载持久化：`./server/data:/app/server/data`，升级镜像不会丢数据。

公网部署时，在根目录 `.env` 中设置 `PUBLIC_BASE=https://你的域名`，部署脚本（`deploy/`）会自动写入。

### 部署脚本

`deploy/` 下提供通用与 WSL 环境的部署脚本（`deploy.sh` / `deploy-wsl.sh`、`build.sh`），用于构建镜像与更新线上容器。

## 数据存储

本地运行的数据全部在 `server/data/`（已被 `.gitignore` 忽略，不进版本库）：

- `docs.json`：文档元数据
- `share.json`：权限与分享记录
- `users.json` / `sessions.json`：账号与会话
- 文档协同增量：二进制落盘 + `versions/`

需要重置环境时，停止服务后清空 `server/data/` 下对应文件即可（注意这会丢弃所有文档与账号）。

## 常见问题

- **提示「你已无法访问这份文档」？** 早期版本曾因「token 即身份」导致换浏览器/入口后自己被当成陌生人。现版本已改为 userId 归属，正常登录后不会再出现；若仍遇到，多半是用了未登录的访客入口访问私有文档，按提示申请权限即可。
- **需要先登录才能建文档吗？** 是的。账号系统下建文档需登录身份以绑定归属，dev 模式下填名字即登录。
- **能接飞书/企微吗？** 可以，通过 OIDC 接入，需自备公网回调域名。
