# AGENTS.md

自托管 Edge Drop 替代品（PrivateDrop）：React 前端 + FastAPI 后端 + PostgreSQL 16 + MinIO，单应用容器 Docker 部署。
设计文档见 `docs/DESIGN.md`，发布流程见 `docs/Docker镜像打包上传.md` 与 `docs/GitHub推送流程.md`。

## 常用命令

```bash
# 后端（需要 uv，Python >=3.12；命令必须在 backend/ 目录下执行，配置读取根目录 .env）
cd backend
uv sync                                  # 改 pyproject.toml 后执行，同步 uv.lock
uv sync --extra dev                      # 测试依赖（pytest/httpx/aiosqlite）
uv run uvicorn app.main:app --reload --port 8000
uv run pytest                            # 单文件 tests/test_api.py，sqlite 内存库，无需外部服务
uv run alembic revision --autogenerate -m "desc"   # 改 models.py 后生成迁移
uv run alembic upgrade head                        # 应用启动时也会自动迁移

# 前端（Node 20+）
cd frontend
npm install                              # 改 package.json 后执行，同步 package-lock.json
npm run dev                              # http://localhost:5173，/api 代理到 127.0.0.1:8000
npm run build                            # tsc（noUnusedLocals 严格）+ vite，必须通过

# 本地联调：后端要托管前端页面，需手动同步构建产物
cp -r frontend/dist/* backend/app/static/

# Docker（uv.lock 与 package-lock.json 必须与依赖同步，镜像用 --frozen / npm ci）
# 打包上传流程见 docs/Docker镜像打包上传.md，一键执行 scripts/docker-push.sh
docker build -t pigzho/privatedrop:latest .

# 发布
git add <files> && git commit -m "feat: 描述" && git push      # 推送到 GitHub
DOCKER_USER=pigzho bash scripts/docker-push.sh                 # 打包并推送 Docker Hub
```

## 关键约定

- **启动校验**（`main.py: validate_secrets`，会**拒绝**这组占位值）：`APP_PASSWORD`/`JWT_SECRET` 为 `admin`/`change-me`/`changeme`/`password`/`secret` 或空、或 `MINIO_ROOT_USER/PASSWORD` 为默认 `minioadmin`。本地开发配置在根目录 `.env`（gitignored，由 `backend/app/config.py` 定位到仓库根）；`compose.yaml` 还要求两者已设置（`${VAR:?}` 直接报错），`compose.dev.yaml` 给默认值可直接 `docker compose -f compose.dev.yaml up` 起 db+minio（app 容器内 uvicorn 无 --reload，改代码后需重建或改在宿主机跑）。
- **测试**：`uv run pytest`（backend/ 下）是唯一测试入口；`tests/test_api.py` 用 sqlite 内存库并把 `db.SessionLocal` 整体替换，monkeypatch 掉 MinIO 签名 URL，无需外部服务。改 `db.py` 连接逻辑时注意测试会绕过它。
- **数据库**：PostgreSQL 16，迁移由 Alembic 管理（改模型必须生成迁移），应用启动时自动 `upgrade head`。单次 `alembic revision --autogenerate` 由 `alembic/env.py` 读取 `settings.database_url`（即根目录 .env）。
- **对象存储**：MinIO 单桶 `privatedrop`，对象 key 由后端生成（`{uuid4}`），文件直传/直下（预签名 URL），后端不中转文件内容。
- **前端产物**：`frontend/dist/` 与 `backend/app/static/` 均 gitignored；镜像由 Dockerfile 多阶段构建（`frontend` 构建产物直接 COPY 进后端镜像，无需本地同步）。
- **认证**：单密码单用户，JWT 双 token（access 15min / refresh 30 天轮换），吊销列表内存实现（重启失效）；登录限流 5 次/分/IP。
- **实时同步**：WS 广播为进程内 ConnectionManager（uvicorn 单进程，勿加 `--workers`），断线重连后前端游标拉增量兜底。
- **代码结构**：后端路由在 `backend/app/api/` 下按域拆分（auth/devices/items/ws），`app/main.py` 的 lifespan 依次执行 validate_secrets → ensure_bucket → 迁移 → 密码哈希 + 启动 10 分钟间隔的过期清理任务；`static/` 目录存在时挂载 SPA（`app/` 挂载）。

## 变更检查清单

- 改 `models.py` → 生成并检查 Alembic 迁移
- 改前端 → `npm run build` 必须通过（tsc 严格模式会拒绝未使用导入）
- 改 pyproject/package.json → 同步锁文件，否则 Docker 构建失败
- 不提交：`.env`、`data/`、`frontend/dist/`、`backend/app/static/`
