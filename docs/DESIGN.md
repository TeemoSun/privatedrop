# PrivateDrop — 自托管 Edge Drop 替代品 · 设计方案（定稿）

> 项目名：**privatedrop**。认证逻辑与前端 UI 组件均手写自建（见 §3）。

## 1. 产品定位

对标 Microsoft Edge Drop：用户把自己的多台设备（电脑、手机、平板）关联到同一份数据空间，在任意设备上拖入文件或写一条笔记，其他设备即时可见、可下载。自托管部署，本地哈希文件管理，数据完全自控。

### 功能清单

**v1（核心）**
- 单密码登录（密码为环境配置，无注册/用户表）
- 设备登记：每台设备首次登录时自动注册，可在 Devices 页改名/删除（设备管理即设置入口）
- 文件拖拽上传（直接流式写入后端）、下载（零拷贝、HTTP Range 断点续传）
- SHA-256 内容寻址分片存储与秒传去重
- 文本笔记（纯文本，不产生文件）
- 文件 + 笔记混合时间线列表（倒序、游标分页）
- WebSocket 实时推送（新条目/删除在所有在线设备即时出现）
- 上传完整性校验（size + sha256）
- 孤儿对象与临时上传碎片清理

**v2（扩展点，先留接口）**
- 公开分享链接（短期 Ticket 链接，可过期）
- 图片缩略图、暗色主题、断点续传大文件分片
- 多 worker 扩容与分布式存储适配

## 2. 总体架构

```
                     ┌─────────────────────────────────────────────┐
                     │              Docker Compose                 │
  Browser (SPA)      │                                             │
 ┌─────────────┐     │   ┌───────────────────────┐    ┌────────┐   │
 │ React 18    │────►│   │  privatedrop（单容器）  │───►│PostgreSQL│   │
 │ Vite + TS   │ 8000│   │ ┌───────────┐  /api    │    │   16   │   │
 │ Tailwind 3  │     │   │ │ FastAPI   │  /ws     │    └────────┘   │
 │ TanStack Q  │     │   │ │ (uvicorn  │          │                 │
 │ shadcn-style│     │   │ │  单进程)   │          │                 │
 └─────────────┘     │   │ └───────────┘          │                 │
                     │   │ static: 前端构建产物    │                 │
                     │   │ storage: 本地哈希物理文件│                │
                     │   └───────────────────────┘                 │
                     └─────────────────────────────────────────────┘
```

- **同源部署**：前端构建产物打进 FastAPI 静态目录，一个应用容器对外服务，无 CORS 问题。
- **uvicorn 单进程**：个人应用并发极低。WS 广播（`ConnectionManager`）、限流（内存 deque）全部进程内；token 吊销不靠内存列表而是 refresh 绑定 `device_id` 查表，**因此不需要 Redis 且重启安全**。
- **本地内容寻址存储（CAS）**：文件物理路径按 `data/storage/files/{sha256[:2]}/{sha256[2:4]}/{sha256}` 分片存储，天然支持秒传与重复数据删除；下载使用 `FileResponse` 零拷贝下发。

## 3. 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 后端框架 | FastAPI + Pydantic v2 + SQLAlchemy 2 (async) | 成熟异步栈 |
| 认证 | JWT 双 token + bcrypt + refresh rotation + device_id 绑定吊销 | 无状态、无用户表；refresh 绑定设备，删设备即吊销 |
| 数据库 | PostgreSQL 16 + Alembic | 结构化元数据与引用计数管理 |
| 文件存储 | 本地内容寻址存储（CAS，SHA-256 分片） | 天然去重、秒传、零拷贝下载 |
| 实时推送 | WebSocket（FastAPI 进程内 ConnectionManager） | 单进程即可，无 Redis |
| 前端 | React 18 + Vite 5 + TS 5.5 + Tailwind 3 | 同构技术栈 |
| 前端 UI | shadcn 风格自写组件（Radix + cva + lucide-react） | 与业务零耦合，可直接维护 |
| 前端状态 | TanStack Query 5（服务端状态）+ 手写 useState | 不引全局状态库 |
| 部署 | Docker Compose 单应用容器 + db | 双容器极简部署 |
| 依赖管理 | uv（后端）+ npm（前端） | — |

## 4. 认证与设备模型

沿用**单密码单用户**设计：`APP_PASSWORD` 是唯一凭证（bcrypt 哈希存在进程内，启动时生成），无 User 表。
设备通过 JWT 载体识别（轻量扩展，保持认证无状态）：

```
登录 POST /api/auth/login  {password, device_id, device_name}
  ├─ 校验 settings.app_password（内存限流 5 次/60s/IP，进程内）
  ├─ devices 表：以 device_id 为主键 upsert（不存在则 INSERT=首次登记，存在则 UPDATE last_seen_at/name）
  └─ 签发 JWT：
       access_token:  {sub: device_id, jti: <uuid>, exp: +15m}
       refresh_token: {sub: device_id, jti: <uuid>, exp: +30d}
       devices 表持久化更新 refresh_jti = <uuid>（单飞轮换，一设备一有效 refresh）
```

## 5. 数据模型

```
devices (id UUID PK, name VARCHAR, created_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ, refresh_jti UUID)
drop_items (id UUID PK, created_by_device UUID FK->devices.id ON DELETE SET NULL, kind VARCHAR(16) CHECK IN ('file','note'), note TEXT, created_at TIMESTAMPTZ)
drop_files (id UUID PK, item_id UUID FK->drop_items.id ON DELETE CASCADE, file_name VARCHAR(1024), mime_type VARCHAR(255), size BIGINT, sha256 VARCHAR(64), uploaded_at TIMESTAMPTZ NULL)
```

## 6. 核心流程

### 6.1 上传与秒传
1. 前端计算待传文件的 SHA-256，请求 `POST /api/items`；
2. 后端检查本地存储是否已存在相同 SHA-256 文件：
   - 若已存在，直接标记 `uploaded_at`（**秒传**）；
   - 若不存在，返回上传目标端点 `/api/items/{item_id}/files/{file_id}/upload`；
3. 前端流式 `PUT` 上传文件内容，后端边接收边校验大小与 SHA-256，校验通过后原子重命名至两级分片路径；
4. `POST /api/items/{id}/upload-complete`：校验全部文件上传就绪，WS 广播 `item_created`。

### 6.2 下载
1. `GET /api/items/{id}/files/{file_id}/download-url` → 签发带短效签名 Ticket 的下载地址；
2. 浏览器打开链接，后端校验 Ticket 或 Bearer Token，返回 FastAPI `FileResponse`（Linux `sendfile` 零拷贝，支持 HTTP 206 Partial Content 断点续传）。

### 6.3 实时同步
1. 前端 `WebSocket(/api/ws?token=…)`，连接建立即注册；
2. 收到事件 → TanStack Query 失效 `items` 查询 / 乐观追加；
3. 断线：指数退避重连，重连成功用 `cursor=base64("{last_created_at},{last_id}")` 增量拉取兜底。

## 7. 部署与项目结构

`compose.yaml`（2 服务）：
- `app`：唯一对外入口，端口映射 `8000:8000`，挂载 `./data/storage:/app/data/storage`
- `db`：postgres:16，挂载 `./data/pgdata:/var/lib/postgresql/data`

启动序列：`validate_secrets()` → `ensure_storage_dirs()` → Alembic upgrade head → `create_app`。
