# App service (`compose.apps.yml`)

## Vai trò
- Triển khai CollabMD (`https://github.com/andes90/collabmd`) bằng image `ghcr.io/andes90/collabmd`.
- Có 4 hình thức triển khai độc lập, mỗi hình thức là một app/container riêng:
  - `app` với profile `collabmd-local`: dùng thư mục local.
  - `collabmd-rclone` với profile `collabmd-rclone`: dùng thư mục được rclone mount.
  - `collabmd-rclone-runner` với profile `collabmd-rclone-runner`: dùng disk local + sidecar rclone sync, phù hợp GitHub Actions/Azure Pipelines.
  - `collabmd-git` với profile `collabmd-git`: bootstrap vault từ private git repo.
- `collabmd-plantuml` là PlantUML renderer dùng chung cho các app CollabMD đang bật.

## Bật/tắt hình thức triển khai
- Local: `COLLABMD_LOCAL_ENABLED=true|false` (mặc định true).
- Rclone: `COLLABMD_RCLONE_ENABLED=true|false`.
- Rclone runner-safe: `COLLABMD_RCLONE_RUNNER_ENABLED=true|false`.
- Git private repo: `COLLABMD_GIT_DEPLOY_ENABLED=true|false`.

`docker-compose/scripts/dc.sh` tự thêm Compose profile tương ứng khi chạy `npm run dockerapp-exec:up`.

## Cấu hình chung
- `COLLABMD_IMAGE`: image CollabMD.
- `COLLABMD_PORT` + `APP_PORT`: port app lắng nghe trong container. `APP_PORT` vẫn là nguồn sự thật cho Compose.
- `COLLABMD_HEALTH_PATH` + `HEALTH_PATH`: health endpoint, mặc định `/health`.
- `COLLABMD_AUTH_*`: cấu hình auth/password/OIDC chung.
- `COLLABMD_PLANTUML_SERVER_URL`: mặc định `http://collabmd-plantuml:8080`.
- `DOCKER_VOLUMES_ROOT`: root mặc định cho dữ liệu persistent.

## Local mode
- Service: `app`.
- Host vault dir: `COLLABMD_LOCAL_HOST_DIR`.
- Container vault dir: `COLLABMD_LOCAL_CONTAINER_DIR` (mặc định `/data`).
- Direct host port: `COLLABMD_LOCAL_HOST_PORT`.
- Public Caddy site: `COLLABMD_LOCAL_CADDY_SITE`.
- Public app origin: `COLLABMD_LOCAL_PUBLIC_BASE_URL`.

## Rclone mode
- Services: `collabmd-rclone` + `collabmd-rclone-mount`.
- rclone remote: `COLLABMD_RCLONE_REMOTE` (ví dụ `gdrive:notes/collabmd`).
- rclone config:
  - đặt `rclone.conf` trong `COLLABMD_RCLONE_CONFIG_DIR`, hoặc
  - đặt toàn bộ file config dạng base64 vào `COLLABMD_RCLONE_CONFIG_B64`.
- Host mount dir: `COLLABMD_RCLONE_HOST_DIR`.
- Cache dir: `COLLABMD_RCLONE_CACHE_DIR`.
- Direct host port: `COLLABMD_RCLONE_HOST_PORT`.
- Public Caddy site: `COLLABMD_RCLONE_CADDY_SITE`.

Rclone mount cần host/container hỗ trợ FUSE (`/dev/fuse`, `SYS_ADMIN`, bind propagation `rshared`).

## Rclone runner-safe mode cho GitHub Actions/Azure Pipelines
- Services: `collabmd-rclone-runner`, `collabmd-rclone-runner-sync`, `collabmd-rclone-runner-restarter`.
- Mục tiêu: tránh FUSE/`SYS_ADMIN` trên runner CI, giữ hiệu năng cao bằng cách cho CollabMD ghi vào disk local (`COLLABMD_RCLONE_RUNNER_HOST_DIR`) rồi sidecar `rclone copy/sync` lên remote.
- Dùng chung `COLLABMD_RCLONE_REMOTE`, `COLLABMD_RCLONE_CONFIG_DIR` hoặc `COLLABMD_RCLONE_CONFIG_B64` với rclone mount mode.
- `COLLABMD_RCLONE_RUNNER_INITIAL_PULL=true`: kéo dữ liệu remote về local trước, giúp runner mới không bắt đầu từ thư mục rỗng.
- `COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC=20`: đẩy thay đổi local lên remote thường xuyên để giảm mất dữ liệu nếu runner bị hủy.
- `COLLABMD_RCLONE_RUNNER_PULL_REMOTE_CHANGES=true` + `COLLABMD_RCLONE_RUNNER_PULL_INTERVAL_SEC=120`: định kỳ kéo thay đổi từ remote nếu có nguồn khác cùng ghi.
- `COLLABMD_RCLONE_RUNNER_DELETE_REMOTE=false` là mặc định an toàn nhất: sidecar dùng `rclone copy`, không xóa file remote khi local thiếu file. Chỉ đặt `true` khi runner này là nguồn dữ liệu duy nhất và bạn muốn mirror chính xác bằng `rclone sync`; khi đó file bị xóa sẽ được đưa vào `.collabmd-runner-backups/<timestamp>` trên remote trước.
- `COLLABMD_RCLONE_RUNNER_SYNC_EXTRA_ARGS=--fast-list --metadata --transfers 8 --checkers 16` cân bằng hiệu năng và metadata. Có thể tăng `transfers/checkers` nếu remote chịu tải tốt.
- `COLLABMD_RCLONE_RUNNER_RESTART_INTERVAL_SEC=3000`: sidecar Docker CLI restart app mỗi 3000 giây = 50 phút. Sync sidecar vẫn chạy riêng, nên dữ liệu vẫn được upload trong khi app được recycle.
- Restarter cần mount `/var/run/docker.sock`; chỉ nên bật mode này trong runner/pipeline tin cậy, không expose cho người dùng không tin cậy.

