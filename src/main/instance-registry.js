'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

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
  }

  /**
   * Initialize the registry.
   * Sets filePath, generates a unique instanceId, and registers this instance.
   * Must be called after app.whenReady().
   * @returns {string} The generated instanceId
   */
  init() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'instance-registry.json');
    this.instanceId = crypto.randomUUID();
    this._register();
    console.log('InstanceRegistry initialized, instanceId:', this.instanceId);
    return this.instanceId;
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
      managedHwnds: []
    };

    this._writeRegistry(registry);
  }

  /**
   * Read the registry file. Returns an empty registry on any failure.
   * @returns {{ instances: Object }}
   * @private
   */
  _readRegistry() {
    try {
      if (!this.filePath || !fs.existsSync(this.filePath)) {
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
    }
  }

  /**
   * Write the registry to disk using an atomic write (temp file + rename).
   * @param {{ instances: Object }} registry
   * @private
   */
  _writeRegistry(registry) {
    try {
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (e) {
      console.error('InstanceRegistry: failed to write registry:', e);
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
   * Return this instance's ID string.
   * @returns {string}
   */
  getInstanceId() {
    return this.instanceId;
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
