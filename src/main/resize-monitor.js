'use strict';

const { api, koffi, WinEventProc, EVENT_SYSTEM_MOVESIZEEND, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, OBJID_WINDOW } = require('./win32');

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
        try {
          const hwndNum = Number(hwnd);
          if (idObject !== OBJID_WINDOW || hwndNum === 0) return;
          if (!this._managedHwnds.has(hwndNum)) return;
          console.log('[ResizeMonitor] Managed window resize/move ended — hwnd:', hwndNum);
          this._onResizeEnd(hwndNum);
        } catch (e) {
          console.error('[ResizeMonitor] Callback error:', e);
        }
      },
      koffi.pointer(WinEventProc)
    );

    this._hook = api.SetWinEventHook(
      EVENT_SYSTEM_MOVESIZEEND,                           // eventMin
      EVENT_SYSTEM_MOVESIZEEND,                           // eventMax
      0,                                                   // hmodWinEventProc (null for out-of-context)
      koffi.address(this._callback),                       // lpfnWinEventProc
      0,                                                   // idProcess (0 = all processes)
      0,                                                   // idThread (0 = all threads)
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS      // skip events from our own process
    );

    if (this._hook) {
      console.log('[ResizeMonitor] Started — hook handle:', Number(this._hook));
    } else {
      console.error('[ResizeMonitor] FAILED — SetWinEventHook returned null');
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
