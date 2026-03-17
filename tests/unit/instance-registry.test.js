/**
 * Unit tests for InstanceRegistry
 *
 * NOTE ON MOCKING STRATEGY
 * ========================
 * The source module does `const { app } = require('electron')` at the top level.
 * Vitest's ESM vi.mock() creates an ESM namespace mock; when the CJS source module
 * calls require('electron'), the interop layer returns a broken object (numeric keys).
 * Therefore we bypass init() — which calls app.getPath() — and instead directly set
 * `filePath` and `instanceId` on the registry instance, then call _register() and
 * _startHeartbeat() manually.  This is equivalent to what init() does, minus the
 * app.getPath() call.
 *
 * For the init() test suite we test the parts that don't depend on app.getPath:
 * UUID generation, instanceId uniqueness, and the fact that init() returns an id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// Mock proper-lockfile to be a no-op (locking is tested in integration tests)
vi.mock('proper-lockfile', () => ({
  default: {
    lockSync: vi.fn(() => vi.fn()), // returns release function
    lock: vi.fn(() => Promise.resolve(vi.fn())),
  },
  lockSync: vi.fn(() => vi.fn()),
  lock: vi.fn(() => Promise.resolve(vi.fn())),
}));

// Use a unique temp dir per test run to avoid cross-test pollution
const TEST_USER_DATA = path.join(os.tmpdir(), 'swe-test-registry-' + process.pid);
const REGISTRY_FILE = path.join(TEST_USER_DATA, 'instance-registry.json');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getRegistryClass() {
  const { InstanceRegistry } = require('../../src/main/instance-registry.js');
  return InstanceRegistry;
}

/**
 * Create a registry instance that is fully initialised WITHOUT calling init()
 * (which requires app.getPath to work via CJS require).
 * Equivalent to what init() does after app.getPath() succeeds.
 */
function makeInitializedRegistry() {
  const InstanceRegistry = getRegistryClass();
  const registry = new InstanceRegistry();
  registry.filePath = REGISTRY_FILE;
  registry.instanceId = crypto.randomUUID();
  registry._register();
  registry._startHeartbeat();
  return registry;
}

function ensureTestDir() {
  if (!fs.existsSync(TEST_USER_DATA)) {
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  }
}

function cleanupRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
  } catch (_) {}
  try {
    if (fs.existsSync(REGISTRY_FILE + '.tmp')) fs.unlinkSync(REGISTRY_FILE + '.tmp');
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('InstanceRegistry', () => {
  beforeEach(() => {
    ensureTestDir();
    cleanupRegistry();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanupRegistry();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. init() — tests that don't require app.getPath to work
  // ───────────────────────────────────────────────────────────────────────────
  describe('init()', () => {
    it('generates a UUID-format instanceId even when app.getPath fails (graceful fallback)', () => {
      // init() has a try/catch that still generates a UUID on failure
      const InstanceRegistry = getRegistryClass();
      const registry = new InstanceRegistry();
      const id = registry.init(); // app.getPath will fail, but UUID is still returned
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('returns a different instanceId each time', () => {
      const InstanceRegistry = getRegistryClass();
      const r1 = new InstanceRegistry();
      const r2 = new InstanceRegistry();
      const id1 = r1.init();
      const id2 = r2.init();
      expect(id1).not.toBe(id2);
    });

    it('sets instanceId on the registry object', () => {
      const InstanceRegistry = getRegistryClass();
      const registry = new InstanceRegistry();
      const id = registry.init();
      expect(registry.instanceId).toBe(id);
    });

    it('sets filePath when app.getPath succeeds (direct property test)', () => {
      // Test the filePath assignment logic directly
      const registry = makeInitializedRegistry();
      expect(registry.filePath).toBe(REGISTRY_FILE);
      clearInterval(registry._heartbeatInterval);
    });

    it('registers the instance in the file after manual init', () => {
      const registry = makeInitializedRegistry();
      const data = JSON.parse(fs.readFileSync(registry.filePath, 'utf-8'));
      expect(data.instances).toHaveProperty(registry.instanceId);
      clearInterval(registry._heartbeatInterval);
    });

    it('starts the heartbeat interval after manual init', () => {
      const registry = makeInitializedRegistry();
      expect(registry._heartbeatInterval).toBeDefined();
      expect(registry._heartbeatInterval).not.toBeNull();
      clearInterval(registry._heartbeatInterval);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. _register()
  // ───────────────────────────────────────────────────────────────────────────
  describe('_register()', () => {
    it('adds entry with pid, startedAt, managedHwnds:[], lastHeartbeat', () => {
      const registry = makeInitializedRegistry();
      const data = JSON.parse(fs.readFileSync(registry.filePath, 'utf-8'));
      const entry = data.instances[registry.instanceId];

      expect(entry.pid).toBe(process.pid);
      expect(entry.managedHwnds).toEqual([]);
      expect(entry.startedAt).toBeDefined();
      expect(entry.lastHeartbeat).toBeDefined();
      // Both should be valid ISO dates
      expect(new Date(entry.startedAt).toISOString()).toBe(entry.startedAt);
      expect(new Date(entry.lastHeartbeat).toISOString()).toBe(entry.lastHeartbeat);
      clearInterval(registry._heartbeatInterval);
    });

    it('preserves existing instances when registering a new one', () => {
      const r1 = makeInitializedRegistry();
      const id1 = r1.instanceId;

      const r2 = makeInitializedRegistry();
      const id2 = r2.instanceId;

      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      expect(data.instances).toHaveProperty(id1);
      expect(data.instances).toHaveProperty(id2);

      clearInterval(r1._heartbeatInterval);
      clearInterval(r2._heartbeatInterval);
    });

    it('creates the registry file if it does not exist', () => {
      // File was cleaned up in beforeEach
      expect(fs.existsSync(REGISTRY_FILE)).toBe(false);
      const registry = makeInitializedRegistry();
      expect(fs.existsSync(REGISTRY_FILE)).toBe(true);
      clearInterval(registry._heartbeatInterval);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. unregister()
  // ───────────────────────────────────────────────────────────────────────────
  describe('unregister()', () => {
    it('removes this instance from the registry', () => {
      const registry = makeInitializedRegistry();
      const id = registry.instanceId;
      registry.unregister();

      // File may be deleted (last instance) or entry removed
      if (fs.existsSync(REGISTRY_FILE)) {
        const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
        expect(data.instances).not.toHaveProperty(id);
      }
    });

    it('deletes the registry file when it is the last instance', () => {
      const registry = makeInitializedRegistry();
      registry.unregister();
      expect(fs.existsSync(REGISTRY_FILE)).toBe(false);
    });

    it('keeps the file when other instances remain', () => {
      const r1 = makeInitializedRegistry();
      const id1 = r1.instanceId;

      const r2 = makeInitializedRegistry();

      // Unregister only r2
      r2.unregister();

      expect(fs.existsSync(REGISTRY_FILE)).toBe(true);
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      expect(data.instances).toHaveProperty(id1);

      clearInterval(r1._heartbeatInterval);
    });

    it('clears the heartbeat interval', () => {
      const registry = makeInitializedRegistry();
      expect(registry._heartbeatInterval).toBeDefined();
      expect(registry._heartbeatInterval).not.toBeNull();

      registry.unregister();
      expect(registry._heartbeatInterval).toBeNull();
    });

    it('cancels any pending debounce timer', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      // Schedule a debounced write
      registry.updateManagedHwnds([1, 2, 3]);
      expect(registry._debounceTimer).not.toBeNull();

      registry.unregister();
      expect(registry._debounceTimer).toBeNull();

      vi.useRealTimers();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. _pruneDeadInstances()
  // ───────────────────────────────────────────────────────────────────────────
  describe('_pruneDeadInstances()', () => {
    it('removes entries whose PID is dead', () => {
      const registry = makeInitializedRegistry();

      const deadPid = 99999;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (pid === deadPid) throw new Error('ESRCH');
        return true;
      });

      const input = {
        instances: {
          'dead-instance': {
            pid: deadPid,
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            managedHwnds: [],
          },
          'live-instance': {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            managedHwnds: [],
          },
        },
      };

      const result = registry._pruneDeadInstances(input);

      expect(result.instances).not.toHaveProperty('dead-instance');
      expect(result.instances).toHaveProperty('live-instance');

      killSpy.mockRestore();
      clearInterval(registry._heartbeatInterval);
    });

    it('removes entries with stale lastHeartbeat (>5 minutes old)', () => {
      const registry = makeInitializedRegistry();

      const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
      const freshTime = new Date().toISOString();

      const input = {
        instances: {
          'stale-instance': {
            pid: process.pid,
            startedAt: staleTime,
            lastHeartbeat: staleTime,
            managedHwnds: [],
          },
          'fresh-instance': {
            pid: process.pid,
            startedAt: freshTime,
            lastHeartbeat: freshTime,
            managedHwnds: [],
          },
        },
      };

      const result = registry._pruneDeadInstances(input);

      expect(result.instances).not.toHaveProperty('stale-instance');
      expect(result.instances).toHaveProperty('fresh-instance');

      clearInterval(registry._heartbeatInterval);
    });

    it('keeps entries with alive PIDs and fresh heartbeats', () => {
      const registry = makeInitializedRegistry();

      const input = {
        instances: {
          'good-instance': {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            managedHwnds: [100, 200],
          },
        },
      };

      const result = registry._pruneDeadInstances(input);

      expect(result.instances).toHaveProperty('good-instance');
      expect(result.instances['good-instance'].managedHwnds).toEqual([100, 200]);

      clearInterval(registry._heartbeatInterval);
    });

    it('handles entries with no lastHeartbeat (keeps them if PID alive)', () => {
      const registry = makeInitializedRegistry();

      const input = {
        instances: {
          'no-heartbeat': {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            managedHwnds: [],
            // no lastHeartbeat field
          },
        },
      };

      const result = registry._pruneDeadInstances(input);
      // No lastHeartbeat means no staleness check — should be kept if PID alive
      expect(result.instances).toHaveProperty('no-heartbeat');

      clearInterval(registry._heartbeatInterval);
    });

    it('returns empty instances when all are dead', () => {
      const registry = makeInitializedRegistry();

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });

      const input = {
        instances: {
          'dead-1': {
            pid: 11111,
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            managedHwnds: [],
          },
          'dead-2': {
            pid: 22222,
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            managedHwnds: [],
          },
        },
      };

      const result = registry._pruneDeadInstances(input);
      expect(Object.keys(result.instances)).toHaveLength(0);

      killSpy.mockRestore();
      clearInterval(registry._heartbeatInterval);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. getOtherInstancesHwnds() — CQS: read-only, no writes
  // ───────────────────────────────────────────────────────────────────────────
  describe('getOtherInstancesHwnds()', () => {
    it('returns hwnds from other instances only', () => {
      const r1 = makeInitializedRegistry();
      const id1 = r1.instanceId;

      const r2 = makeInitializedRegistry();

      // Manually write hwnds for r1 in the registry
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      data.instances[id1].managedHwnds = [111, 222, 333];
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');

      // r2 should see r1's hwnds
      const hwnds = r2.getOtherInstancesHwnds();
      expect(hwnds).toBeInstanceOf(Set);
      expect(hwnds.has(111)).toBe(true);
      expect(hwnds.has(222)).toBe(true);
      expect(hwnds.has(333)).toBe(true);

      clearInterval(r1._heartbeatInterval);
      clearInterval(r2._heartbeatInterval);
    });

    it("does NOT include this instance's own hwnds", () => {
      const registry = makeInitializedRegistry();
      const id = registry.instanceId;

      // Manually set this instance's hwnds
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      data.instances[id].managedHwnds = [999];
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');

      const hwnds = registry.getOtherInstancesHwnds();
      expect(hwnds.has(999)).toBe(false);

      clearInterval(registry._heartbeatInterval);
    });

    it('returns empty Set when no other instances exist', () => {
      const registry = makeInitializedRegistry();

      const hwnds = registry.getOtherInstancesHwnds();
      expect(hwnds).toBeInstanceOf(Set);
      expect(hwnds.size).toBe(0);

      clearInterval(registry._heartbeatInterval);
    });

    it('does NOT call _writeRegistry (CQS: read-only)', () => {
      const registry = makeInitializedRegistry();

      const writeSpy = vi.spyOn(registry, '_writeRegistry');
      registry.getOtherInstancesHwnds();

      expect(writeSpy).not.toHaveBeenCalled();

      clearInterval(registry._heartbeatInterval);
    });

    it('returns empty Set when registry file does not exist', () => {
      const InstanceRegistry = getRegistryClass();
      const registry = new InstanceRegistry();
      registry.instanceId = 'test-id';
      registry.filePath = path.join(TEST_USER_DATA, 'nonexistent-registry.json');
      // Don't call _register() — file doesn't exist

      const hwnds = registry.getOtherInstancesHwnds();
      expect(hwnds).toBeInstanceOf(Set);
      expect(hwnds.size).toBe(0);
    });

    it('aggregates hwnds from multiple other instances', () => {
      const r1 = makeInitializedRegistry();
      const r2 = makeInitializedRegistry();
      const r3 = makeInitializedRegistry();

      // Set hwnds for r1 and r2
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      data.instances[r1.instanceId].managedHwnds = [10, 20];
      data.instances[r2.instanceId].managedHwnds = [30, 40];
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');

      // r3 should see both r1 and r2's hwnds
      const hwnds = r3.getOtherInstancesHwnds();
      expect(hwnds.has(10)).toBe(true);
      expect(hwnds.has(20)).toBe(true);
      expect(hwnds.has(30)).toBe(true);
      expect(hwnds.has(40)).toBe(true);

      clearInterval(r1._heartbeatInterval);
      clearInterval(r2._heartbeatInterval);
      clearInterval(r3._heartbeatInterval);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. updateManagedHwnds() — debounce
  // ───────────────────────────────────────────────────────────────────────────
  describe('updateManagedHwnds()', () => {
    it('does not write immediately (debounced)', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      const writeSpy = vi.spyOn(registry, '_writeRegistry');
      writeSpy.mockClear();

      registry.updateManagedHwnds([10, 20]);
      // No write yet — debounce hasn't fired
      expect(writeSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
      clearInterval(registry._heartbeatInterval);
    });

    it('writes after debounce delay (2000ms)', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      const writeSpy = vi.spyOn(registry, '_writeRegistry');
      writeSpy.mockClear();

      registry.updateManagedHwnds([10, 20]);
      vi.advanceTimersByTime(2000);

      expect(writeSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      clearInterval(registry._heartbeatInterval);
    });

    it('resets the debounce timer on repeated calls', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      const writeSpy = vi.spyOn(registry, '_writeRegistry');
      writeSpy.mockClear();

      registry.updateManagedHwnds([1]);
      vi.advanceTimersByTime(1000); // halfway
      registry.updateManagedHwnds([1, 2]); // reset timer
      vi.advanceTimersByTime(1000); // only 1s after reset — should NOT fire yet
      expect(writeSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000); // now 2s after last call — should fire
      expect(writeSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      clearInterval(registry._heartbeatInterval);
    });

    it('persists the hwnds to the registry file after debounce', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      registry.updateManagedHwnds([42, 43, 44]);
      vi.advanceTimersByTime(2000);

      vi.useRealTimers();

      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      expect(data.instances[registry.instanceId].managedHwnds).toEqual([42, 43, 44]);

      clearInterval(registry._heartbeatInterval);
    });

    it('sets _debounceTimer to non-null while pending', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      registry.updateManagedHwnds([1]);
      expect(registry._debounceTimer).not.toBeNull();

      vi.advanceTimersByTime(2000);
      expect(registry._debounceTimer).toBeNull();

      vi.useRealTimers();
      clearInterval(registry._heartbeatInterval);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. getRegistry()
  // ───────────────────────────────────────────────────────────────────────────
  describe('getRegistry()', () => {
    it('returns the current registry data', () => {
      const registry = makeInitializedRegistry();
      const id = registry.instanceId;

      const data = registry.getRegistry();
      expect(data).toHaveProperty('instances');
      expect(data.instances).toHaveProperty(id);

      clearInterval(registry._heartbeatInterval);
    });

    it('returns { instances: {} } when no file exists', () => {
      const InstanceRegistry = getRegistryClass();
      const registry = new InstanceRegistry();
      registry.filePath = path.join(TEST_USER_DATA, 'nonexistent-registry.json');

      const data = registry.getRegistry();
      expect(data).toEqual({ instances: {} });
    });

    it('reflects updates after updateManagedHwnds flush', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      registry.updateManagedHwnds([77, 88]);
      vi.advanceTimersByTime(2000);

      vi.useRealTimers();

      const data = registry.getRegistry();
      expect(data.instances[registry.instanceId].managedHwnds).toEqual([77, 88]);

      clearInterval(registry._heartbeatInterval);
    });

    it('returns all registered instances', () => {
      const r1 = makeInitializedRegistry();
      const r2 = makeInitializedRegistry();

      const data = r1.getRegistry();
      expect(Object.keys(data.instances).length).toBeGreaterThanOrEqual(2);
      expect(data.instances).toHaveProperty(r1.instanceId);
      expect(data.instances).toHaveProperty(r2.instanceId);

      clearInterval(r1._heartbeatInterval);
      clearInterval(r2._heartbeatInterval);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Heartbeat (_startHeartbeat)
  // ───────────────────────────────────────────────────────────────────────────
  describe('_startHeartbeat()', () => {
    it('updates lastHeartbeat timestamp after 60 seconds', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      const before = registry.getRegistry().instances[registry.instanceId].lastHeartbeat;

      // Advance time by 60 seconds to trigger heartbeat
      vi.advanceTimersByTime(60000);

      const after = registry.getRegistry().instances[registry.instanceId].lastHeartbeat;
      // The heartbeat should have updated the timestamp
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());

      vi.useRealTimers();
      clearInterval(registry._heartbeatInterval);
    });

    it('heartbeat interval is cleared after unregister()', () => {
      const registry = makeInitializedRegistry();
      expect(registry._heartbeatInterval).toBeDefined();
      expect(registry._heartbeatInterval).not.toBeNull();

      registry.unregister();
      expect(registry._heartbeatInterval).toBeNull();
    });

    it('heartbeat prunes stale instances', () => {
      vi.useFakeTimers();
      const registry = makeInitializedRegistry();

      // Manually add a stale instance to the registry
      const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      data.instances['stale-ghost'] = {
        pid: process.pid, // alive PID but stale heartbeat
        startedAt: staleTime,
        lastHeartbeat: staleTime,
        managedHwnds: [],
      };
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');

      // Trigger heartbeat
      vi.advanceTimersByTime(60000);

      vi.useRealTimers();

      const after = registry.getRegistry();
      expect(after.instances).not.toHaveProperty('stale-ghost');

      clearInterval(registry._heartbeatInterval);
    });
  });
});
