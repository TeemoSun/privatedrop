# PrivateDrop

自托管 Edge Drop 替代品。把多台设备关联到同一份数据空间，在任意设备拖入文件或写一条笔记，其他设备即时可见、可下载。单密码登录，文件本地哈希存储管理，数据完全自控。

- 前端：React 18 + Vite 5 + TypeScript + Tailwind 3（shadcn 风格自写组件，TanStack Query）
- 后端：FastAPI + SQLAlchemy 2（async）+ PostgreSQL 16（Alembic 迁移）
- 文件存储：本地内容寻址存储（CAS），按 SHA-256 分片存储，天然去重秒传，零拷贝断点续传下载
- 实时同步：WebSocket 进程内广播，断线重连后游标增量拉取兜底
- 部署：单应用容器 + PostgreSQL，Docker Compose 一键启动

详细设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 功能

- 单密码登录（`APP_PASSWORD` 环境变量配置，无注册）
- 设备登记：每台设备首次登录自动注册，可改名/删除（删除即吊销该设备登录）
- 文件拖拽上传（直接流式写入后端，带进度）、下载（零拷贝、HTTP Range 断点续传）
- SHA-256 存储去重与秒传（相同文件瞬间完成且只占一份磁盘）
- 文本笔记（纯文本，不产生文件）
- 文件 + 笔记混合时间线（倒序、游标分页、加载更多）
- WebSocket 实时推送（新条目/删除在所有在线设备即时出现）
- 上传完整性校验（size + sha256）
- 孤儿对象与临时碎片清理（定时回收）

## 项目结构

```
privatedrop/
├── compose.yaml          # 生产（PRD）部署：app + db
├── compose.dev.yaml      # 开发（DEV）部署：app + db（带端口映射/默认值）
├── Dockerfile            # 多阶段：前端构建产物直接打进镜像
├── .env.example          # 环境变量示例
├── docs/                 # 设计文档与发布流程
├── scripts/docker-push.sh
├── backend/              # FastAPI 后端（uv 管理依赖）
│   ├── alembic/          # 数据库迁移
│   └── app/              # 应用代码（api/ config/ security/ storage/ ws/ cleanup…）
└── frontend/             # React 前端（npm 管理）
    └── src/              # 页面 / 组件 / lib（api、类型、工具）
```

## 部署（PRD）

前置条件：Docker + Docker Compose。

### 1. 准备环境变量

```bash
cp .env.example .env
# 编辑 .env，必填项（占位值会被应用启动校验拒绝）：
#   APP_PASSWORD         登录密码（强密码）
#   JWT_SECRET           JWT 签名密钥（随机长字符串）
# 可选：POSTGRES_PASSWORD / STORAGE_PATH / MAX_FILE_SIZE / UPLOAD_URL_TTL_SECONDS …
```

### 2. 启动

```bash
docker compose up -d --build
```

- 应用入口：`http://<主机>:8000`
- 首次启动自动创建存储目录并执行数据库迁移
- 日志：`docker compose logs -f app`

### 3. 数据持久化

数据保存在宿主机相对路径（无需具名卷）：

- `./data/pgdata/` — PostgreSQL 数据库数据
- `./data/storage/` — 本地文件存储数据（`files/` 分片存储与 `tmp/` 临时文件）

备份时直接备份 `data/` 目录即可。

### 4. 升级 / 停机

```bash
docker compose down       # 停服（数据保留在 ./data/）
docker compose up -d --build   # 或重建镜像后 docker compose up -d
```

## 开发（DEV）

开发模式下后端容器需要带默认值能直接启动，因此 DEV 使用独立 compose 文件：

```bash
# 1. 启动依赖（PostgreSQL，带宿主端口映射 5432，供本地后端连接）
docker compose -f compose.dev.yaml up -d db

# 2. 后端（backend/ 目录下执行，配置读取根目录 .env）
cd backend
uv sync --extra dev
# 编辑根目录 .env（参考 .env.example 注释，指向 localhost 的 db）
uv run uvicorn app.main:app --reload --port 8000

# 3. 前端（另开终端）
cd frontend
npm install
npm run dev        # http://localhost:5173，/api 与 /api/ws 代理到 127.0.0.1:8000
```

> 登录密码默认 `dev-password`（见 compose.dev.yaml）。
> DEV 数据存放在 `./data/dev/`，与 PRD 隔离。
> 也可以直接 `docker compose -f compose.dev.yaml up -d --build` 全量起容器（镜像内 uvicorn 不带 --reload，改后端代码需重建）。

### 配置校验

启动时校验以下项，不满足直接拒绝启动（`app/main.py: validate_secrets`）：

- `APP_PASSWORD` / `JWT_SECRET` 非空且不是占位值（`admin`/`change-me`/`changeme`/`password`/`secret`）

## 测试

```bash
# 后端单元测试（backend/ 下，sqlite 内存库 + 本地临时存储，无需外部服务）
cd backend && uv run pytest

# 前端类型检查 + 构建（tsc 严格模式）
cd frontend && npm run build
```

## 发布

```bash
# 构建并推送 Docker Hub（默认账号 pigzho，可 DOCKER_USER=xxx 覆盖）
DOCKER_USER=pigzho bash scripts/docker-push.sh

# GitHub 发布流程见 docs/GitHub推送流程.md
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `APP_PASSWORD` | PRD 必填 | — | 登录密码（bcrypt 哈希，启动时生成） |
| `JWT_SECRET` | PRD 必填 | — | JWT HS256 签名密钥 |
| `DATABASE_URL` | — | compose 内自动生成 | SQLAlchemy async URL |
| `STORAGE_PATH` | — | `./data/storage` | 本地物理文件存储根目录 |
| `MAX_FILE_SIZE` | — | `5368709120`（5GiB） | 单文件/条目总大小上限（字节） |
| `UPLOAD_URL_TTL_SECONDS` | — | `900` | 临时下载 Ticket 有效期（秒） |

## 常见问题

- **登录提示密码错误**：确认 `APP_PASSWORD` 已配置且未被 `validate_secrets` 拒绝（错误会直接导致启动失败并输出原因）。
- **断线重连**：WS 断开后前端指数退避重连，重连成功用游标增量拉取兜底，不会丢条目。
- **多进程部署**：WS 广播与限流为进程内实现，请勿加 `--workers`；如需扩容见 DESIGN.md §12。
