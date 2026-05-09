#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const envPath = path.resolve(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file not found. Hãy tạo từ .env.example trước khi deploy.");
  process.exit(1);
}

function parseEnvFile(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const idx = s.indexOf("=");
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

const env = parseEnvFile(envPath);

function expandEnvReferences(values) {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      const next = String(value || "").replace(pattern, (_match, name) => values[name] ?? "");
      if (next !== value) {
        values[key] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

expandEnvReferences(env);

const errors = [];
const warnings = [];
const ok = [];

function isBool(v) {
  return v === "true" || v === "false";
}

function isPlaceholder(v) {
  return /\b(your-|replace-|paste-|todo|changeme|example\.com|your-org|your-private-vault)\b/i.test(v);
}

function validateEmail(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "must be a valid email address";
}

function validateContainerPath(v) {
  return v.startsWith("/") ? null : "must be an absolute container path";
}

function validateGitRepoUrl(v) {
  if (isPlaceholder(v)) return "replace the placeholder with the real private vault repo URL";
  if (v.startsWith("git@") || v.startsWith("ssh://")) return null;
  return "must be an SSH git URL, e.g. git@github.com:org/private-vault.git";
}

function validatePrivateKeyBase64(v) {
  if (isPlaceholder(v)) return "replace the placeholder with a real base64-encoded private key";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return "must be base64 without whitespace";
  let decoded = "";
  try {
    decoded = Buffer.from(v, "base64").toString("utf8");
  } catch {
    return "must be valid base64";
  }
  if (!decoded.includes("-----BEGIN ") || !decoded.includes("PRIVATE KEY-----")) {
    return "decoded value does not look like an SSH private key";
  }
  return null;
}

function checkPort(key, required = true) {
  const v = env[key];
  if (!v) {
    if (required) errors.push(`${key} is required`);
    else warnings.push(`${key} not set (optional)`);
    return;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(`${key} must be an integer in range 1..65535`);
    return;
  }
  ok.push(`${key}=${n}`);
}

function checkRequired(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    errors.push(`${key} is required (${desc})`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK`);
}

function checkOptional(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    warnings.push(`${key} optional: ${desc}`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK (optional)`);
}

function checkOptionalIfSet(key, validate) {
  const v = (env[key] || "").trim();
  if (!v) return false;
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return true;
    }
  }
  ok.push(`${key}=OK (optional)`);
  return true;
}

function isValidDomain(v) {
  if (v.startsWith("http://") || v.startsWith("https://")) return "must not include http/https";
  if (v.endsWith("/")) return "must not end with /";
  if (!v.includes(".")) return "must be a valid domain, e.g. example.com";
  return null;
}

function isValidHttpsJsonUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

function buildAppHost(project, domain) {
  const p = (project || "").trim().toLowerCase();
  const d = (domain || "").trim().toLowerCase();
  if (p && d && (d === p || d.startsWith(`${p}.`))) {
    return domain;
  }
  return `${project}.${domain}`;
}

// 1) Required core env from compose files
checkRequired("PROJECT_NAME", "docker project/network + subdomain prefix", (v) =>
  /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "only lowercase letters, numbers, hyphen"
);
checkRequired("DOMAIN", "root domain", isValidDomain);
checkRequired("CADDY_EMAIL", "caddy email label", (v) => (v.includes("@") ? null : "invalid email"));
checkRequired("CADDY_AUTH_USER", "basic auth username");
checkRequired("CADDY_AUTH_HASH", "basic auth bcrypt hash", (v) => {
  const raw = v.replace(/\$\$/g, "$");
  return raw.startsWith("$2a$") || raw.startsWith("$2b$") ? null : "must be bcrypt hash ($2a$/$2b$...)";
});
checkPort("APP_PORT", true);

// 2) Optional env from compose files
checkPort("APP_HOST_PORT", false);
checkPort("DOZZLE_HOST_PORT", false);
checkPort("FILEBROWSER_HOST_PORT", false);
checkPort("WEBSSH_HOST_PORT", false);
checkOptional("NODE_ENV", "app runtime env");
checkOptional("HEALTH_PATH", "health endpoint path", (v) => (v.startsWith("/") ? null : "must start with '/'"));
checkOptional("DOCKER_SOCK", "docker socket path override");
checkOptional("COLLABMD_IMAGE", "CollabMD container image");
checkPort("COLLABMD_PORT", false);
checkOptional("COLLABMD_HEALTH_PATH", "CollabMD health endpoint path", (v) => (v.startsWith("/") ? null : "must start with '/'"));
checkOptional("COLLABMD_AUTH_STRATEGY", "none|password|oidc", (v) =>
  ["none", "password", "oidc"].includes(v) ? null : "must be one of none|password|oidc"
);
checkOptional("COLLABMD_PLANTUML_SERVER_URL", "PlantUML upstream URL for CollabMD");
checkPort("COLLABMD_PLANTUML_HOST_PORT", false);
checkPort("DOCKER_DEPLOY_CODE_PORT", false);
checkPort("DOCKER_DEPLOY_CODE_HOST_PORT", false);
checkOptional("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public Caddy host for deploy-code UI/API");
checkOptional("DOCKER_DEPLOY_CODE_REPO_DIR", "repo path mounted inside deploy-code sidecar");
checkOptional("DOCKER_DEPLOY_CODE_BRANCH", "git branch to deploy");
checkOptional("DOCKER_DEPLOY_CODE_REMOTE", "git remote to fetch");
checkOptional("DOCKER_DEPLOY_CODE_COMPOSE_SCRIPT", "compose orchestration script inside repo");
checkOptional("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "comma-separated compose services to rebuild/redeploy");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_CONTROL_ENABLED", "true|false toggle for container control API", (v) =>
  isBool(v) ? null : "must be true|false"
);
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOW_ALL", "true|false toggle to allow all Docker containers", (v) =>
  isBool(v) ? null : "must be true|false"
);
checkOptional("DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST", "comma-separated compose services allowed for start/stop/restart/rebuild/logs");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST", "comma-separated containers allowed for start/stop/restart/logs/inspect");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_DEFAULT_LINES", "default container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_MAX_LINES", "max container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ACTION_TIMEOUT_SEC", "Docker action timeout seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_POLL_INTERVAL_SEC", "git polling interval seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_ZIP_MAX_MB", "max raw ZIP upload size in MB", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});

