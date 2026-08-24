#!/usr/bin/env bash
set -euo pipefail

USER="${DOCKER_USER:-pigzho}"
IMAGE="privatedrop"
DATE_TAG="$(date +%Y%m%d)"

echo "==> Building $USER/$IMAGE:latest and :$DATE_TAG"
docker build -f backend/Dockerfile -t "$USER/$IMAGE:latest" -t "$USER/$IMAGE:$DATE_TAG" .

echo "==> Pushing tags"
docker push "$USER/$IMAGE:latest"
docker push "$USER/$IMAGE:$DATE_TAG"

echo "==> Done: $USER/$IMAGE:latest, $USER/$IMAGE:$DATE_TAG"
