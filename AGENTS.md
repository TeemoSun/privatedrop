# AGENTS.md

自托管 Edge Drop 替代品（PrivateDrop）：React 前端 + FastAPI 后端 + PostgreSQL 16 + 本地哈希文件管理，单应用容器 Docker 部署。
设计文档见 `docs/DESIGN.md`，发布流程见 `docs/Docker镜像打包上传.md` 与 `docs/GitHub推送流程.md`。

## 页面与路由架构

- **`⚡ 临时中转`（`/`）**：默认首页，用于临时跨设备快传。内容与文件仅保留 24 小时，到期由后台定时任务自动物理销毁并回收磁盘空间。
- **`📊 时间线`（`/timeline`）**：永久保存的文本笔记与文件列表。
- **`⚙️ 管理`（`/manage`）**：层级式系统设置中心（类似手机设置）：
  - **设备管理**（`/manage/devices`）：查看已连接设备列表、当前设备高亮识别、重命名设备及解绑踢出设备。
  - **回收站**（`/manage/trash`）：已删除内容保留 30 天，支持查看剩余保留天数、条目恢复、单项彻底删除及一键清空回收站。

## 核心交互与设计规范

- **即时通讯（IM）式布局**：
  - 输入框固定在页面最底部（待传文件列表紧凑排列在输入框顶部，带上传进度条与一键清空）。
  - 消息流正序排列（越往上越老，新消息及初次加载自动平滑滚动至底部最新条目）。
  - **按键规范**：`Enter` 直接发送，`Shift + Enter` 换行输入；已集成 `isComposing` 输入法状态检测，中文拼音选词按回车不会误发送。
  - **拖拽交互**：桌面端任意区域拖拽文件进入浏览器即触发全屏悬浮提示，松手后自动加入底部输入框。
- **移动端与视口适配**：
  - 根容器统一使用 `fixed inset-0` 严格视口锚定，搭配 `interactive-widget=resizes-content`，彻底解决移动端浏览器动态地址栏/底栏展开与软键盘弹出时的内容遮挡。
  - 文件选择框显式声明 `accept="*/*"`，保证在 Android 13+ 及国产定制系统中正确触发全功能系统文件管理器（SAF）。

## 本地开发

```bash
# 环境准备：后端用 uv（Python >=3.12，命令必须在 backend/ 下执行，配置读取根目录 .env）
cd backend
uv sync                                  # 改 pyproject.toml 后执行，同步 uv.lock
uv sync --extra dev                        # 测试依赖（pytest/httpx/aiosqlite）
uv run uvicorn app.main:app --reload --port 8000

# 联调依赖（PostgreSQL，带宿主端口映射；默认密码见 compose.dev.yaml）
docker compose -f compose.dev.yaml up -d db

# 前端（Node 20+，frontend/ 下）
npm install                              # 改 package.json 后执行，同步 package-lock.json
npm run dev                              # http://localhost:5173，/api 与 /api/ws 代理到 127.0.0.1:8000
```

- 后端配置读根目录 `.env`（gitignored，由 `backend/app/config.py` 定位到仓库根），参考 `.env.example`。
- 也可 `docker compose -f compose.dev.yaml up -d --build` 全量起容器，但镜像内 uvicorn 无 `--reload`，改后端代码需重建或改在宿主机跑。
- 本地联调时若要让后端直接托管前端页面：`cp -r frontend/dist/* backend/app/static/`（平时由 Dockerfile 多阶段构建注入，无需手动同步）。

## 验证与发布

```bash
# 后端测试（backend/ 下）：唯一测试入口，tests/test_api.py，sqlite 内存库 + 本地临时存储，无需外部服务
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

- **启动校验**（`backend/app/main.py: validate_secrets`，不满足直接拒绝启动）：`APP_PASSWORD`/`JWT_SECRET` 为 `admin`/`change-me`/`changeme`/`password`/`secret` 或空。`compose.yaml` 还要求 `APP_PASSWORD`/`JWT_SECRET` 已设置（`${VAR:?}` 直接报错）；`compose.dev.yaml` 给默认值（dev-password 等）可开箱即用。
- **数据库**：PostgreSQL 16，Alembic 管理迁移（改 `models.py` 必须生成迁移）；`alembic/env.py` 读取 `settings.database_url`（即根目录 .env），单次 autogenerate 需 db 可达。
- **文件存储与引用计数**：
  - 本地内容寻址存储（CAS），物理文件按 `data/storage/files/{sha256[:2]}/{sha256[2:4]}/{sha256}` 分片落盘。
  - 天然支持 SHA-256 去重与秒传；下载使用 `FileResponse` 零拷贝并支持 HTTP Range 断点续传。
  - 删除时仅在全库引用计数为 0 时从物理磁盘真正删除（`delete_file_if_unreferenced`）。
- **软删除与回收站机制**：
  - 用户删除条目走软删除（`deleted_at = now()`），普通列表过滤隐藏；
  - 条目在回收站保留 30 天，支持手动恢复或手动彻底粉碎（`purge`）；
  - 彻底删除或一键清空回收站时物理删除 DB 记录并同步回收未引用的物理文件。
- **定时清理任务（`cleanup.py`）**：
  - `app/main.py` 的 lifespan 启动 10 分钟间隔的后台异步循环：
    1. **临时中转到期清理**：扫描 `is_ephemeral=True` 且 `expires_at <= now` 的条目，物理删除并广播 `item_deleted`。
    2. **回收站 30 天到期清理**：扫描 `deleted_at <= now - 30d` 的条目，物理删除 DB 记录并回收物理文件。
    3. **草稿与孤儿碎片清理**：清理超过 4×URL TTL 的未完成文件上传草稿及临时碎片文件。
- **认证**：单密码单用户，JWT 双 token（access 15min / refresh 30 天轮换）。登出吊销：refresh 吊销走 DB 字段 `Device.refresh_jti`（重启不失效），access 吊销走内存 jti 集合（重启失效）；前端 WS 收到 4401 会先刷新 token 再重连。登录限流 5 次/分/IP（基于 XFF，注意伪造）。
- **SPA**：`backend/app/static/` 存在时挂载 SPA，`/{path}` catch-all 对非 `/api` 请求回退 `index.html`（深链刷新不 404）；`/healthz` 为公开健康检查端点（compose healthcheck 使用）。
- **实时同步**：WS 广播为进程内 ConnectionManager（uvicorn 单进程，勿加 `--workers`），断线重连后前端游标拉增量兜底。
- **前端产物**：`frontend/dist/` 与 `backend/app/static/` 均 gitignored；镜像由 Dockerfile 多阶段构建注入，`backend/app/static/` 存在时后端挂载 SPA。
- **测试**：改 `db.py` 连接逻辑时注意 `tests/test_api.py` 会把 `db.SessionLocal` 整体替换为 sqlite 内存库，测试会绕过真实连接逻辑。单元测试覆盖普通时间线、中转站过期清理、软删除、回收站恢复、彻底删除与 30 天清理。

## 变更检查清单

- 改 `models` → 生成并检查 Alembic 迁移
- 改前端 → `npm run build` 必须通过（tsc 严格模式会拒绝未使用导入）
- 改 pyproject/package.json → 同步锁文件，否则 Docker 构建失败
- 不提交：`.env`、`data/`、`frontend/dist/`、`backend/app/static/`
