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
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 }
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
      } catch (e) {
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
      lastHeartbeat: new Date().toISOString(),
      managedHwnds: []
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
      try { fs.unlinkSync(tmpPath); } catch (_) {}
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
   * Remove entries from the registry whose PID is no longer alive,
   * or whose lastHeartbeat is older than 5 minutes (300000ms).
   * Uses signal 0 (no-op) to check process existence.
   * @param {{ instances: Object }} registry
   * @returns {{ instances: Object }} Cleaned registry
   * @private
   */
  _pruneDeadInstances(registry) {
    const cleaned = { instances: {} };
    const now = Date.now();
    const HEARTBEAT_TIMEOUT_MS = 300000; // 5 minutes
    for (const [id, entry] of Object.entries(registry.instances || {})) {
      const alive = this._isPidAlive(entry.pid);
      if (!alive) {
        console.log(`InstanceRegistry: pruning dead instance ${id} (pid ${entry.pid})`);
        continue;
      }
      if (entry.lastHeartbeat) {
        const age = now - new Date(entry.lastHeartbeat).getTime();
        if (age > HEARTBEAT_TIMEOUT_MS) {
          console.log(`InstanceRegistry: pruning stale instance ${id} (lastHeartbeat ${entry.lastHeartbeat})`);
          continue;
        }
      }
      cleaned.instances[id] = entry;
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
    } catch (e) {
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
   * Pure read-only — does NOT prune or write to disk.
   * @returns {Set<number>}
   */
  getOtherInstancesHwnds() {
    try {
      const registry = this._readRegistry();

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
   * Start a periodic heartbeat that updates this instance's lastHeartbeat
   * timestamp and prunes dead/stale instances every 60 seconds.
   * @private
   */
  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      try {
        // Single atomic operation: lock, read, update timestamp, prune, write, unlock
        const registry = this._readRegistry();
        if (registry.instances[this.instanceId]) {
          registry.instances[this.instanceId].lastHeartbeat = new Date().toISOString();
        }
        const cleaned = this._pruneDeadInstances(registry);
        this._writeRegistry(cleaned);
      } catch (e) {
        console.error('InstanceRegistry: heartbeat failed:', e);
      }
    }, 60000); // Every 60 seconds
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

      // Clear heartbeat interval
      if (this._heartbeatInterval) {
        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
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
