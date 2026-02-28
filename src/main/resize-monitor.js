'use strict';

const { api, koffi, WinEventProc, EVENT_SYSTEM_MOVESIZEEND, WINEVENT_OUTOFCONTEXT, OBJID_WINDOW } = require('./win32');

/**
 * Monitors when the user finishes resizing or moving a managed window using
 * SetWinEventHook with EVENT_SYSTEM_MOVESIZEEND. Purely event-driven — no polling.
 *
 * Pattern follows ForegroundMonitor.
 */
class ResizeMonitor {
  constructor() {
    this._hook = null;
    this._callback = null;       // koffi registered callback
    this._onResizeEnd = null;    // user callback: (hwnd) => void
    this._managedHwnds = new Set();
  }

  /**
   * Start monitoring for resize/move end events on managed windows.
   * @param {Function} onResizeEnd - Called with (hwnd) when a managed window finishes resize/move
   */
  start(onResizeEnd) {
    this._onResizeEnd = onResizeEnd;

    this._callback = koffi.register(
      (hWinEventHook, event, hwnd, idObject, idChild, idEventThread, dwmsEventTime) => {
        if (idObject !== OBJID_WINDOW) return;
        const hwndNum = Number(hwnd);
        if (hwndNum === 0) return;
        if (!this._managedHwnds.has(hwndNum)) return;
        this._onResizeEnd(hwndNum);
      },
      koffi.pointer(WinEventProc)
    );

    this._hook = api.SetWinEventHook(
      EVENT_SYSTEM_MOVESIZEEND,  // eventMin
      EVENT_SYSTEM_MOVESIZEEND,  // eventMax (same = only this event)
      0,                          // hmodWinEventProc (null = no DLL)
      this._callback,             // lpfnWinEventProc
      0,                          // idProcess (0 = all processes)
      0,                          // idThread (0 = all threads)
      WINEVENT_OUTOFCONTEXT       // dwFlags (callback in our process context)
    );

    console.log('[ResizeMonitor] Started — listening for EVENT_SYSTEM_MOVESIZEEND');
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
    console.log('[ResizeMonitor] Stopped');
  }

  /**
   * Update the set of managed HWNDs to watch for.
   * @param {number[]} hwnds - Array of HWND numbers
   */
  updateManagedSet(hwnds) {
    this._managedHwnds = new Set(hwnds);
  }
}

module.exports = { ResizeMonitor };
