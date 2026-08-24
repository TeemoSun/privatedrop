# Docker 镜像打包与上传流程

本项目通过根目录 `Dockerfile`（多阶段构建）打包镜像并上传到 Docker Hub，便于部署机器直接 `docker pull`。
## 前置条件

1. 本机已安装 Docker。
2. 已在 Docker Hub 注册账号，并在本机执行过 `docker login`（凭证存于 `~/.docker/config.json`）。
3. 当前工作目录为仓库根目录（含 `Dockerfile`、`frontend/`、`backend/`）。

## Dockerfile 说明

`Dockerfile` 为多阶段构建：

- **Stage 1 `frontend`**：基于 `node:20-alpine`，执行 `npm ci` + `npm run build`，产出前端 `dist`。
- **Stage 2 `runtime`**：基于 `python:3.12-slim`，安装 `uv`（来自 `ghcr.io/astral-sh/uv:0.11.28`，锁定版本），`uv sync --frozen --no-dev` 安装后端依赖，拷入后端代码与前端 `dist`，暴露 `8000` 端口，以 exec 形式直接运行 uvicorn。

> 注意：alembic 迁移由 `app.main.lifespan` 在容器启动时自动执行，Dockerfile 不单独运行迁移。
> 镜像声明 `VOLUME ["/data"]` 与 `HEALTHCHECK`（探测 `/api/health`）；`APP_PASSWORD` / `JWT_SECRET` 为空或占位值时容器启动直接报错退出。

## tag 命名规范

每次构建同时打两个 tag：

- `<user>/privatedrop:latest` —— 始终指向最新构建，便于部署机器稳定拉取。
- `<user>/privatedrop:<date>` —— 形如 `20260809`（YYYYMMDD），按发布日期归档，便于回滚定位。

其中 `<user>` 为 Docker Hub 用户名（本项目使用 `pigzho`）。

> **同日多次发布**：若同一天内多次构建发布，日期 tag 会被覆盖（`docker push` 同名 tag 会更新该 tag 指向的新 digest）。这是预期行为——日期 tag 始终代表当日最新构建。如需保留历史版本快照，可在日期后追加 `-v2`、`-v3` 等后缀（如 `20260809-v2`）。

## 打包与上传步骤

以下命令在仓库根目录执行。将 `<user>` 替换为实际 Docker Hub 用户名。

### 1. 构建镜像

```bash
docker build -t <user>/privatedrop:latest -t <user>/privatedrop:$(date +%Y%m%d) .
```

- 构建会走前端 `npm run build` + 后端 `uv sync` 全流程，首次较慢，后续命中 Docker 缓存。
- 同时打 `latest` 与当日日期 tag。

### 2. 登录 Docker Hub（如未登录）

```bash
docker login
```

输出 `Login Succeeded` 即可。已登录可跳过。

### 3. 推送镜像

```bash
docker push <user>/privatedrop:latest
docker push <user>/privatedrop:$(date +%Y%m%d)
```

推送完成后，部署机器 `docker pull <user>/privatedrop:latest` 即可拉取。

## 删除 tag

### 删除本地 tag

```bash
docker rmi <user>/privatedrop:<tag>
```

### 删除远程 tag（Docker Hub）

Docker CLI 不支持删除远程 tag，需通过 Docker Hub API：

```bash
# 从 ~/.docker/config.json 读取登录凭证换取 JWT
USERPASS=$(python3 -c 'import json; d=json.load(open("/home/teemo/.docker/config.json")); print(d["auths"]["https://index.docker.io/v1/"]["auth"])' | base64 -d)
USER=$(echo "$USERPASS" | cut -d: -f1)
PASS=$(echo "$USERPASS" | cut -d: -f2-)
TOKEN=$(curl -s "https://hub.docker.com/v2/users/login/" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 删除指定 tag（HTTP 204 表示成功）
curl -s -o /dev/null -w "%{http_code}\n" \
  -X DELETE "https://hub.docker.com/v2/repositories/<user>/privatedrop/tags/<tag>/" \
  -H "Authorization: JWT $TOKEN"
```

将 `<user>` 与 `<tag>` 替换为实际值。删除远程 tag 不影响镜像 digest，仅在 Docker Hub 界面移除该标签引用。

## 部署机使用远程镜像

默认端口 `19234`（compose 已定义端口与数据卷）：

```bash
cp .env.example .env   # 修改 APP_PASSWORD、JWT_SECRET、MINIO_*、DATABASE_URL 等

# 方式一：docker compose
docker compose up -d

# 方式二：docker run
docker run -d \
  -p 19234:8000 \
  -v /path/to/data:/data \
  --env-file .env \
  pigzho/privatedrop:latest
```

完整使用说明见 `README.md`。

## 一键脚本参考

仓库已提供 `scripts/docker-push.sh`（需 `chmod +x`），等效于上文构建 + 推送步骤：

```bash
DOCKER_USER=pigzho bash scripts/docker-push.sh
```

脚本内容：

```bash
#!/usr/bin/env bash
set -euo pipefail

USER="${DOCKER_USER:-pigzho}"
IMAGE="privatedrop"
DATE_TAG="$(date +%Y%m%d)"

echo "==> Building $USER/$IMAGE:latest and :$DATE_TAG"
docker build -t "$USER/$IMAGE:latest" -t "$USER/$IMAGE:$DATE_TAG" .

echo "==> Pushing tags"
docker push "$USER/$IMAGE:latest"
docker push "$USER/$IMAGE:$DATE_TAG"

echo "==> Done: $USER/$IMAGE:latest, $USER/$IMAGE:$DATE_TAG"
```
