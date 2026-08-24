# PrivateDrop — 自托管 Edge Drop 替代品 · 设计方案（定稿）

> 项目名：**privatedrop**。认证逻辑与前端 UI 组件均手写自建（见 §3）。

## 1. 产品定位

对标 Microsoft Edge Drop：用户把自己的多台设备（电脑、手机、平板）关联到同一份数据空间，在任意设备上拖入文件或写一条笔记，其他设备即时可见、可下载。自托管部署，文件存 MinIO，数据完全自控。

### 功能清单

**v1（核心）**
- 单密码登录（密码为环境配置，无注册/用户表）
- 设备登记：每台设备首次登录时自动注册，可在 Devices 页改名/删除（设备管理即设置入口）
- 文件拖拽上传（浏览器直传 MinIO）、下载
- 文本笔记（纯文本，不产生文件）
- 文件 + 笔记混合时间线列表（倒序、游标分页）
- WebSocket 实时推送（新条目/删除在所有在线设备即时出现）
- 上传完整性校验（size + sha256）
- 孤儿对象清理（上传中断残留）

**v2（扩展点，先留接口）**
- 公开分享链接（预签名短链，可过期）
- 图片缩略图、暗色主题、大文件分片（S3 Multipart）

## 2. 总体架构

```
                     ┌─────────────────────────────────────────────┐
                     │              Docker Compose                │
  Browser (SPA)      │                                            │
 ┌─────────────┐     │   ┌───────────────────────┐    ┌────────┐  │
 │ React 18    │────►│   │  privatedrop（单容器）  │───►│PostgreSQL│  │
 │ Vite + TS   │ 80  │   │ ┌───────────┐  /api    │    │   16   │  │
 │ Tailwind 3  │     │   │ │ FastAPI   │  /ws     │    └────────┘  │
 │ TanStack Q  │     │   │ │ (uvicorn  │          │                 │
 │ shadcn-style│     │   │ │  单进程)   │          │                 │
 └─────────────┘     │   │ └───────────┘          │                 │
                     │   │ static: 前端构建产物    │                 │
                     │   └───────────────────────┘                 │
                     │        文件直传直下，不经过应用容器           │
                     │   ┌────────────────────────────────────┐    │
                     │   │            MinIO (S3 API)          │    │
                     │   │   bucket: privatedrop              │    │
                     │   └────────────────────────────────────┘    │
                     └─────────────────────────────────────────────┘
```

- **同源部署**：前端构建产物打进 FastAPI 静态目录，一个应用容器对外服务，无 CORS 问题。
- **uvicorn 单进程**：个人应用并发极低。WS 广播（`ConnectionManager`）、限流（内存 deque）全部进程内；token 吊销不靠内存列表而是 refresh 绑定 `device_id` 查表，**因此不需要 Redis 且重启安全**。若未来要加 worker 扩容，再引入 Redis pub/sub。
- **文件不进 FastAPI**：上传/下载走 MinIO 预签名 URL，后端只管元数据与签发 URL，后端带宽与文件大小无关。

## 3. 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 后端框架 | FastAPI + Pydantic v2 + SQLAlchemy 2 (async) | 成熟异步栈 |
| 认证 | JWT 双 token + bcrypt + refresh rotation + device_id 绑定吊销 | 无状态、无用户表；refresh 绑定设备，删设备即吊销 |
| 数据库 | PostgreSQL 16 + Alembic | 用户确认 |
| 对象存储 | MinIO（S3 兼容） | 预签名 URL、生命周期 |
| 实时推送 | WebSocket（FastAPI 进程内 ConnectionManager） | 单进程即可，无 Redis |
| 前端 | React 18 + Vite 5 + TS 5.5 + Tailwind 3 | 同构技术栈 |
| 前端 UI | shadcn 风格自写组件（Radix + cva + tabler-icons） | 与业务零耦合，可直接维护 |
| 前端状态 | TanStack Query 5（服务端状态）+ 手写 useState | 不引全局状态库 |
| 部署 | Docker Compose 单应用容器 + db + minio | 单镜像合并 |
| 依赖管理 | uv（后端）+ npm（前端） | — |

## 4. 认证与设备模型

沿用**单密码单用户**设计：`APP_PASSWORD` 是唯一凭证（bcrypt 哈希存在进程内，启动时生成），无 User 表。
设备通过 JWT 载体识别（轻量扩展，保持认证无状态）：

