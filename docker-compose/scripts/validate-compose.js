#!/usr/bin/env node
// ================================================================
//  docker-compose/scripts/validate-compose.js
//  Runs `docker compose config` across all compose files to
//  validate the merged YAML resolves without errors.
// ================================================================
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FILES = [
  'docker-compose/compose.core.yml',
  'docker-compose/compose.ops.yml',
  'docker-compose/compose.access.yml',
  'docker-compose/compose.deploy.yml',
  'compose.apps.yml',
];

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const idx = s.indexOf('=');
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    out[key] = value;
  }
  return out;
}

function profileArgsFromEnv(env) {
  const profiles = [];
  const curOs = String(env.CUR_OS || process.platform).toLowerCase();
  const isWindows = curOs.includes('win');

  if (env.COLLABMD_LOCAL_ENABLED !== 'false') profiles.push('collabmd-local');
  if (env.COLLABMD_RCLONE_ENABLED === 'true') profiles.push('collabmd-rclone');
  if (env.COLLABMD_RCLONE_RUNNER_ENABLED === 'true') profiles.push('collabmd-rclone-runner');
  if (env.COLLABMD_GIT_DEPLOY_ENABLED === 'true') profiles.push('collabmd-git');
  if (env.COLLABMD_GIT_DEPLOY_ENABLED === 'true' && env.COLLABMD_GIT_META_SYNC_ENABLED === 'true') {
    profiles.push('collabmd-git-meta-sync');
  }
  if (env.ENABLE_DOZZLE !== 'false') profiles.push('dozzle');
  if (env.ENABLE_FILEBROWSER !== 'false') profiles.push('filebrowser');
  if (env.ENABLE_WEBSSH !== 'false') profiles.push(isWindows ? 'webssh-windows' : 'webssh-linux');
  if (env.ENABLE_TAILSCALE === 'true') profiles.push(isWindows ? 'tailscale-windows' : 'tailscale-linux');
  if (env.DOCKER_DEPLOY_CODE_ENABLED === 'true') profiles.push('deploy-code');

  return profiles.flatMap((profile) => ['--profile', profile]);
}

console.log('\n🐳  Compose Config Validation\n');

// Check all files exist
let abort = false;
for (const f of FILES) {
  if (!fs.existsSync(f)) {
    console.error(`❌  ${f} not found`);
    abort = true;
  } else {
    console.log(`    ✅  ${f}`);
  }
}
if (abort) process.exit(1);

const fileArgs = FILES.map(f => `-f ${f}`).join(' ');
const profileArgs = profileArgsFromEnv(parseEnvFile('.env'));
const args = [
  'compose',
  ...FILES.flatMap((f) => ['-f', f]),
  ...profileArgs,
  '--project-directory',
  process.cwd(),
  'config',
  '--quiet',
];

console.log(`\n    Running: docker compose ${fileArgs} ${profileArgs.join(' ')} config ...\n`);

try {
  execFileSync('docker', args, { stdio: 'inherit', cwd: path.resolve(__dirname, '../..') });
  console.log('\n✅  Compose configuration is valid!\n');
} catch {
  console.log('\n❌  Compose validation failed — fix YAML errors above.\n');
  process.exit(1);
}