if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  checkRequired("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "service(s) deploy-code may rebuild/redeploy");
  checkRequired("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public deploy-code hostname for Caddy");

  const requireToken = (env.DOCKER_DEPLOY_CODE_REQUIRE_TOKEN || "true").trim();
  if (!isBool(requireToken)) {
    errors.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN must be true|false");
  } else if (requireToken === "true") {
    checkRequired("DOCKER_DEPLOY_CODE_API_TOKEN", "required when deploy-code token auth is enabled", (v) =>
      v.length >= 16 ? null : "must be at least 16 characters"
    );
  } else {
    warnings.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=false while deploy-code is enabled -> rely on Caddy Basic Auth / private network only");
  }
}

function boolValue(key, fallback) {
  const v = (env[key] || "").trim();
  if (!v) return fallback;
  return v === "true";
}

function resolveHostPath(value) {
  const v = (value || "").trim();
  if (!v) return "";
  if (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) return v;
  return path.resolve(process.cwd(), v);
}

function optionalHttpUrl(key, desc) {
  checkOptional(key, desc, (v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:" ? null : "must use http/https";
    } catch {
      return "must be an absolute http/https URL";
    }
  });
}

function optionalCaddySite(key, desc) {
  checkOptional(key, desc, (v) => {
    if (!v.includes("://")) return "must include scheme, e.g. http://collabmd.example.com";
    return null;
  });
}