```
登录 POST /api/auth/login  {password, device_id, device_name}
  ├─ 校验 settings.app_password（内存限流 5 次/60s/IP，进程内）
  ├─ devices 表：以 device_id 为主键 upsert（不存在则 INSERT=首次登记，存在则 UPDATE last_seen_at/name）
  ├─ JWT payload 增加 device_id（主键即设备标识）
  └─ 返回 {access_token, refresh_token, device_id}
```

- `device_id`：**客户端生成**的 UUIDv4，持久化于 localStorage，首次访问即生成并稳定复用；登录时上报，直接作为 `devices.id` 主键。极小概率碰撞由客户端重试生成新 UUID 解决
- 设备删除（`DELETE /api/devices/{id}`）：直接删除 `devices` 表行；该设备的 refresh token 因 payload 中的 `device_id` 在表中已不存在而被校验层拒绝，无需维护吊销列表，**重启安全**
- 其余认证语义：access 15min；refresh 30 天轮换（rotation，旧 refresh 用后即失效）；refresh 接口**仅需 refresh token**，不要求携带有效 access

## 5. 数据模型

```sql
devices                 -- 设备登记（认证是无状态的，此表仅作元数据）
  id            uuid PK                     -- 客户端生成的 UUIDv4，登录时上报
  name          text                        -- 登录时提交，可改名
  created_at    timestamptz
  last_seen_at  timestamptz                 -- 每次登录/刷新更新

drop_items              -- 时间线条目
  id                uuid PK
  created_by_device uuid NULL REFERENCES devices(id) ON DELETE SET NULL
  kind              text CHECK IN ('file','note')
  note              text NULL
  created_at        timestamptz

drop_files          -- 条目携带的文件（一条目可挂多文件）
  id          uuid PK
  item_id     uuid NOT NULL REFERENCES drop_items(id) ON DELETE CASCADE
  object_key  text UNIQUE
  file_name   text
  mime_type   text
  size        bigint
  sha256      text
  uploaded_at timestamptz NULL          -- NULL = 上传未完成
```

索引：`drop_items(created_at DESC, id DESC)`（复合索引支撑游标分页）；`drop_files(item_id)`。
约束：`kind='note'` 必须有 `note`；`kind='file'` 允许 `note` 为空或非空（可选附注）；`kind='file'` 的"就绪"判定为应用层状态机——该 item 至少有一个 `drop_files` 且全部 `uploaded_at` 非空，方在时间线查询与 WS 广播中可见。
单用户无 `user_id` 字段。

## 6. API 设计

```
POST /api/auth/login              {password, device_id, device_name} → {access, refresh, device_id}
POST /api/auth/refresh            {refresh_token}                     ← 仅需 refresh，不要求 access
POST /api/auth/logout             Bearer → 吊销当前 refresh

GET    /api/devices               → [{id, name, last_seen_at, created_at}]
PATCH  /api/devices/{id}          {name} 改名
DELETE /api/devices/{id}          删除登记（该设备 refresh 因 device_id 失效而不可再用）

GET    /api/items?cursor=&limit=20&kind=   时间线（倒序游标分页）
       cursor = base64("{created_at_iso},{id}")，按 (created_at DESC, id DESC) 翻页
POST   /api/items
       {kind, note?, files:[{file_name, mime_type, size, sha256}]}
       → {item_id, files:[{file_id, upload_url, expires_at}]}   ← 预签名 PUT 地址
POST   /api/items/{id}/upload-complete   后端校验对象 → 广播 WS
GET    /api/items/{id}/files/{file_id}/download-url → {url, expires_at}（预签名 GET）
DELETE /api/items/{id}                   → 删行 + 删对象 + 广播

WS     /api/ws?token=<access>
       事件: {"type":"item_created","item":{…}} / {"type":"item_deleted","id":…}
       只推送"就绪"条目；断线重连后前端拉增量兜底
```

## 7. 核心流程

### 7.1 上传（浏览器直传 MinIO）
1. `POST /api/items` 事务写 `drop_item` + `drop_files`（draft），生成 `{uuid4}` 对象 key，签发 PUT 预签名（15 分钟）。预签名 URL 强制要求客户端随 PUT 请求携带 `x-amz-checksum-sha256` 与 `Content-Disposition` 请求头
2. 前端计算文件 sha256（流式 Web Crypto），`fetch(upload_url, {method:'PUT', body, headers:{'x-amz-checksum-sha256':…, 'Content-Disposition':'attachment; filename*=UTF-8\'\''+enc(file_name)}, onprogress})` 直传 MinIO，显示进度
3. `POST /api/items/{id}/upload-complete`：后端 `HEAD` 对象，校验 `ContentLength==size` 且 `x-amz-checksum-sha256` 元数据匹配；全部文件就绪后标记 `uploaded_at`，WS 广播 `item_created`。多文件条目需所有文件各自上传完成才算"就绪"
4. 失败/超时：前端删除 draft；周期任务回收超时 draft（阈值 `UPLOAD_URL_TTL * 4`，默认 60 分钟）与孤儿对象

