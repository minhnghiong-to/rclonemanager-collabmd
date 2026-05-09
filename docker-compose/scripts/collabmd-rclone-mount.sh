#!/bin/sh
# Mount CollabMD's vault from an rclone remote using FUSE.
# Kept as a script instead of inline compose YAML so startup failures are
# visible/actionable in container logs.
set -eu

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "❌ collabmd-rclone-mount: $*"
  exit 1
}

write_config_from_env() {
  if [ -z "${COLLABMD_RCLONE_CONFIG_B64:-}" ]; then
    return 0
  fi

  tmp_config="/config/rclone.conf.tmp.$$"
  if ! printf '%s' "${COLLABMD_RCLONE_CONFIG_B64}" | base64 -d > "$tmp_config"; then
    rm -f "$tmp_config"
    fail "COLLABMD_RCLONE_CONFIG_B64 is not valid base64. Generate it with: base64 -w0 rclone.conf"
  fi

  if [ ! -s "$tmp_config" ]; then
    rm -f "$tmp_config"
    fail "COLLABMD_RCLONE_CONFIG_B64 decoded to an empty rclone.conf."
  fi

  mv "$tmp_config" /config/rclone.conf
  chmod 600 /config/rclone.conf
}

remote_name_from_path() {
  case "$1" in
    *:*) printf '%s' "${1%%:*}" ;;
    *) return 1 ;;
  esac
}

mkdir -p /config /data /cache
write_config_from_env

[ -s /config/rclone.conf ] || fail "COLLABMD_RCLONE_CONFIG_B64 or /config/rclone.conf is required."
[ -n "${COLLABMD_RCLONE_REMOTE:-}" ] || fail "COLLABMD_RCLONE_REMOTE is required. Example: gdrive:notes/collabmd"

REMOTE_NAME="$(remote_name_from_path "${COLLABMD_RCLONE_REMOTE}")" || fail "COLLABMD_RCLONE_REMOTE must include a remote name and ':' path separator. Example: gdrive:notes/collabmd"

if ! rclone --config /config/rclone.conf listremotes | grep -Fx "${REMOTE_NAME}:" >/dev/null 2>&1; then
  log "Configured remotes:"
  rclone --config /config/rclone.conf listremotes >&2 || true
  fail "remote '${REMOTE_NAME}:' was not found in /config/rclone.conf. Check COLLABMD_RCLONE_REMOTE and COLLABMD_RCLONE_CONFIG_B64."
fi

if [ ! -e /dev/fuse ]; then
  fail "/dev/fuse is not available in this container. rclone mount mode requires FUSE, SYS_ADMIN, and bind propagation; use COLLABMD_RCLONE_RUNNER_ENABLED=true on CI/hosts that do not allow FUSE."
fi

if [ ! -c /dev/fuse ]; then
  fail "/dev/fuse exists but is not a character device. Check Docker device mapping: /dev/fuse:/dev/fuse."
fi

ALLOW_NON_EMPTY="${COLLABMD_RCLONE_ALLOW_NON_EMPTY:-true}"
case "$ALLOW_NON_EMPTY" in
  true|false) ;;
  *) fail "COLLABMD_RCLONE_ALLOW_NON_EMPTY must be true or false." ;;
esac

log "✅ collabmd-rclone-mount: mounting ${COLLABMD_RCLONE_REMOTE} at /data"

set -- rclone mount "${COLLABMD_RCLONE_REMOTE}" /data \
  --config /config/rclone.conf \
  --allow-other \
  --vfs-cache-mode "${COLLABMD_RCLONE_VFS_CACHE_MODE:-writes}" \
  --cache-dir /cache \
  --dir-cache-time "${COLLABMD_RCLONE_DIR_CACHE_TIME:-1m}" \
  --poll-interval "${COLLABMD_RCLONE_POLL_INTERVAL:-1m}" \
  --umask "${COLLABMD_RCLONE_UMASK:-002}" \
  --log-level "${COLLABMD_RCLONE_LOG_LEVEL:-INFO}"

if [ "$ALLOW_NON_EMPTY" = "true" ]; then
  # /data is a Docker bind mount so rclone sees it as an existing mount point.
  # Allow mounting over that shared target so the FUSE mount propagates back to
  # the host directory consumed by the app container.
  set -- "$@" --allow-non-empty
fi

# Intentionally allow word splitting so COLLABMD_RCLONE_EXTRA_ARGS can contain
# multiple rclone CLI flags, matching the prior compose behavior.
# shellcheck disable=SC2086
exec "$@" ${COLLABMD_RCLONE_EXTRA_ARGS:-}