Ví dụ tối thiểu cho runner:

```env
COLLABMD_LOCAL_ENABLED=false
COLLABMD_RCLONE_ENABLED=false
COLLABMD_RCLONE_RUNNER_ENABLED=true
COLLABMD_RCLONE_REMOTE=gdrive:notes/collabmd
COLLABMD_RCLONE_CONFIG_B64=<base64-rclone.conf>
COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC=20
COLLABMD_RCLONE_RUNNER_RESTART_INTERVAL_SEC=3000
```

## Git private repo mode
- Service: `collabmd-git`.
- Host vault dir: `COLLABMD_GIT_HOST_DIR`.
- Repo URL: `COLLABMD_GIT_REPO_URL`.
- SSH key:
  - đơn giản nhất: `COLLABMD_GIT_SSH_PRIVATE_KEY_B64`, hoặc
  - mount file trong `COLLABMD_GIT_SECRETS_DIR` rồi đặt `COLLABMD_GIT_SSH_PRIVATE_KEY_FILE` theo path trong container.
- Optional known hosts: `COLLABMD_GIT_SSH_KNOWN_HOSTS_FILE`.
- Git identity:
  - với OIDC, commit author/email lấy từ user đang đăng nhập.
  - không dùng OIDC thì có thể đặt fallback qua `COLLABMD_GIT_USER_NAME`, `COLLABMD_GIT_USER_EMAIL`.
- Non-interactive Git: `COLLABMD_GIT_TERMINAL_PROMPT=0`.
- Git safe directory: `COLLABMD_GIT_SAFE_DIRECTORY`, mặc định trùng `COLLABMD_GIT_CONTAINER_DIR`.
- CollabMD metadata sync:
  - `COLLABMD_GIT_META_SYNC_ENABLED=true` bật sidecar `collabmd-git-meta-sync`.
  - `COLLABMD_GIT_TRACK_COLLABMD_COMMENTS=true` làm `.collabmd/comments/**/*.json` hiện trong Git status để commit/push bằng CollabMD UI.
  - `COLLABMD_GIT_TRACK_COLLABMD_YJS=false` giữ `.collabmd/yjs/` ngoài Git.
  - `COLLABMD_GIT_TRACK_COLLABMD_PULL_BACKUPS=false` giữ `.collabmd/pull-backups/` ngoài Git.
  - `COLLABMD_GIT_META_SYNC_INTERVAL_SEC=30` kiểm tra lại `.git/info/exclude` định kỳ, vì CollabMD upstream có thể tự thêm exclude `.collabmd/`.
- Direct host port: `COLLABMD_GIT_HOST_PORT`.
- Public Caddy site: `COLLABMD_GIT_CADDY_SITE`.

Khi `COLLABMD_GIT_REPO_URL` được đặt, CollabMD clone repo vào `COLLABMD_GIT_CONTAINER_DIR` trong lần boot đầu, sau đó reuse checkout ở các lần chạy tiếp theo.

Env-only setup nên để `COLLABMD_GIT_SSH_PRIVATE_KEY_FILE=` và `COLLABMD_GIT_SSH_KNOWN_HOSTS_FILE=` trống, rồi đặt private key đã base64 vào `COLLABMD_GIT_SSH_PRIVATE_KEY_B64`. Khi không set `COLLABMD_GIT_SSH_KNOWN_HOSTS_FILE`, CollabMD dùng SSH `StrictHostKeyChecking=accept-new`.
Nếu API Git báo `detected dubious ownership in repository at '/data'`, giữ `COLLABMD_GIT_SAFE_DIRECTORY=/data`; compose sẽ truyền `safe.directory` cho Git qua env `GIT_CONFIG_*`.
Nếu muốn comment đi theo vault Git, bật `COLLABMD_GIT_META_SYNC_ENABLED=true`. Sidecar này không tự commit; nó chỉ làm file comment hiện trong Git panel, còn stage/commit/push vẫn do CollabMD xử lý theo user OIDC đang đăng nhập.

## Routing / Cloudflare Tunnel
Mỗi hostname Cloudflare Tunnel nên trỏ về `http://caddy:80`; Caddy label sẽ route đến app tương ứng:
- `COLLABMD_LOCAL_CADDY_SITE` -> service `app`.
- `COLLABMD_RCLONE_CADDY_SITE` -> service `collabmd-rclone`.
- `COLLABMD_RCLONE_RUNNER_CADDY_SITE` -> service `collabmd-rclone-runner`.
- `COLLABMD_GIT_CADDY_SITE` -> service `collabmd-git`.

Các ví dụ hostname đã có trong `.env.example` và `cloudflared/config.yml.example`.
