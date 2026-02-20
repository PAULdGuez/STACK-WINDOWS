'use strict';

const { api } = require('./win32');

/**
 * Monitors which window has foreground focus using GetForegroundWindow polling.
 * When a managed window gains focus, calls the onFocusChange callback.
 * 
 * This replaces Electron-driven tab activation with real Win32 focus detection.
 * The user clicks a REAL window (or its taskbar button, or Alt-Tabs to it),
 * and this monitor detects it and triggers a layout update.
 */
class ForegroundMonitor {
  constructor() {
    this._timer = null;
    this._lastForeground = 0;
    this._managedHwnds = new Set();
    this._onFocusChange = null;
    this._ownPid = process.pid;
  }

  /**
   * Start monitoring.
   * @param {Function} onFocusChange - Called with (hwnd) when a managed window gains focus
   */
  start(onFocusChange) {
    this._onFocusChange = onFocusChange;
    this._lastForeground = Number(api.GetForegroundWindow());

    this._timer = setInterval(() => {
      this._poll();
    }, 200);

    console.log('[ForegroundMonitor] Started polling every 200ms');
  }

  /**
   * Stop monitoring.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    console.log('[ForegroundMonitor] Stopped');
  }

  /**
   * Update the set of managed HWNDs to watch for.
   * @param {number[]} hwnds - Array of HWND numbers
   */
  updateManagedSet(hwnds) {
    this._managedHwnds = new Set(hwnds);
  }

  /**
   * Poll GetForegroundWindow and detect focus changes to managed windows.
   */
  _poll() {
    try {
      const current = Number(api.GetForegroundWindow());

      // No change
      if (current === this._lastForeground) return;

      this._lastForeground = current;

      // Skip if it's our own process
      if (current === 0) return;
      try {
        const pidBuf = [0];
        api.GetWindowThreadProcessId(current, pidBuf);
        if (pidBuf[0] === this._ownPid) return;
      } catch {
        return;
      }

      // Check if this is a managed window
      if (this._managedHwnds.has(current)) {
        console.log('[ForegroundMonitor] Managed window focused:', current);
        if (this._onFocusChange) {
          this._onFocusChange(current);
        }
      }
    } catch (e) {
      // Silently ignore polling errors
    }
  }
}

module.exports = { ForegroundMonitor };
