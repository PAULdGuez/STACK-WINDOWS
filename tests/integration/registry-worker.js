// registry-worker.js — spawned by concurrency test
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lockfile = require('proper-lockfile');

const registryPath = process.argv[2]; // path to registry file
const workerId = process.argv[3] || crypto.randomUUID().slice(0, 8);
const iterations = parseInt(process.argv[4] || '10', 10);

const LOCK_OPTS = { stale: 10000, retries: { retries: 5, minTimeout: 100, maxTimeout: 2000 } };

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch {
    return { instances: {} };
  }
}

function writeRegistry(data) {
  const tmpPath = registryPath + '.tmp.' + workerId;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, registryPath);
}

async function run() {
  // Ensure file exists for lockfile
  if (!fs.existsSync(registryPath)) {
    fs.writeFileSync(registryPath, JSON.stringify({ instances: {} }));
  }

  // Register
  let release = await lockfile.lock(registryPath, LOCK_OPTS);
  try {
    const reg = readRegistry();
    reg.instances[workerId] = {
      pid: process.pid,
      managedHwnds: [],
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };
    writeRegistry(reg);
  } finally {
    release();
  }

  // Update managedHwnds N times
  for (let i = 0; i < iterations; i++) {
    release = await lockfile.lock(registryPath, LOCK_OPTS);
    try {
      const reg = readRegistry();
      if (reg.instances[workerId]) {
        reg.instances[workerId].managedHwnds = [i * 1000 + parseInt(workerId, 36) % 1000];
        reg.instances[workerId].lastHeartbeat = new Date().toISOString();
      }
      writeRegistry(reg);
    } finally {
      release();
    }
    // Small random delay to increase contention
    await new Promise(r => setTimeout(r, Math.random() * 20));
  }

  // Unregister
  release = await lockfile.lock(registryPath, LOCK_OPTS);
  try {
    const reg = readRegistry();
    delete reg.instances[workerId];
    writeRegistry(reg);
  } finally {
    release();
  }

  process.exit(0);
}

run().catch(e => { console.error('Worker failed:', e); process.exit(1); });
