# AGENTS.md

自托管 Edge Drop 替代品（PrivateDrop）：React 前端 + Go 后端 + PostgreSQL 16 + 本地哈希文件管理，单应用容器 Docker 部署。
设计文档见 `docs/DESIGN.md`，设备型号更新见 `docs/设备型号映射更新指南.md`，发布流程见 `docs/Docker镜像打包上传.md` 与 `docs/GitHub推送流程.md`。

## 页面与路由架构

- **`⚡ 临时中转`（`/`）**：默认首页，用于临时跨设备快传。内容与文件仅保留 24 小时，到期由后台定时任务自动物理销毁并回收磁盘空间。
- **`📊 时间线`（`/timeline`）**：永久保存的文本笔记与文件列表。
- **`🔒 隐私时间线`（`/secret`）**：隐藏私密空间。**长按「时间线」按钮（700ms）触发打开**，内容在常规时间线与临时中转中完全隔离不可见，删除同样进入回收站。
- **`⚙️ 管理`（`/manage`）**：层级式系统设置中心（类似手机设置）：
  - **设备管理**（`/manage/devices`）：查看已连接设备列表、当前设备高亮识别、重命名设备及解绑踢出设备。
  - **回收站**（`/manage/trash`）：已删除内容保留 30 天，支持查看剩余保留天数、条目恢复、单项彻底删除及一键清空回收站。

## 核心交互与设计规范

- **即时通讯（IM）式布局**：
  - 输入框固定在页面最底部（待传文件列表紧凑排列在输入框顶部，带上传进度条与一键清空）。
  - 消息流正序排列（越往上越老，新消息及初次加载自动平滑滚动至底部最新条目）。
  - **按键规范**：默认 `Enter` 发送，`Shift + Enter` 换行；已集成 `isComposing` 输入法状态检测，中文拼音选词按回车不会误发送。在「⚙️ 管理」中支持独立切换关闭回车发送（关闭后 Enter 仅换行，适合手机/平板软键盘输入）。
  - **拖拽交互**：桌面端任意区域拖拽文件进入浏览器即触发全屏悬浮提示，松手后自动加入底部输入框。
- **移动端与视口适配**：
  - 根容器统一使用 `fixed inset-0` 严格视口锚定，搭配 `interactive-widget=resizes-content`，彻底解决移动端浏览器动态地址栏/底栏展开与软键盘弹出时的内容遮挡。
  - 文件选择框显式声明 `accept="*/*"`，保证在 Android 13+ 及国产定制系统中正确触发全功能系统文件管理器（SAF）。

## 本地开发

```bash
# 环境准备：后端用 Go（>=1.25，命令在 backend/ 下执行，配置自动向上查找根目录 .env）
cd backend
go run ./cmd/server                      # 启动后端（端口 8000）

# 联调依赖（PostgreSQL，仅绑定 127.0.0.1:5432；默认密码见 compose.dev.yaml）
docker compose -f compose.dev.yaml up -d db

# 前端（Node 20+，frontend/ 下）
npm install                              # 改 package.json 后执行，同步 package-lock.json
npm run dev                              # http://localhost:5173，/api 与 /api/ws 代理到 127.0.0.1:8000
```

- 后端配置读根目录 `.env`（gitignored，由 `internal/config/config.go` 定位到仓库根），参考 `.env.example`。
- 也可 `docker compose -f compose.dev.yaml up -d --build` 全量起容器。
- 本地联调时若要让后端直接托管前端页面：`cp -r frontend/dist/* backend/cmd/server/static/` 或通过环境变量 `STATIC_PATH` 指定（平时由 Dockerfile 多阶段构建注入到 `/app/static`，无需手动同步）。

## 验证与发布

```bash
# 后端测试（backend/ 下）：唯一测试入口，tests/api_test.go，使用本地 PostgreSQL dev 容器，无需外部服务
cd backend && go test -v -count=1 ./...

# 前端类型检查 + 构建（tsc 严格模式会拒绝未使用导入，必须通过）
cd frontend && npm run build

# Docker 镜像构建（Dockerfile 内置多阶段构建，支持国内 GOPROXY 代理构建）
docker build --build-arg GOPROXY=https://goproxy.cn,direct -t ghcr.io/teemosun/privatedrop:latest .

# 发布
git add <files> && git commit -m "feat: 描述" && git push
bash scripts/docker-push.sh   # 打包并推送 GHCR，流程见 docs/Docker镜像打包上传.md
```

## 关键约定

