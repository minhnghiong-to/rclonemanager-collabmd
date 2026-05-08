#!/bin/sh
# Sync CollabMD's runner-local vault to an rclone remote without FUSE.
# This favors data safety on ephemeral CI runners: remote deletes are disabled
# by default, local writes are flushed frequently, and SIGTERM triggers one last
# upload before the container exits.
set -eu

mkdir -p /config /data

if [ -n "${COLLABMD_RCLONE_CONFIG_B64:-}" ]; then
  printf '%s' "${COLLABMD_RCLONE_CONFIG_B64}" | base64 -d > /config/rclone.conf
  chmod 600 /config/rclone.conf
fi

if [ ! -s /config/rclone.conf ]; then
  echo "COLLABMD_RCLONE_CONFIG_B64 or /config/rclone.conf is required." >&2
  exit 1
fi

if [ -z "${COLLABMD_RCLONE_REMOTE:-}" ]; then
  echo "COLLABMD_RCLONE_REMOTE is required." >&2
  exit 1
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

push_local_to_remote() {
  if [ "${COLLABMD_RCLONE_RUNNER_DELETE_REMOTE:-false}" = "true" ]; then
    echo "Syncing /data to ${REMOTE} with remote delete enabled ..."
    # shellcheck disable=SC2086
    $RCLONE sync /data "$REMOTE" --backup-dir "${REMOTE%/}/.collabmd-runner-backups/$(date -u +%Y%m%dT%H%M%SZ)" $SYNC_EXTRA_ARGS
  else
    echo "Copying /data to ${REMOTE} without deleting remote files ..."
    # shellcheck disable=SC2086
    $RCLONE copy /data "$REMOTE" $SYNC_EXTRA_ARGS
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