function validateModeAuth(prefix, modeName) {
  const strategy = (env[`${prefix}_AUTH_STRATEGY`] || env.COLLABMD_AUTH_STRATEGY || "none").trim();
  if (!["none", "password", "oidc"].includes(strategy)) {
    errors.push(`${prefix}_AUTH_STRATEGY must be one of none|password|oidc`);
    return;
  }
  ok.push(`${modeName} auth strategy=${strategy}`);

  if (strategy === "oidc") {
    const publicBaseUrl = (env[`${prefix}_PUBLIC_BASE_URL`] || env.COLLABMD_PUBLIC_BASE_URL || "").trim();
    if (!publicBaseUrl) {
      errors.push(`${prefix}_PUBLIC_BASE_URL or COLLABMD_PUBLIC_BASE_URL is required when ${modeName} uses oidc auth`);
    }
    if (!env.COLLABMD_AUTH_OIDC_CLIENT_ID) {
      errors.push(`COLLABMD_AUTH_OIDC_CLIENT_ID is required when ${modeName} uses oidc auth`);
    }
    if (!env.COLLABMD_AUTH_OIDC_CLIENT_SECRET) {
      errors.push(`COLLABMD_AUTH_OIDC_CLIENT_SECRET is required when ${modeName} uses oidc auth`);
    }
  }
}

const collabmdModes = [
  {
    defaultEnabled: true,
    defaultHostPort: env.APP_HOST_PORT || "1234",
    flag: "COLLABMD_LOCAL_ENABLED",
    hostDir: "COLLABMD_LOCAL_HOST_DIR",
    hostPort: "COLLABMD_LOCAL_HOST_PORT",
    modeName: "CollabMD local",
    prefix: "COLLABMD_LOCAL",
  },
  {
    defaultEnabled: false,
    defaultHostPort: "1235",
    flag: "COLLABMD_RCLONE_ENABLED",
    hostDir: "COLLABMD_RCLONE_HOST_DIR",
    hostPort: "COLLABMD_RCLONE_HOST_PORT",
    modeName: "CollabMD rclone",
    prefix: "COLLABMD_RCLONE",
  },
  {
    defaultEnabled: false,
    defaultHostPort: "1237",
    flag: "COLLABMD_RCLONE_RUNNER_ENABLED",
    hostDir: "COLLABMD_RCLONE_RUNNER_HOST_DIR",
    hostPort: "COLLABMD_RCLONE_RUNNER_HOST_PORT",
    modeName: "CollabMD rclone runner-safe",
    prefix: "COLLABMD_RCLONE_RUNNER",
  },
  {
    defaultEnabled: false,
    defaultHostPort: "1236",
    flag: "COLLABMD_GIT_DEPLOY_ENABLED",
    hostDir: "COLLABMD_GIT_HOST_DIR",
    hostPort: "COLLABMD_GIT_HOST_PORT",
    modeName: "CollabMD git",
    prefix: "COLLABMD_GIT",
  },
];

const enabledCollabmdModes = [];
const usedCollabmdPorts = new Map();

for (const mode of collabmdModes) {
  const enabled = boolValue(mode.flag, mode.defaultEnabled);
  if (enabled) enabledCollabmdModes.push(mode.modeName);

  checkPort(mode.hostPort, false);
  checkOptional(mode.hostDir, `${mode.modeName} host vault directory`);
  optionalCaddySite(`${mode.prefix}_CADDY_SITE`, `${mode.modeName} Caddy site`);
  optionalHttpUrl(`${mode.prefix}_PUBLIC_BASE_URL`, `${mode.modeName} public base URL`);
  validateModeAuth(mode.prefix, mode.modeName);

  if (!enabled) continue;

  const rawPort = env[mode.hostPort] || mode.defaultHostPort;
  const port = Number(rawPort);
  if (Number.isInteger(port)) {
    if (usedCollabmdPorts.has(port)) {
      errors.push(`${mode.hostPort} conflicts with ${usedCollabmdPorts.get(port)} on host port ${port}`);
    } else {
      usedCollabmdPorts.set(port, mode.hostPort);
    }
  }
  ok.push(`${mode.modeName} profile enabled`);
}

