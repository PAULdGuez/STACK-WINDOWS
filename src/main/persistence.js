'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Persistence layer for window group state.
 * Saves to a JSON file in the app's userData directory.
 */
class Persistence {
  constructor() {
    this.filePath = null;
    this._writing = false;
    this._pendingState = null;
  }

  /**
   * Initialize the persistence file path.
   * Must be called after app.whenReady().
   * @param {string|null} [instanceId] - Optional instance ID for per-instance file isolation.
   *   If provided, saves to window-group-<instanceId>.json; otherwise uses window-group.json.
   */
  init(instanceId) {
    this.instanceId = instanceId || null;
    const userDataPath = app.getPath('userData');
    if (this.instanceId) {
      this.filePath = path.join(userDataPath, `window-group-${this.instanceId}.json`);
    } else {
      this.filePath = path.join(userDataPath, 'window-group.json');
    }
    console.log('Persistence file:', this.filePath);
  }

  /**
   * Delete the instance-specific persistence file.
   * Only deletes when instanceId is set (instance-aware mode).
   * In legacy mode (instanceId is null), does nothing to preserve backward compat.
   * Safe to call from quit handlers — never throws.
   */
  cleanupFile() {
    if (!this.instanceId) return;
    try {
      if (this.filePath && fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        console.log('Persistence file cleaned up:', this.filePath);
      }
    } catch (e) {
      console.error('Failed to cleanup persistence file:', e);
    }
  }

  /**
   * Save the window group state and config asynchronously.
   * Uses a write guard to prevent concurrent writes; the latest state
   * is always eventually flushed.
   * @param {Object} state - Object containing settings and windows
   * @returns {Promise<void>}
   */
  async save(state) {
    if (!this.filePath) return;

    if (this._writing) {
      this._pendingState = state;
      return;
    }

    this._writing = true;
    try {
      const data = {
        version: 2,
        savedAt: new Date().toISOString(),
        stackName: state.stackName || 'Managed Stack',
        hideAvailable: !!state.hideAvailable,
        customWidth: state.customWidth || null,
        customHeight: state.customHeight || null,
        backgroundColor: state.backgroundColor || '#000000',
        stackGap: state.stackGap || 0,
        topOffset: state.topOffset || 0,
        bounds: state.bounds || null,
        windows: state.windows || []
      };
      await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Saved ${data.windows.length} windows and config to persistence`);
    } catch (e) {
      console.error('Failed to save persistence:', e);
    } finally {
      this._writing = false;
      if (this._pendingState !== null) {
        const pending = this._pendingState;
        this._pendingState = null;
        this.save(pending).catch(e => {
          console.error('Failed to flush pending persistence state:', e);
        });
      }
    }
  }

  /**
   * Save the window group state and config synchronously.
   * Use this only in quit handlers (before-quit, window-all-closed)
   * where the process may exit immediately after the call.
   * @param {Object} state - Object containing settings and windows
   */
  saveSync(state) {
    if (!this.filePath) return;

    try {
      const data = {
        version: 2,
        savedAt: new Date().toISOString(),
        stackName: state.stackName || 'Managed Stack',
        hideAvailable: !!state.hideAvailable,
        customWidth: state.customWidth || null,
        customHeight: state.customHeight || null,
        backgroundColor: state.backgroundColor || '#000000',
        stackGap: state.stackGap || 0,
        topOffset: state.topOffset || 0,
        bounds: state.bounds || null,
        windows: state.windows || []
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Saved ${data.windows.length} windows and config to persistence (sync)`);
    } catch (e) {
      console.error('Failed to save persistence (sync):', e);
    }
  }

  /**
   * Load the application state and window group.
   * @returns {Object|null} State object, or null if no saved state
   */
  load() {
    if (!this.filePath) return null;

    try {
      if (!fs.existsSync(this.filePath)) {
        console.log('No persistence file found');
        return null;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Support migration from version 1
      if (data.version === 1 && Array.isArray(data.windows)) {
        console.log('Migrating persistence from version 1 to 2');
        return {
          stackName: 'Managed Stack',
          hideAvailable: false,
          customWidth: null,
          customHeight: null,
          backgroundColor: '#000000',
          stackGap: 0,
          topOffset: 0,
          bounds: null,
          windows: data.windows
        };
      }

      if (data.version !== 2 || !Array.isArray(data.windows)) {
        console.log('Invalid persistence format');
        return null;
      }

      console.log(`Loaded ${data.windows.length} windows and config from persistence (saved at ${data.savedAt})`);
      return {
        stackName: data.stackName,
        hideAvailable: data.hideAvailable,
        customWidth: data.customWidth || null,
        customHeight: data.customHeight || null,
        backgroundColor: data.backgroundColor || '#000000',
        stackGap: data.stackGap || 0,
        topOffset: data.topOffset || 0,
        bounds: data.bounds,
        windows: data.windows
      };
    } catch (e) {
      console.error('Failed to load persistence:', e);
      return null;
    }
  }

  /**
   * Clear the saved state.
   */
  clear() {
    if (!this.filePath) return;

    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        console.log('Persistence cleared');
      }
    } catch (e) {
      console.error('Failed to clear persistence:', e);
    }
  }
}

module.exports = { Persistence };
