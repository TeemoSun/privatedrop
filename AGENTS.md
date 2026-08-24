# AGENTS.md

自托管 Edge Drop 替代品（PrivateDrop）：React 前端 + FastAPI 后端 + PostgreSQL 16 + MinIO，单应用容器 Docker 部署。
设计文档见 `docs/DESIGN.md`，发布流程见 `docs/Docker镜像打包上传.md` 与 `docs/GitHub推送流程.md`。

## 常用命令

```bash
# 后端（需要 uv）
cd backend
uv sync                                  # 改 pyproject.toml 后执行，同步 uv.lock
uv run uvicorn app.main:app --reload --port 8000
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

- **启动校验**：`.env` 的 `APP_PASSWORD` / `JWT_SECRET` 为空或占位值（`admin`/`change-me`）时启动直接报错退出（`main.py: validate_secrets`）。本地开发配置在 `backend/.env`（gitignored）。
- **数据库**：PostgreSQL 16，迁移由 Alembic 管理（改模型必须生成迁移），应用启动时自动 `upgrade head`。
- **对象存储**：MinIO 单桶 `privatedrop`，对象 key 由后端生成（`{uuid4}`），文件直传/直下（预签名 URL），后端不中转文件内容。
- **前端产物**：`frontend/dist/` 与 `backend/app/static/` 均 gitignored；镜像由 Dockerfile 多阶段构建。
- **认证**：单密码单用户，JWT 双 token（access 15min / refresh 30 天轮换），吊销列表内存实现（重启失效）；登录限流 5 次/分/IP。
- **实时同步**：WS 广播为进程内 ConnectionManager（uvicorn 单进程，勿加 `--workers`），断线重连后前端游标拉增量兜底。

## 变更检查清单

- 改 `models.py` → 生成并检查 Alembic 迁移
- 改前端 → `npm run build` 必须通过（tsc 严格模式会拒绝未使用导入）
- 改 pyproject/package.json → 同步锁文件，否则 Docker 构建失败
- 不提交：`.env`、`data/`、`frontend/dist/`、`backend/app/static/`