### 7.2 下载
1. `GET /api/items/{id}/files/{file_id}/download-url` → 校验归属与文件存在 → 预签名 GET（15 分钟）
2. `location.href = url` 直连 MinIO；因上传时已写入 `Content-Disposition` 元数据，浏览器下载文件名正确

### 7.3 实时同步
1. 前端 `WebSocket(/api/ws?token=…)`，连接建立即注册
2. 收到事件 → TanStack Query 失效 `items` 查询 / 乐观追加
3. 断线：指数退避重连，重连成功用 `cursor=base64("{last_created_at},{last_id}")` 增量拉取兜底

## 8. 安全设计

- 密码：`APP_PASSWORD` 环境配置，bcrypt 哈希；登录限流 5 次/分/IP（进程内 deque）
- JWT：HS256 + `jwt_secret`；access 15min / refresh 30 天轮换；refresh token payload 绑定 `device_id`，校验时查 `devices` 表，设备已删除即拒绝（重启安全，无需内存吊销列表）
- 对象 key 全由后端生成（`{uuid4}`），用户输入仅存 `file_name`，防路径穿越
- 上传时由前端随 PUT 请求写入 `Content-Disposition: attachment; filename*=UTF-8''…` 元数据与 `x-amz-checksum-sha256`，下载时 MinIO 透传，无需后端中转；`X-Content-Type-Options: nosniff` 由对象元数据或桶策略保证
- 上传时校验 `size <= MAX_FILE_SIZE`（`POST /api/items` 比对声明 size，`upload-complete` 时 HEAD 复核实际 size）+ sha256，防超量/替包
- 内部网络：仅应用容器暴露 8000；minio/db 不对外
- `.env` 不入库；`APP_PASSWORD`/`jwt_secret`/MinIO 凭证部署时必填并校验（启动时 `validate_secrets`）
- WS 鉴权用 query 参数 `?token=<access>`，token 会出现在反代/访问日志中，属已知权衡；单进程内网自托管场景可接受，公网部署建议在反代层过滤日志

## 9. 部署

`compose.yaml`（3 服务）：

| 服务 | 镜像 | 说明 |
|------|------|------|
| `app` | build `backend/Dockerfile`（多阶段） | 唯一对外入口，端口映射 `19234:8000` |
| `db` | postgres:16-alpine | 卷 `pgdata`；健康检查；无端口暴露 |
| `minio` | minio/minio | 卷 `miniodata`；console 9001 仅局域网可留 |

**Dockerfile（多阶段）**
```
Stage 1: node:20-alpine → frontend 目录 npm ci && npm run build → dist
Stage 2: python:3.12-slim → pip install -e . (uv) → COPY dist → backend/app/static
启动: uvicorn app.main:app --host 0.0.0.0 --port 8000  （单进程，勿加 --workers）
```

**main.py 启动序列**：`validate_secrets()` → `ensure_bucket()`（MinIO 幂等建桶）→ Alembic upgrade head → `create_app`。

`.env.example` 见 repo；关键项：`APP_PASSWORD`、`JWT_SECRET`、`DATABASE_URL=postgresql+asyncpg://…@db:5432/privatedrop`、`MINIO_ENDPOINT=minio:9000`、`MINIO_ROOT_USER/PASSWORD`、`MINIO_BUCKET=privatedrop`、`MAX_FILE_SIZE=5368709120`、`UPLOAD_URL_TTL_SECONDS=900`。

## 10. 项目结构