if (!enabledCollabmdModes.length) {
  warnings.push("No CollabMD deployment mode is enabled; app layer will be idle.");
}

if (env.COLLABMD_PORT && env.APP_PORT && env.COLLABMD_PORT !== env.APP_PORT) {
  warnings.push(`COLLABMD_PORT=${env.COLLABMD_PORT} differs from APP_PORT=${env.APP_PORT}; compose uses APP_PORT inside containers.`);
}

if (boolValue("COLLABMD_RCLONE_ENABLED", false) || boolValue("COLLABMD_RCLONE_RUNNER_ENABLED", false)) {
  checkRequired("COLLABMD_RCLONE_REMOTE", "rclone remote:path for CollabMD rclone modes");
  checkOptional("COLLABMD_RCLONE_CONFIG_DIR", "directory containing rclone.conf");
  checkOptional("COLLABMD_RCLONE_CONFIG_B64", "base64-encoded rclone.conf");
  checkOptional("COLLABMD_RCLONE_VFS_CACHE_MODE", "rclone vfs cache mode");
  checkOptional("COLLABMD_RCLONE_EXTRA_ARGS", "extra rclone mount args");

  if (!env.COLLABMD_RCLONE_CONFIG_B64) {
    const configDir = resolveHostPath(env.COLLABMD_RCLONE_CONFIG_DIR || `${env.DOCKER_VOLUMES_ROOT || "./.docker-volumes"}/collabmd/rclone/config`);
    const configFile = path.join(configDir, "rclone.conf");
    if (!fs.existsSync(configFile)) {
      errors.push("CollabMD rclone modes require COLLABMD_RCLONE_CONFIG_B64 or rclone.conf in COLLABMD_RCLONE_CONFIG_DIR");
    } else {
      ok.push("rclone.conf present for CollabMD rclone mode");
    }
  }
}

if (boolValue("COLLABMD_RCLONE_RUNNER_ENABLED", false)) {
  checkOptional("COLLABMD_RCLONE_RUNNER_SYNC_INTERVAL_SEC", "runner-safe rclone upload interval seconds", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 5 ? null : "must be integer >= 5";
  });
  checkOptional("COLLABMD_RCLONE_RUNNER_PULL_INTERVAL_SEC", "runner-safe rclone remote pull interval seconds", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
  });
  checkOptional("COLLABMD_RCLONE_RUNNER_BACKUP_DIR", "optional remote backup dir for overwritten files");
  checkOptional("COLLABMD_RCLONE_RUNNER_SYNC_EXTRA_ARGS", "extra rclone copy/sync args for runner-safe mode");
}

