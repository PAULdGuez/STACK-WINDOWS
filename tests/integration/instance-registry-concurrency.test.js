import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKER_SCRIPT = path.join(__dirname, 'registry-worker.js');

function spawnWorker(registryPath, workerId, iterations = 10) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_SCRIPT, [registryPath, workerId, String(iterations)], {
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Worker ${workerId} exited with code ${code}: ${stderr}`));
    });
    child.on('error', reject);
  });
}

describe('InstanceRegistry Concurrency', () => {
  let tmpDir;
  let registryPath;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `swe-concurrency-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    registryPath = path.join(tmpDir, 'instance-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ instances: {} }));
  });

  afterEach(() => {
    // Clean up lock files and temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('5 concurrent workers should not corrupt the registry file', async () => {
    const workers = [];
    for (let i = 0; i < 5; i++) {
      workers.push(spawnWorker(registryPath, `w${i}`, 10));
    }
    await Promise.all(workers);

    // Verify file integrity
    const content = fs.readFileSync(registryPath, 'utf-8');
    const data = JSON.parse(content); // Should not throw
    expect(data).toHaveProperty('instances');
    // All workers unregistered, so instances should be empty
    expect(Object.keys(data.instances)).toHaveLength(0);
  }, 30000);

  it('registry file remains valid JSON after concurrent writes (3 runs)', async () => {
    for (let run = 0; run < 3; run++) {
      // Reset
      fs.writeFileSync(registryPath, JSON.stringify({ instances: {} }));
      
      const workers = [];
      for (let i = 0; i < 5; i++) {
        workers.push(spawnWorker(registryPath, `r${run}w${i}`, 5));
      }
      await Promise.all(workers);

      const content = fs.readFileSync(registryPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
      const data = JSON.parse(content);
      expect(Object.keys(data.instances)).toHaveLength(0);
    }
  }, 60000);
});
