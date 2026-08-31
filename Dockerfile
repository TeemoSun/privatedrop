# ---------- Stage 1: 前端构建 ----------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: 后端运行时 ----------
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.5.26 /uv /uvx /bin/
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/alembic ./alembic
COPY backend/alembic.ini ./
COPY backend/app ./app
COPY --from=frontend /app/frontend/dist ./app/static

ENV PYTHONPATH=/app
EXPOSE 8000
CMD ["/app/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
