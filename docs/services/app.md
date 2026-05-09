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
- `COLLABMD_RCLONE_ALLOW_NON_EMPTY=true` (mặc định): thêm `--allow-non-empty` để rclone có thể mount lên `/data`, vốn là Docker bind mount dùng `rshared`. Đặt `false` chỉ khi bạn tự truyền mount target khác qua custom args và muốn rclone từ chối thư mục non-empty/already-mounted.
- Direct host port: `COLLABMD_RCLONE_HOST_PORT`.
- Public Caddy site: `COLLABMD_RCLONE_CADDY_SITE`.

Rclone mount cần host/container hỗ trợ FUSE (`/dev/fuse`, `SYS_ADMIN`, bind propagation `rshared`). Nếu log container chỉ hiện các biến như `XDG_CONFIG_HOME=/config`, `BB_ASH_VERSION`, `COLLABMD_RCLONE_*` rồi `Container stopped`, hãy kiểm tra theo thứ tự:

1. `COLLABMD_RCLONE_CONFIG_B64` phải là nội dung `rclone.conf` đã base64 một dòng, ví dụ `base64 -w0 rclone.conf`; không dùng placeholder như `xxxxx` và không để newline.
2. `COLLABMD_RCLONE_REMOTE` phải trùng đúng tên remote trong file config, ví dụ nếu remote là `[gd-o861_pm2_io]` thì dùng `gd-o861_pm2_io:collabmd-vault`.
3. Host phải cho phép FUSE: compose cần map `/dev/fuse`, cấp `SYS_ADMIN`, thư mục bind mount phải dùng propagation `rshared`, và mount sidecar mặc định bật `COLLABMD_RCLONE_ALLOW_NON_EMPTY=true` để rclone mount chồng lên `/data` (Docker bind mount). Nhiều môi trường CI/managed container không cho phép điều này; khi đó hãy tắt mount mode và bật runner-safe mode:

```env
COLLABMD_RCLONE_ENABLED=false
COLLABMD_RCLONE_RUNNER_ENABLED=true
COLLABMD_RCLONE_REMOTE=gd-o861_pm2_io:collabmd-vault
COLLABMD_RCLONE_CONFIG_B64=<base64-rclone.conf>
```

Container `collabmd-rclone-mount` hiện chạy script preflight riêng để báo lỗi rõ hơn khi config base64 sai, remote không tồn tại trong `rclone.conf`, hoặc `/dev/fuse` không khả dụng.

## Rclone runner-safe mode cho GitHub Actions/Azure Pipelines
- Services: `collabmd-rclone-runner`, `collabmd-rclone-runner-sync`.
- Mục tiêu: tránh FUSE/`SYS_ADMIN` trên runner CI, giữ hiệu năng cao bằng cách cho CollabMD ghi vào disk local (`COLLABMD_RCLONE_RUNNER_HOST_DIR`) rồi sidecar `rclone copy/sync` lên remote.
- Dùng chung `COLLABMD_RCLONE_REMOTE`, `COLLABMD_RCLONE_CONFIG_DIR` hoặc `COLLABMD_RCLONE_CONFIG_B64` với rclone mount mode.
- `COLLABMD_RCLONE_RUNNER_INITIAL_PULL=true`: kéo dữ liệu remote về local trước, giúp runner mới không bắt đầu từ thư mục rỗng.
- `COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC=20`: đẩy thay đổi local lên remote thường xuyên để giảm mất dữ liệu nếu runner bị hủy.
- `COLLABMD_RCLONE_RUNNER_PULL_REMOTE_CHANGES=true` + `COLLABMD_RCLONE_RUNNER_PULL_INTERVAL_SEC=120`: định kỳ kéo thay đổi từ remote nếu có nguồn khác cùng ghi.
- `COLLABMD_RCLONE_RUNNER_DELETE_REMOTE=false` là mặc định an toàn nhất: sidecar dùng `rclone copy`, không xóa file remote khi local thiếu file. Chỉ đặt `true` khi runner này là nguồn dữ liệu duy nhất và bạn muốn mirror chính xác bằng `rclone sync`; khi đó file bị xóa sẽ được đưa vào `.collabmd-runner-backups/<timestamp>` trên remote trước.
- `COLLABMD_RCLONE_RUNNER_SYNC_EXTRA_ARGS=--fast-list --metadata --transfers 8 --checkers 16` cân bằng hiệu năng và metadata. Có thể tăng `transfers/checkers` nếu remote chịu tải tốt.
- Không có sidecar restart/Docker socket: GitHub Actions/Azure Pipelines tự recycle/restart runner theo lifecycle của job. Mode này chỉ tập trung giảm RPO bằng sync ngắn, initial pull, final upload khi container nhận SIGTERM, và backup trước khi overwrite remote.
- `COLLABMD_RCLONE_RUNNER_BACKUP_DIR` tùy chọn root backup remote; nếu bỏ trống, sidecar tự suy ra thư mục backup không overlap cạnh path đích, ví dụ `gdrive:notes/collabmd` -> `gdrive:notes/.collabmd-runner-backups/collabmd/<timestamp>`. Nếu remote là root như `gdrive:`, hãy đặt biến này thủ công để tránh backup overlap.

Ví dụ tối thiểu cho runner:

```env
COLLABMD_LOCAL_ENABLED=false
COLLABMD_RCLONE_ENABLED=false
COLLABMD_RCLONE_RUNNER_ENABLED=true
COLLABMD_RCLONE_REMOTE=gdrive:notes/collabmd
COLLABMD_RCLONE_CONFIG_B64=<base64-rclone.conf>
COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC=20
```

### Audit biến `COLLABMD_RCLONE_RUNNER_*`
Các biến runner-safe trong `.env.example` hiện vẫn được codebase sử dụng nên được giữ lại:
- Compose app service dùng các biến route/auth/vault như `COLLABMD_RCLONE_RUNNER_HOST_DIR`, `COLLABMD_RCLONE_RUNNER_CONTAINER_DIR`, `COLLABMD_RCLONE_RUNNER_BIND_IP`, `COLLABMD_RCLONE_RUNNER_HOST_PORT`, `COLLABMD_RCLONE_RUNNER_CADDY_SITE`, `COLLABMD_RCLONE_RUNNER_PUBLIC_BASE_URL`, `COLLABMD_RCLONE_RUNNER_TAILSCALE_SITE`, `COLLABMD_RCLONE_RUNNER_AUTH_STRATEGY`, `COLLABMD_RCLONE_RUNNER_AUTH_PASSWORD`, `COLLABMD_RCLONE_RUNNER_AUTH_SESSION_COOKIE_NAME`, `COLLABMD_RCLONE_RUNNER_APP_GIT_ENABLED`, `COLLABMD_RCLONE_RUNNER_STOP_GRACE_PERIOD`.
- Sync sidecar/script dùng các biến an toàn dữ liệu như `COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC`, `COLLABMD_RCLONE_RUNNER_PULL_INTERVAL_SEC`, `COLLABMD_RCLONE_RUNNER_INITIAL_PULL`, `COLLABMD_RCLONE_RUNNER_PULL_REMOTE_CHANGES`, `COLLABMD_RCLONE_RUNNER_DELETE_REMOTE`, `COLLABMD_RCLONE_RUNNER_BACKUP_DIR`, `COLLABMD_RCLONE_RUNNER_SYNC_EXTRA_ARGS`.
- Orchestration/validation dùng `COLLABMD_RCLONE_RUNNER_ENABLED` để bật profile, tạo host dir, validate env và render preview route.

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
