'use strict';

const {
  api,
  koffi,
  WinEventProc,
  EVENT_SYSTEM_FOREGROUND,
  WINEVENT_OUTOFCONTEXT,
  WINEVENT_SKIPOWNPROCESS,
  OBJID_WINDOW,
} = require('./win32');

/**
 * Monitors which window has foreground focus using SetWinEventHook with
 * EVENT_SYSTEM_FOREGROUND. Purely event-driven — no polling.
 *
 * When a managed window gains focus, calls the onFocusChange callback.
 *
 * This replaces Electron-driven tab activation with real Win32 focus detection.
 * The user clicks a REAL window (or its taskbar button, or Alt-Tabs to it),
 * and this monitor detects it and triggers a layout update.
 */
class ForegroundMonitor {
  constructor() {
    this._hook = null;
    this._callback = null; // koffi registered callback
    this._onFocusChange = null; // user callback: (hwnd) => void
    this._managedHwnds = new Set();
  }

  /**
   * Start monitoring.
   * @param {Function} onFocusChange - Called with (hwnd) when a managed window gains focus
   */
  start(onFocusChange) {
    this._onFocusChange = onFocusChange;

    this._callback = koffi.register(
      (hWinEventHook, event, hwnd, idObject, _idChild, _idEventThread, _dwmsEventTime) => {
        try {
          const hwndNum = Number(hwnd);
          if (idObject !== OBJID_WINDOW || hwndNum === 0) return;
          if (!this._managedHwnds.has(hwndNum)) return;
          console.log('[ForegroundMonitor] Managed window focused — hwnd:', hwndNum);
          this._onFocusChange(hwndNum);
        } catch (e) {
          console.error('[ForegroundMonitor] Callback error:', e);
        }
      },
      koffi.pointer(WinEventProc)
    );

    this._hook = api.SetWinEventHook(
      EVENT_SYSTEM_FOREGROUND, // eventMin
      EVENT_SYSTEM_FOREGROUND, // eventMax
      0, // hmodWinEventProc (null for out-of-context)
      koffi.address(this._callback), // lpfnWinEventProc
      0, // idProcess (0 = all processes)
      0, // idThread (0 = all threads)
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS // skip events from our own process
    );

    if (this._hook) {
      console.log('[ForegroundMonitor] Started — hook handle:', Number(this._hook));
    } else {
      console.error('[ForegroundMonitor] FAILED — SetWinEventHook returned null');
    }
  }

  /**
   * Stop monitoring and clean up the hook and callback.
   */
  stop() {
    if (this._hook) {
      api.UnhookWinEvent(this._hook);
      this._hook = null;
    }
    if (this._callback) {
      koffi.unregister(this._callback);
      this._callback = null;
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
}

module.exports = { ForegroundMonitor };
