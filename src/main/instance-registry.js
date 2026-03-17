'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const lockfile = require('proper-lockfile');

/**
 * Manages a shared registry of running StackWindowsElectron instances.
 * The registry is stored as a JSON file at <userData>/instance-registry.json.
 *
 * Registry file format:
 * {
 *   "instances": {
 *     "<instanceId>": {
 *       "pid": 12345,
 *       "startedAt": "2026-02-23T...",
 *       "managedHwnds": [123, 456, 789]
 *     }
 *   }
 * }
 */
class InstanceRegistry {
  constructor() {
    this.filePath = null;
    this.instanceId = null;
    this._debounceTimer = null;
    this._DEBOUNCE_MS = 2000;
    this._lockOptions = {
      stale: 10000,
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
    };
  }

  /**
   * Initialize the registry.
   * Sets filePath, generates a unique instanceId, and registers this instance.
   * Must be called after app.whenReady().
   * @returns {string} The generated instanceId
   */
  init() {
    try {
      const userDataPath = app.getPath('userData');
      this.filePath = path.join(userDataPath, 'instance-registry.json');
      this.instanceId = crypto.randomUUID();
      this._register();
      this._startHeartbeat();
      return this.instanceId;
    } catch (e) {
      console.error('InstanceRegistry: init failed:', e);
      this.instanceId = this.instanceId || crypto.randomUUID();
      return this.instanceId;
    }
  }

  /**
   * Ensure the registry file exists so proper-lockfile can lock it.
   * proper-lockfile requires the target file to exist before locking.
   * @private
   */
  _ensureFileExists() {
    if (!fs.existsSync(this.filePath)) {
      try {
        fs.writeFileSync(this.filePath, JSON.stringify({ instances: {} }, null, 2), 'utf-8');
      } catch {
        // Ignore — if we can't create it, locking will fail gracefully
      }
    }
  }

  /**
   * Register this instance in the shared registry file.
   * Prunes dead instances before writing.
   * @private
   */
  _register() {
    let registry = this._readRegistry();
    registry = this._pruneDeadInstances(registry);

    registry.instances[this.instanceId] = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      managedHwnds: [],
    };

