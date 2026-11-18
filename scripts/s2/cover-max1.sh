#!/usr/bin/env bash
# One cold-restore check at max_containers=1. Same script as
# post-deploy-cover.sh: one container, graphs captured, no variant fan-out.
exec "$(dirname "$0")/post-deploy-cover.sh" "$@"