if (boolValue("COLLABMD_GIT_DEPLOY_ENABLED", false)) {
  const gitAuthStrategy = (env.COLLABMD_GIT_AUTH_STRATEGY || env.COLLABMD_AUTH_STRATEGY || "none").trim();
  checkRequired("COLLABMD_GIT_REPO_URL", "private git repo used to bootstrap the CollabMD vault", validateGitRepoUrl);
  checkOptional("COLLABMD_GIT_SSH_PRIVATE_KEY_FILE", "container path to mounted private key", validateContainerPath);
  checkOptional("COLLABMD_GIT_SSH_PRIVATE_KEY_B64", "base64 private key for git bootstrap", validatePrivateKeyBase64);
  checkOptional("COLLABMD_GIT_SSH_KNOWN_HOSTS_FILE", "container path to mounted known_hosts", validateContainerPath);
  checkOptional("COLLABMD_GIT_TERMINAL_PROMPT", "0 disables interactive git prompts", (v) =>
    v === "0" || v === "1" ? null : "must be 0 or 1"
  );
  checkOptional("COLLABMD_GIT_SAFE_DIRECTORY", "git safe.directory for the container checkout", validateContainerPath);
  checkOptional("COLLABMD_GIT_META_SYNC_IMAGE", "image used by the CollabMD git metadata sync sidecar");
  checkOptional("COLLABMD_GIT_META_SYNC_INTERVAL_SEC", "metadata sync interval seconds", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 5 ? null : "must be integer >= 5";
  });

  const hasGitUserName = checkOptionalIfSet("COLLABMD_GIT_USER_NAME");
  const hasGitUserEmail = checkOptionalIfSet("COLLABMD_GIT_USER_EMAIL", validateEmail);
  if (!hasGitUserName && !hasGitUserEmail && gitAuthStrategy === "oidc") {
    ok.push("CollabMD git commit identity=OIDC signed-in user");
  } else if (!hasGitUserName || !hasGitUserEmail) {
    warnings.push("COLLABMD_GIT_USER_NAME/COLLABMD_GIT_USER_EMAIL optional fallback identity incomplete; OIDC users can leave both blank");
  }

  if (!env.COLLABMD_GIT_SSH_PRIVATE_KEY_FILE && !env.COLLABMD_GIT_SSH_PRIVATE_KEY_B64) {
    errors.push("COLLABMD_GIT_DEPLOY_ENABLED=true requires COLLABMD_GIT_SSH_PRIVATE_KEY_FILE or COLLABMD_GIT_SSH_PRIVATE_KEY_B64");
  }
  if (env.COLLABMD_GIT_SSH_PRIVATE_KEY_FILE && env.COLLABMD_GIT_SSH_PRIVATE_KEY_B64) {
    warnings.push("COLLABMD_GIT_SSH_PRIVATE_KEY_FILE is set and takes precedence over COLLABMD_GIT_SSH_PRIVATE_KEY_B64");
  }
  if (!env.COLLABMD_GIT_SSH_KNOWN_HOSTS_FILE) {
    warnings.push("COLLABMD_GIT_SSH_KNOWN_HOSTS_FILE not set -> CollabMD will use SSH StrictHostKeyChecking=accept-new");
  }

  if (boolValue("COLLABMD_GIT_META_SYNC_ENABLED", false)) {
    if (boolValue("COLLABMD_GIT_TRACK_COLLABMD_COMMENTS", true)) {
      ok.push("CollabMD git metadata sync=comments visible to Git");
    } else {
      warnings.push("COLLABMD_GIT_META_SYNC_ENABLED=true but COLLABMD_GIT_TRACK_COLLABMD_COMMENTS=false -> .collabmd remains excluded");
    }
    if (boolValue("COLLABMD_GIT_TRACK_COLLABMD_YJS", false)) {
      warnings.push("COLLABMD_GIT_TRACK_COLLABMD_YJS=true -> binary collaboration snapshots may churn/conflict in Git");
    }
    if (boolValue("COLLABMD_GIT_TRACK_COLLABMD_PULL_BACKUPS", false)) {
      warnings.push("COLLABMD_GIT_TRACK_COLLABMD_PULL_BACKUPS=true -> local pull backup files may be committed");
    }
  }
}

// 3) Flags
for (const key of ["ENABLE_DOZZLE", "ENABLE_FILEBROWSER", "ENABLE_WEBSSH", "ENABLE_TAILSCALE", "COLLABMD_LOCAL_ENABLED", "COLLABMD_RCLONE_ENABLED", "COLLABMD_RCLONE_RUNNER_ENABLED", "COLLABMD_GIT_DEPLOY_ENABLED", "COLLABMD_LOCAL_APP_GIT_ENABLED", "COLLABMD_RCLONE_APP_GIT_ENABLED", "COLLABMD_RCLONE_RUNNER_APP_GIT_ENABLED", "COLLABMD_GIT_APP_GIT_ENABLED", "COLLABMD_GIT_META_SYNC_ENABLED", "COLLABMD_GIT_META_SYNC_ONESHOT", "COLLABMD_RCLONE_RUNNER_INITIAL_PULL", "COLLABMD_RCLONE_RUNNER_PULL_REMOTE_CHANGES", "COLLABMD_RCLONE_RUNNER_DELETE_REMOTE", "COLLABMD_GIT_TRACK_COLLABMD_COMMENTS", "COLLABMD_GIT_TRACK_COLLABMD_YJS", "COLLABMD_GIT_TRACK_COLLABMD_PULL_BACKUPS", "DOCKER_DEPLOY_CODE_ENABLED", "DOCKER_DEPLOY_CODE_POLL_ENABLED", "DOCKER_DEPLOY_CODE_AUTO_DEPLOY_ON_CHANGE", "DOCKER_DEPLOY_CODE_RUN_ON_START", "DOCKER_DEPLOY_CODE_REQUIRE_TOKEN", "DOCKER_DEPLOY_CODE_GIT_CLEAN", "DOCKER_DEPLOY_CODE_ZIP_STRIP_TOP_LEVEL", "DOCKER_DEPLOY_CODE_ZIP_DELETE_MISSING", "DOCKER_DEPLOY_CODE_ZIP_BACKUP_BEFORE_APPLY", "DOCKER_DEPLOY_CODE_ZIP_DEPLOY_AFTER_APPLY"]) {
  const v = env[key];
  if (!v) {
    warnings.push(`${key} not set -> using default from scripts/compose`);
    continue;
  }
  if (!isBool(v)) errors.push(`${key} must be true|false`);
  else ok.push(`${key}=${v}`);
}

