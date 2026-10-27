#!/usr/bin/env bash
# 启动 dtns.http-proxy 项目介绍站（默认 127.0.0.1:3016）
set -euo pipefail
cd "$(dirname "$0")"
exec node server.js
