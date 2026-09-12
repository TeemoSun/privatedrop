# syntax=docker/dockerfile:1

# ---------- Stage 1: 前端静态资源构建 ----------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: Go 后端静态编译 ----------
FROM golang:1.25-alpine AS builder
WORKDIR /app/backend
ARG GOPROXY=https://proxy.golang.org,direct
ENV CGO_ENABLED=0 \
    GOPROXY=${GOPROXY}
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags="-s -w" -o /app/privatedrop ./cmd/server

# ---------- Stage 3: 极简纯净运行时（非 root） ----------
FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates tzdata su-exec
RUN addgroup -S -g 1000 app && adduser -S -u 1000 -G app app
WORKDIR /app

COPY --from=builder /app/privatedrop /app/privatedrop
COPY --from=frontend /app/frontend/dist /app/static
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data/storage && chown -R app:app /app/data

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["/app/privatedrop", "-healthcheck"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/app/privatedrop"]