    this._writeRegistry(registry);
  }

  /**
   * Read the registry file under an exclusive lock.
   * Returns an empty registry on any failure (including lock failure).
   * @returns {{ instances: Object }}
   * @private
   */
  _readRegistry() {
    if (!this.filePath) {
      return { instances: {} };
    }

    this._ensureFileExists();

    let release = null;
    try {
      release = lockfile.lockSync(this.filePath, this._lockOptions);
    } catch (e) {
      console.error('InstanceRegistry: failed to acquire lock for read (best-effort):', e.message);
      // Best-effort: proceed without lock
    }

    try {
      if (!fs.existsSync(this.filePath)) {
        return { instances: {} };
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data || typeof data.instances !== 'object') {
        return { instances: {} };
      }
      return data;
    } catch (e) {
      console.error('InstanceRegistry: failed to read registry:', e);
      return { instances: {} };
    } finally {
      if (release) {
        try {
          release();
        } catch (e) {
          console.error('InstanceRegistry: failed to release read lock:', e.message);
        }
      }
    }
  }

  /**
   * Write the registry to disk using an exclusive lock and atomic write (temp file + rename).
   * @param {{ instances: Object }} registry
   * @private
   */
  _writeRegistry(registry) {
    if (!this.filePath) {
      return;
    }

    this._ensureFileExists();

    let release = null;
    try {
      release = lockfile.lockSync(this.filePath, this._lockOptions);
    } catch (e) {
      console.error('InstanceRegistry: failed to acquire lock for write (best-effort):', e.message);
      // Best-effort: proceed without lock using atomic write as defense-in-depth
    }

    const tmpPath = this.filePath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (e) {
      console.error('InstanceRegistry: failed to write registry:', e);
      // Clean up temp file if rename failed
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    } finally {
      if (release) {
        try {
          release();
        } catch (e) {
          console.error('InstanceRegistry: failed to release write lock:', e.message);
        }
      }
    }
  }

  /**
   * Remove entries from the registry whose PID is no longer alive.
   * Uses signal 0 (no-op) to check process existence.
   * @param {{ instances: Object }} registry
   * @returns {{ instances: Object }} Cleaned registry
   * @private
   */
  _pruneDeadInstances(registry) {
    const cleaned = { instances: {} };
    for (const [id, entry] of Object.entries(registry.instances || {})) {
      const alive = this._isPidAlive(entry.pid);
      if (alive) {
        cleaned.instances[id] = entry;
      } else {
        console.log(`InstanceRegistry: pruning dead instance ${id} (pid ${entry.pid})`);
      }
    }
    return cleaned;
  }

  /**
   * Check whether a PID is still alive using signal 0.
   *
   * Known limitation on Windows: process.kill(pid, 0) can return false
   * positives if Windows has reused the PID for a different process.
   * This is acceptable because:
   * 1. PID reuse within a single user session is rare
   * 2. The worst case is keeping a stale registry entry (harmless)
   * 3. The alternative (execSync tasklist) blocks the event loop ~100ms
   *
   * @param {number} pid
   * @returns {boolean}
   * @private
   */
  _isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update the managedHwnds for this instance in the registry.
   * Debounced to at most one write per 2 seconds.
   * @param {number[]} hwnds
   */
  updateManagedHwnds(hwnds) {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._flushManagedHwnds(hwnds);
    }, this._DEBOUNCE_MS);
  }

  /**
   * Immediately write the managedHwnds update to the registry file.
   * @param {number[]} hwnds
   * @private
   */
  _flushManagedHwnds(hwnds) {
    try {
      const registry = this._readRegistry();
      if (registry.instances[this.instanceId]) {
        registry.instances[this.instanceId].managedHwnds = hwnds;
        this._writeRegistry(registry);
      }
    } catch (e) {
      console.error('InstanceRegistry: failed to update managedHwnds:', e);
    }
  }

  /**
   * Return a Set of all managedHwnds from OTHER live instances (not this one).
   * Prunes dead instances as a side effect.
   * @returns {Set<number>}
   */
  getOtherInstancesHwnds() {
    try {
      let registry = this._readRegistry();
      registry = this._pruneDeadInstances(registry);
      // Persist the pruned registry so future reads are clean
      this._writeRegistry(registry);

      const result = new Set();
      for (const [id, entry] of Object.entries(registry.instances)) {
        if (id === this.instanceId) continue;
        for (const hwnd of entry.managedHwnds || []) {
          result.add(hwnd);
        }
      }
      return result;
    } catch (e) {
      console.error('InstanceRegistry: failed to get other instances hwnds:', e);
      return new Set();
    }
  }

  /**
   * Synchronously remove this instance from the registry.
   * If this was the last instance, delete the registry file entirely.
   * Safe to call from quit handlers.
   */
  unregister() {
    try {
      // Cancel any pending debounced write
      if (this._debounceTimer !== null) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }

      const registry = this._readRegistry();
      delete registry.instances[this.instanceId];

      const remaining = Object.keys(registry.instances).length;
      if (remaining === 0) {
        // Last instance — delete the registry file
        try {
          if (fs.existsSync(this.filePath)) {
            fs.unlinkSync(this.filePath);
            console.log('InstanceRegistry: deleted registry file (last instance)');
          }
        } catch (e) {
          console.error('InstanceRegistry: failed to delete registry file:', e);
        }
      } else {
        this._writeRegistry(registry);
        console.log(`InstanceRegistry: unregistered instance ${this.instanceId}, ${remaining} remaining`);
      }
    } catch (e) {
      console.error('InstanceRegistry: failed to unregister:', e);
    }
  }

  /**
   * Return the current registry contents (public accessor for cleanup tasks).
   * @returns {{ instances: Object }}
   */
  getRegistry() {
    return this._readRegistry();
  }
}

module.exports = { InstanceRegistry };
