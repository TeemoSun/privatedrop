# ---------- Stage 1: 前端静态资源构建 ----------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: 后端依赖构建 ----------
FROM python:3.12-slim AS builder
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.5.26 /uv /bin/uv
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project && \
    find /app/.venv -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true

# ---------- Stage 3: 极简纯净运行时 ----------
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app

WORKDIR /app

# 仅从 builder 阶段复制构建完毕的虚拟环境（彻底剥离 uv 工具、编译缓存等）
COPY --from=builder /app/.venv /app/.venv

# 复制后端业务代码与数据库迁移
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./
COPY backend/app ./app

# 仅复制前端静态产物
COPY --from=frontend /app/frontend/dist ./app/static

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
