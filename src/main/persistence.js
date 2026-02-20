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
  }

  /**
   * Initialize the persistence file path.
   * Must be called after app.whenReady().
   */
  init() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'window-group.json');
    console.log('Persistence file:', this.filePath);
  }

  /**
   * Save the window group state and config.
   * @param {Object} state - Object containing settings and windows
   */
  save(state) {
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
        bounds: state.bounds || null,
        windows: state.windows || []
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Saved ${data.windows.length} windows and config to persistence`);
    } catch (e) {
      console.error('Failed to save persistence:', e);
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
