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
   * Save the window group state.
   * @param {Array} managedWindows - Array of window state objects
   */
  save(managedWindows) {
    if (!this.filePath) return;

    try {
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        windows: managedWindows
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Saved ${managedWindows.length} windows to persistence`);
    } catch (e) {
      console.error('Failed to save persistence:', e);
    }
  }

  /**
   * Load the window group state.
   * @returns {Array|null} Array of saved window objects, or null if no saved state
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

      if (data.version !== 1 || !Array.isArray(data.windows)) {
        console.log('Invalid persistence format');
        return null;
      }

      console.log(`Loaded ${data.windows.length} windows from persistence (saved at ${data.savedAt})`);
      return data.windows;
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