```
privatedrop/
├── compose.yaml
├── .env.example
├── docs/
│   ├── DESIGN.md                 # 本设计文档
│   ├── Docker镜像打包上传.md     # Docker Hub 发布流程
│   └── GitHub推送流程.md         # GitHub 发布流程
├── scripts/
│   └── docker-push.sh            # 一键打包推送 Docker Hub
├── backend/
│   ├── Dockerfile
│   ├── pyproject.toml / uv.lock
│   ├── alembic/
│   ├── app/
│   │   ├── main.py            # validate_secrets → ensure_bucket → SPA 静态托管
│   │   ├── config.py          # pydantic-settings
│   │   ├── db.py              # async engine/session
│   │   ├── models.py          # devices / drop_items / drop_files
│   │   ├── schemas.py         # auth + items/devices
│   │   ├── security.py        # bcrypt / JWT / 吊销
│   │   ├── storage.py         # MinIO 预签名、HEAD 校验、ensure_bucket
│   │   ├── ws.py              # ConnectionManager（进程内）
│   │   ├── cleanup.py         # APScheduler：孤儿 draft/对象清理
│   │   └── api/
│   │       ├── auth.py        # 登录 + 设备登记
│   │       ├── deps.py        # require_auth 依赖
│   │       ├── devices.py
│   │       ├── items.py
│   │       └── ws.py
│   └── tests/
└── frontend/
    ├── package.json
    ├── package-lock.json
    ├── vite.config.ts         # dev proxy /api → 127.0.0.1:8000
    ├── tailwind.config.js
    ├── tsconfig.json
    └── src/
        ├── index.css          # :root HSL 主题令牌
        ├── main.tsx / App.tsx # RequireAuth + 路由
        ├── lib/
        │   ├── api.ts         # fetch 封装；401 自动刷新单飞
        │   ├── utils.ts       # cn() 工具
        │   ├── format.ts      # dayjs 格式化工具
        │   └── types.ts       # Item / Device / WS 事件类型
        ├── components/
        │   ├── ui/            # 基础原语组件（Button/Input/Dialog/…）
        │   ├── AppShell.tsx   # 布局外壳（侧边栏 + 移动端 TabBar）
        │   ├── DropZone.tsx   # 拖拽上传（原生 DnD + 进度）
        │   └── ItemCard.tsx   # 时间线条目卡（文件/笔记）
        └── pages/
            ├── Login.tsx
            ├── DropBoard.tsx
            └── Devices.tsx
```

## 11. 开发流程

- 本地：`docker compose up -d db minio` → 后端 `uvicorn app.main:app --reload`（.env 指 localhost 的 db/minio）→ 前端 `vite dev`（proxy `/api` → :8000）
- 测试：`pytest`（auth/items/devices 路由 + MinIO 集成用 `minio/minio` 容器）
- 发布：`docker compose up -d --build`；日志 `docker compose logs -f app`

## 12. v2 扩展点（留接口，不实现）

- 分享链接：`GET /api/items/{id}/share` → 短 token 链接，MinIO 配桶策略只读前缀
- 缩略图：上传完成后异步 Pillow 裁剪写回 MinIO，`drop_files` 加 `thumb_key`
- 大文件分片：S3 Multipart（Initiate → 逐片预签名 → Complete）
- 多 worker 扩容：引入 Redis pub/sub 广播 + 分布式限流（当前单进程架构已为此留出 `ws.py` 接口）

## 13. 决策记录（ADR）

1. **单用户（认证复用）**：单密码无用户表，不引入账号体系；如需多用户，把 `security.py` 骨架 + 密码校验改为查 User 表即可，耦合度低。
2. **PostgreSQL 16**：用户确认。虽单用户 SQLite 够用，但 PG 为后续多用户/分享链接铺路；元数据量小，运维成本低。
3. **单镜像合并部署**：同源无 CORS，单容器即可上线；前后端仍保持独立代码目录与独立 dev 流程。
4. **无 Redis**：单进程下 WS/限流全部进程内；设备吊销改为"refresh 绑定 device_id + 查表"而非内存吊销列表，故重启安全且无需 Redis。`ws.py` 已抽象广播接口，将来拆 worker 时再补 Redis pub/sub。
5. **直传 vs 中转**：直传省后端带宽；代价是客户端须直连 MinIO（内网自托管无问题；公网场景给 MinIO 加 Nginx+TLS 即可，预签名与代理兼容）。
6. **单桶单前缀**：对象 key 形如 `{uuid4}`（每个文件一个根级 uuid），天然隔离，无需每设备一桶/前缀。
7. **完整性校验用 S3 checksum 头**：预签名 PUT 强制 `x-amz-checksum-sha256`，MinIO 存为对象元数据，HEAD 即可取回校验，无需后端读文件内容，契合"文件不进 FastAPI"。
8. **下载文件名靠 PUT 元数据**：上传时写入 `Content-Disposition`，GET 透传，避免后端中转下载流。
