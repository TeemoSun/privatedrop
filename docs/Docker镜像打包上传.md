# Docker 镜像打包与发布流程

本项目镜像托管于 **GitHub Container Registry (`ghcr.io`)**，支持 **GitHub Actions 自动构建发布** 与 **本地一键脚本构建**。

## 自动化构建（推荐）

仓库已配置 GitHub Actions 工作流（`.github/workflows/docker-publish.yml`）：

- **触发条件**：当代码推送到 `main` 分支或发布版本标签（`v*.*.*`）时，GitHub Actions 会自动触发多阶段构建，并将镜像推送至 `ghcr.io/teemosun/privatedrop`。
- **自动标签**：
  - `latest`：始终指向 `main` 分支最新构建。
  - `YYYYMMDD`：按构建发布日期归档（如 `20260831`）。
  - `sha-xxxxxxx`：基于 Git Commit SHA。
  - `vX.Y.Z`：基于 Git Release 标签。

---

## Dockerfile 说明

`Dockerfile` 为多阶段构建（3 阶段）：

- **Stage 1 `frontend`**：基于 `node:20-alpine`，执行 `npm ci` + `npm run build`，产出前端 `dist`。
- **Stage 2 `builder`**：基于 `python:3.12-slim`，安装 `uv`（来自 `ghcr.io/astral-sh/uv:0.5.26`），`uv sync --frozen --no-dev --no-install-project` 安装后端依赖。
- **Stage 3 `runtime`**：基于 `python:3.12-slim`，从 builder 复制虚拟环境，拷入后端业务代码与前端静态产物，暴露 `8000` 端口，以 uvicorn 启动。

> 注意：alembic 迁移由 `app.main.lifespan` 在容器启动时自动执行，Dockerfile 不单独运行迁移。
> 镜像声明 `HEALTHCHECK`（探测 `/healthz`）；`APP_PASSWORD` / `JWT_SECRET` 为空或占位值时容器启动直接报错退出。

---

## 部署机使用镜像

默认端口 `8000`（配合 PostgreSQL 数据库，见 `compose.yaml`）：

```bash
cp .env.example .env   # 修改 APP_PASSWORD、JWT_SECRET 等配置

# 方式一：docker compose（推荐，带起 app + db）
docker compose up -d

# 方式二：docker run（需自行提供可达的 PostgreSQL 数据库）
docker run -d \
  --name privatedrop \
  -p 8000:8000 \
  -v "$(pwd)/data/storage:/app/data/storage" \
  --env-file .env \
  ghcr.io/teemosun/privatedrop:latest
```

> **提示**：公开镜像无需执行 `docker login`，任何机器均可直接拉取。

---

## 本地手动构建与推送（可选）

如需在本地构建并推送到 GHCR：

### 1. 登录 GitHub Container Registry

```bash
# 使用具备 packages:write 权限的 GitHub Personal Access Token (PAT) 登录
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin
```

### 2. 执行一键构建推送脚本

仓库已提供 `scripts/docker-push.sh`（需 `chmod +x`）：

```bash
bash scripts/docker-push.sh
```

或手动构建推送：

```bash
docker build -t ghcr.io/teemosun/privatedrop:latest -t ghcr.io/teemosun/privatedrop:$(date +%Y%m%d) .
docker push ghcr.io/teemosun/privatedrop:latest
docker push ghcr.io/teemosun/privatedrop:$(date +%Y%m%d)
```