// 4) Files required by cloudflared mounts
const cfConfig = path.resolve(process.cwd(), "cloudflared/config.yml");
const cfCreds = path.resolve(process.cwd(), "cloudflared/credentials.json");
if (!fs.existsSync(cfConfig)) errors.push("cloudflared/config.yml missing (cloudflared mount required)");
else ok.push("cloudflared/config.yml present");
if (!fs.existsSync(cfCreds)) errors.push("cloudflared/credentials.json missing (cloudflared mount required)");
else ok.push("cloudflared/credentials.json present");

// 5) Optional webssh runtime tuning vars
if ((env.ENABLE_WEBSSH || "true") === "true") {
  if (!env.CUR_WHOAMI) warnings.push("CUR_WHOAMI optional (webssh linux default runner)");
  if (!env.CUR_WORK_DIR) warnings.push("CUR_WORK_DIR optional (webssh linux default /home/runner)");
  if (!env.SHELL) warnings.push("SHELL optional (webssh linux default /bin/bash)");
}

// 6) Tailscale + keep-ip rules based on compose.access.yml
if (env.ENABLE_TAILSCALE === "true") {
  checkRequired("TAILSCALE_AUTHKEY", "required by tailscale service", (v) =>
    v.startsWith("tskey-") ? null : "must start with tskey-"
  );
  checkRequired("TAILSCALE_TAILNET_DOMAIN", "required by dc.sh to render tailscale/serve.json", (v) =>
    v && v !== "-" ? null : "must not be empty or '-'"
  );
  checkOptional("TAILSCALE_TAGS", "advertise tags", (v) =>
    /^tag:[A-Za-z0-9][A-Za-z0-9_-]*(,tag:[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(v)
      ? null
      : "format must be tag:a,tag:b"
  );

  const keepIp = (env.TAILSCALE_KEEP_IP_ENABLE || "false").trim();
  if (!isBool(keepIp)) errors.push("TAILSCALE_KEEP_IP_ENABLE must be true|false");

  const keepRemove = (env.TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE || "").trim();
  if (keepRemove && !isBool(keepRemove)) {
    errors.push("TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE must be true|false when provided");
  }

  if (keepIp === "true") {
    checkRequired("TAILSCALE_KEEP_IP_FIREBASE_URL", "required when keep-ip enabled", (v) =>
      isValidHttpsJsonUrl(v) ? null : "must be https URL ending with .json"
    );
    checkOptional("TAILSCALE_KEEP_IP_CERTS_DIR", "certs dir path");
    checkOptional("TAILSCALE_KEEP_IP_INTERVAL_SEC", "backup interval seconds", (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 5 ? null : "must be integer >= 5";
    });
  } else {
    warnings.push("TAILSCALE_KEEP_IP_ENABLE=false -> keep-ip backup/restore disabled");
  }

  const removeHostnameEnabled = keepRemove ? keepRemove === "true" : keepIp === "true";
  if (removeHostnameEnabled) {
    if (!env.TAILSCALE_CLIENTID) {
      errors.push("remove-hostname enabled requires TAILSCALE_CLIENTID");
    }
    const authKey = (env.TAILSCALE_AUTHKEY || "").trim();
    if (!authKey) {
      errors.push("remove-hostname enabled requires TAILSCALE_AUTHKEY");
    } else if (!authKey.startsWith("tskey-client-")) {
      errors.push("remove-hostname requires TAILSCALE_AUTHKEY in tskey-client-* format");
    }
  }
}

const project = env.PROJECT_NAME || "<project>";
const domain = env.DOMAIN || "<domain>";
const host = env.PROJECT_NAME || "myapp";
const tailnet = env.TAILSCALE_TAILNET_DOMAIN || "tailnet.local";
const appHost = buildAppHost(project, domain);
ok.push(`subdomain preview: app=${appHost}`);
if (boolValue("COLLABMD_LOCAL_ENABLED", true)) {
  ok.push(`subdomain preview: collabmd-local=${env.COLLABMD_LOCAL_CADDY_SITE || `http://collabmd-local.${domain}`}`);
}
if (boolValue("COLLABMD_RCLONE_ENABLED", false)) {
  ok.push(`subdomain preview: collabmd-rclone=${env.COLLABMD_RCLONE_CADDY_SITE || `http://collabmd-rclone.${domain}`}`);
}
if (boolValue("COLLABMD_RCLONE_RUNNER_ENABLED", false)) {
  ok.push(`subdomain preview: collabmd-rclone-runner=${env.COLLABMD_RCLONE_RUNNER_CADDY_SITE || `http://collabmd-rclone-runner.${domain}`}`);
}
if (boolValue("COLLABMD_GIT_DEPLOY_ENABLED", false)) {
  ok.push(`subdomain preview: collabmd-git=${env.COLLABMD_GIT_CADDY_SITE || `http://collabmd-git.${domain}`}`);
}
if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`subdomain preview: logs=logs.${appHost}`);
if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`subdomain preview: files=files.${appHost}`);
if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`subdomain preview: ttyd=ttyd.${appHost}`);
if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  ok.push(`subdomain preview: deploy-code=${env.DOCKER_DEPLOY_CODE_CADDY_HOSTS || `deploy.${domain}`}`);
}
if (env.ENABLE_TAILSCALE === "true") {
  const dozzlePort = env.DOZZLE_HOST_PORT || "18080";
  const filesPort = env.FILEBROWSER_HOST_PORT || "18081";
  const sshPort = env.WEBSSH_HOST_PORT || "17681";
  const deployCodePort = env.DOCKER_DEPLOY_CODE_HOST_PORT || "15399";
  ok.push(`tailnet host: https://${host}.${tailnet}`);
  if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`tailnet dozzle: http://${host}.${tailnet}:${dozzlePort}`);
  if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`tailnet filebrowser: http://${host}.${tailnet}:${filesPort}`);
  if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`tailnet webssh: http://${host}.${tailnet}:${sshPort}`);
  if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") ok.push(`tailnet deploy-code: http://${host}.${tailnet}:${deployCodePort}`);
}

console.log("\n📋 ENV VALIDATION REPORT");
console.log("─".repeat(60));

if (ok.length) {
  console.log(`\n✅ Valid (${ok.length})`);
  for (const s of ok) console.log(`  - ${s}`);
}
if (warnings.length) {
  console.log(`\n⚠️ Warnings (${warnings.length})`);
  for (const s of warnings) console.log(`  - ${s}`);
}
if (errors.length) {
  console.log(`\n❌ Errors (${errors.length})`);
  for (const s of errors) console.log(`  - ${s}`);
  console.log("\nDừng triển khai. Hãy sửa lỗi bắt buộc trước khi chạy up.\n");
  process.exit(1);
}

console.log("\n✅ Env hợp lệ. Có thể triển khai.\n");