- **启动校验**（`backend/cmd/server/main.go: validateSecrets`，不满足直接拒绝启动）：`APP_PASSWORD`/`JWT_SECRET` 为 `admin`/`change-me`/`changeme`/`password`/`secret` 或空。`compose.yaml` 还要求 `APP_PASSWORD`/`JWT_SECRET` 已设置（`${VAR:?}` 直接报错）；`compose.dev.yaml` 给默认值（dev-password 等）可开箱即用。
- **数据库与迁移**：PostgreSQL 16，Go 后端启动时自动执行幂等 Schema 迁移（`internal/database/migrations.go`），并自动同步更新 `alembic_version` 至 `0005`，保证与历史迁移完全平滑兼容。
- **文件存储与引用计数**：
  - 本地内容寻址存储（CAS），物理文件按 `data/storage/files/{sha256[:2]}/{sha256[2:4]}/{sha256}` 分片落盘。
  - 天然支持 SHA-256 去重与秒传；下载使用零拷贝并支持 HTTP Range 断点续传。
  - 删除时仅在全库引用计数为 0 时从物理磁盘真正删除（`DeleteFileIfUnreferenced`）。
- **软删除与回收站机制**：
  - 用户删除条目走软删除（`deleted_at = now()`），普通列表过滤隐藏；
  - 条目在回收站保留 30 天，支持手动恢复或手动彻底粉碎（`purge`）；
  - 彻底删除或一键清空回收站时物理删除 DB 记录并同步回收未引用的物理文件。
- **定时清理任务（`internal/worker/cleanup.go`）**：
  - 应用启动后在后台启动 10 分钟间隔的异步定时循环：
    1. **临时中转到期清理**：扫描 `is_ephemeral=true` 且 `expires_at <= now` 的条目，物理删除并广播 `item_deleted`。
    2. **回收站 30 天到期清理**：扫描 `deleted_at <= now - 30d` 的条目，物理删除 DB 记录并回收物理文件。
    3. **草稿与孤儿碎片清理**：清理超过 4×URL TTL 的未完成文件上传草稿及临时碎片文件。
    4. **撤销 JTI 过期清理**：清理过期的已撤销 access token JTI 记录。
- **认证**：单密码单用户，JWT 双 token（access 15min / refresh 30 天轮换）。登出吊销：refresh 吊销走 DB 字段 `Device.refresh_jti`（重启不失效），access 吊销走内存 jti 集合（重启失效）；前端 WS 收到 4401 会先刷新 token 再重连。登录限流 5 次/分/IP（`internal/api/deps.go: ClientIP` 从右向左取 XFF 第一个不可信跳转，杜绝伪造最左值绕过限流）。refresh 轮换为条件 UPDATE（`WHERE refresh_jti = 旧值`），并发重放必败。
- **WS 认证**：连接 `/api/ws` 后必须在 10s 内发送首条消息 `{"type":"auth","token":"<access token>"}`，校验失败/超时即以 4401 关闭；token 不进 URL（防泄漏到代理日志/浏览器历史）。
- **安全响应头**：`internal/api/router.go: securityHeaders` 中间件对所有响应注入 CSP（`script-src 'self'`，主题预置脚本因此外置为 `frontend/public/theme-init.js`，禁止在 index.html 写内联脚本）、`nosniff`、`X-Frame-Options`、`Referrer-Policy: no-referrer` 与 HSTS。
- **SPA**：当静态资源目录（`/app/static` 或环境变量 `STATIC_PATH`）存在时自动挂载 SPA，对非 `/api` 请求回退 `index.html`（深链刷新不 404）；内置路径防穿越检查；`/healthz` 为公开健康检查端点（带 `-healthcheck` CLI 标志）。
- **容器安全**：运行时镜像以非 root 用户 `app`（uid 1000）运行，`scripts/docker-entrypoint.sh` 启动时以 root 修正数据卷属主后经 `su-exec` 降权；升级旧部署首次启动自动 chown，无需手工干预。
- **实时同步**：WS 广播为高效的 Hub + Client Pump 模式，消除并发写竞态；断线重连后前端游标拉增量兜底。
- **前端产物**：`frontend/dist/` 与后端静态目录均 gitignored；镜像由 Dockerfile 多阶段构建注入。

## 变更检查清单

- 改数据结构 → 更新 `internal/database/migrations.go` 并保持幂等性
- 改前端 → `npm run build` 必须通过（tsc 严格模式会拒绝未使用导入）
- 改后端依赖 → 执行 `go mod tidy`
- 不提交：`.env`、`data/`、`frontend/dist/`、`backend/privatedrop`
