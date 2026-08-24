# AGENTS.md

自托管 Edge Drop 替代品（PrivateDrop）：React 前端 + FastAPI 后端 + PostgreSQL 16 + MinIO，单应用容器 Docker 部署。
设计文档见 `docs/DESIGN.md`，发布流程见 `docs/Docker镜像打包上传.md` 与 `docs/GitHub推送流程.md`。

## 本地开发

```bash
# 环境准备：后端用 uv（Python >=3.12，命令必须在 backend/ 下执行，配置读取根目录 .env）
cd backend
uv sync                                  # 改 pyproject.toml 后执行，同步 uv.lock
uv sync --extra dev                        # 测试依赖（pytest/httpx/aiosqlite）
uv run uvicorn app.main:app --reload --port 8000

# 联调依赖（PostgreSQL + MinIO，带宿主端口映射；默认密码见 compose.dev.yaml）
docker compose -f compose.dev.yaml up -d db minio

# 前端（Node 20+，frontend/ 下）
npm install                              # 改 package.json 后执行，同步 package-lock.json
npm run dev                              # http://localhost:5173，/api 与 /api/ws 代理到 127.0.0.1:8000
```

- 后端配置读根目录 `.env`（gitignored，由 `backend/app/config.py` 定位到仓库根），参考 `.env.example`。
- 也可 `docker compose -f compose.dev.yaml up -d --build` 全量起容器，但镜像内 uvicorn 无 `--reload`，改后端代码需重建或改在宿主机跑。
- 本地联调时若要让后端直接托管前端页面：`cp -r frontend/dist/* backend/app/static/`（平时由 Dockerfile 多阶段构建注入，无需手动同步）。

## 验证与发布

```bash
# 后端测试（backend/ 下）：唯一测试入口，tests/test_api.py，sqlite 内存库 + MinIO 打桩，无需外部服务
uv run pytest

# 前端类型检查 + 构建（tsc 严格模式会拒绝未使用导入，必须通过）
npm run build

# 数据库迁移（backend/ 下；应用启动时也会自动 upgrade head）
uv run alembic revision --autogenerate -m "desc"
uv run alembic upgrade head

# Docker（uv.lock 与 package-lock.json 必须与依赖同步，镜像内用 --frozen / npm ci）
docker build -t pigzho/privatedrop:latest .

# 发布
git add <files> && git commit -m "feat: 描述" && git push
DOCKER_USER=pigzho bash scripts/docker-push.sh   # 打包并推送 Docker Hub，流程见 docs/Docker镜像打包上传.md
```

## 关键约定

- **启动校验**（`backend/app/main.py: validate_secrets`，不满足直接拒绝启动）：`APP_PASSWORD`/`JWT_SECRET` 为 `admin`/`change-me`/`changeme`/`password`/`secret` 或空，或 `MINIO_ROOT_USER/PASSWORD` 为默认 `minioadmin`。`compose.yaml` 还要求 `APP_PASSWORD`/`JWT_SECRET` 已设置（`${VAR:?}` 直接报错）；`compose.dev.yaml` 给默认值（dev-password 等）可开箱即用。
- **数据库**：PostgreSQL 16，Alembic 管理迁移（改 `models.py` 必须生成迁移）；`alembic/env.py` 读取 `settings.database_url`（即根目录 .env），单次 autogenerate 需 db 可达。
- **对象存储**：MinIO 单桶 `privatedrop`，对象 key 由后端生成（`{uuid4}`），文件浏览器直传/直下（预签名 URL），后端不中转文件内容。**预签名 URL 使用 `MINIO_PUBLIC_ENDPOINT`**（浏览器可达地址，如 `localhost:9000`），内部访问仍走 `MINIO_ENDPOINT`；容器部署必须两者都配好，否则文件功能不可用。
- **认证**：单密码单用户，JWT 双 token（access 15min / refresh 30 天轮换）。登出吊销：refresh 吊销走 DB 字段 `Device.refresh_jti`（重启不失效），access 吊销走内存 jti 集合（重启失效）；前端 WS 收到 4401 会先刷新 token 再重连。登录限流 5 次/分/IP（基于 XFF，注意伪造）。
- **SPA**：`backend/app/static/` 存在时挂载 SPA，`/{path}` catch-all 对非 `/api` 请求回退 `index.html`（深链刷新不 404）；`/healthz` 为公开健康检查端点（compose healthcheck 使用）。
- **实时同步**：WS 广播为进程内 ConnectionManager（uvicorn 单进程，勿加 `--workers`），断线重连后前端游标拉增量兜底。
- **前端产物**：`frontend/dist/` 与 `backend/app/static/` 均 gitignored；镜像由 Dockerfile 多阶段构建注入，`backend/app/static/` 存在时后端挂载 SPA。
- **测试**：改 `db.py` 连接逻辑时注意 `tests/test_api.py` 会把 `db.SessionLocal` 整体替换为 sqlite 内存库并 monkeypatch 掉 MinIO 签名 URL，测试会绕过真实连接逻辑。`test_cleanup_preserves_notes_and_ready_files` 直接调 `cleanup._cleanup_stale_drafts` 验证笔记不被误删；`test_spa_fallback_serves_index_for_deep_links` 验证深链回退。
- **代码结构**：后端路由在 `backend/app/api/` 下按域拆分（auth/devices/items/ws），`app/main.py` 的 lifespan 依次执行 validate_secrets → ensure_bucket → 迁移 → 密码哈希 → 启动 10 分钟间隔的过期清理任务（`cleanup.py` 只清理超过 4×URL TTL 的 file 草稿，**绝不删除 note**）。

## 变更检查清单

- 改 `models` → 生成并检查 Alembic 迁移
- 改前端 → `npm run build` 必须通过（tsc 严格模式会拒绝未使用导入）
- 改 pyproject/package.json → 同步锁文件，否则 Docker 构建失败
- 不提交：`.env`、`data/`、`frontend/dist/`、`backend/app/static/`
