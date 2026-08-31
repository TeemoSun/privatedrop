#!/usr/bin/env bash
set -euo pipefail

USER="${GHCR_USER:-teemosun}"
REGISTRY="${GHCR_REGISTRY:-ghcr.io}"
IMAGE="${REGISTRY}/${USER}/privatedrop"
DATE_TAG="$(date +%Y%m%d)"

echo "==> Building $IMAGE:latest and :$DATE_TAG"
docker build -t "$IMAGE:latest" -t "$IMAGE:$DATE_TAG" .

echo "==> Pushing tags"
docker push "$IMAGE:latest"
docker push "$IMAGE:$DATE_TAG"

echo "==> Done: $IMAGE:latest, $IMAGE:$DATE_TAG"
