#!/bin/sh
# Sync CollabMD's runner-local vault to an rclone remote without FUSE.
# This favors data safety on ephemeral CI runners: remote deletes are disabled
# by default, local writes are flushed frequently, and SIGTERM triggers one last
# upload before the container exits.
set -eu

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "❌ collabmd-rclone-runner-sync: $*"
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

mkdir -p /config /data
write_config_from_env

if [ ! -s /config/rclone.conf ]; then
  fail "COLLABMD_RCLONE_CONFIG_B64 or /config/rclone.conf is required."
fi

if [ -z "${COLLABMD_RCLONE_REMOTE:-}" ]; then
  fail "COLLABMD_RCLONE_REMOTE is required. Example: gdrive:notes/collabmd"
fi

SYNC_INTERVAL="${COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC:-20}"
PULL_INTERVAL="${COLLABMD_RCLONE_RUNNER_PULL_INTERVAL_SEC:-120}"
SYNC_EXTRA_ARGS="${COLLABMD_RCLONE_RUNNER_SYNC_EXTRA_ARGS:---fast-list --metadata --transfers 8 --checkers 16}"
RCLONE="rclone --config /config/rclone.conf --log-level ${COLLABMD_RCLONE_LOG_LEVEL:-INFO}"
REMOTE="${COLLABMD_RCLONE_REMOTE}"

copy_remote_to_local() {
  echo "Pulling remote changes from ${REMOTE} to /data ..."
  # copy avoids local deletion if the remote was accidentally emptied.
  # shellcheck disable=SC2086
  $RCLONE copy "$REMOTE" /data $SYNC_EXTRA_ARGS
}

default_backup_root() {
  remote_name="${REMOTE%%:*}"
  remote_path="${REMOTE#*:}"

  # A root destination like "drive:" has no non-overlapping same-remote
  # backup location that rclone can safely infer. Users can still set
  # COLLABMD_RCLONE_RUNNER_BACKUP_DIR explicitly for that layout.
  if [ "$remote_path" = "$REMOTE" ] || [ -z "$remote_path" ]; then
    return 0
  fi

  parent="${remote_path%/*}"
  base="${remote_path##*/}"
  if [ "$parent" = "$remote_path" ]; then
    printf '%s:.collabmd-runner-backups/%s' "$remote_name" "$base"
  else
    printf '%s:%s/.collabmd-runner-backups/%s' "$remote_name" "$parent" "$base"
  fi
}

backup_dir_for_push() {
  if [ -n "${COLLABMD_RCLONE_RUNNER_BACKUP_DIR:-}" ]; then
    printf '%s/%s' "${COLLABMD_RCLONE_RUNNER_BACKUP_DIR%/}" "$(date -u +%Y%m%dT%H%M%SZ)"
    return 0
  fi

  backup_root="$(default_backup_root)"
  if [ -n "$backup_root" ]; then
    printf '%s/%s' "$backup_root" "$(date -u +%Y%m%dT%H%M%SZ)"
  fi
}

push_local_to_remote() {
  backup_dir="$(backup_dir_for_push)"
  if [ "${COLLABMD_RCLONE_RUNNER_DELETE_REMOTE:-false}" = "true" ]; then
    if [ -n "$backup_dir" ]; then
      echo "Syncing /data to ${REMOTE} with remote delete enabled; changed remote files backup to ${backup_dir} ..."
      # shellcheck disable=SC2086
      $RCLONE sync /data "$REMOTE" --backup-dir "$backup_dir" $SYNC_EXTRA_ARGS
    else
      echo "Syncing /data to ${REMOTE} with remote delete enabled; no safe non-overlapping backup dir inferred ..."
      # shellcheck disable=SC2086
      $RCLONE sync /data "$REMOTE" $SYNC_EXTRA_ARGS
    fi
  else
    if [ -n "$backup_dir" ]; then
      echo "Copying /data to ${REMOTE} without deleting remote files; overwritten remote files backup to ${backup_dir} ..."
      # shellcheck disable=SC2086
      $RCLONE copy /data "$REMOTE" --backup-dir "$backup_dir" $SYNC_EXTRA_ARGS
    else
      echo "Copying /data to ${REMOTE} without deleting remote files; no safe non-overlapping backup dir inferred ..."
      # shellcheck disable=SC2086
      $RCLONE copy /data "$REMOTE" $SYNC_EXTRA_ARGS
    fi
  fi
}

term_handler() {
  echo "Termination received; performing final CollabMD vault upload."
  push_local_to_remote || true
  exit 0
}
trap term_handler INT TERM

if [ "${COLLABMD_RCLONE_RUNNER_INITIAL_PULL:-true}" = "true" ]; then
  copy_remote_to_local || echo "Initial remote pull failed; continuing so local edits can still be uploaded." >&2
fi

touch /tmp/collabmd-runner-sync-ready

last_pull=0
while :; do
  push_local_to_remote || echo "Upload failed; will retry in ${SYNC_INTERVAL}s." >&2

  now="$(date +%s)"
  if [ "${COLLABMD_RCLONE_RUNNER_PULL_REMOTE_CHANGES:-true}" = "true" ] && [ $((now - last_pull)) -ge "$PULL_INTERVAL" ]; then
    copy_remote_to_local || echo "Remote pull failed; will retry later." >&2
    last_pull="$now"
  fi

  sleep "$SYNC_INTERVAL" &
  wait $!
done
