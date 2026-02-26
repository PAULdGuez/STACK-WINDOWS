'use strict';

const win32 = require('./win32');
const { api, koffi, EnumWindowsProc, RECT,
  SWP_NOACTIVATE, SWP_SHOWWINDOW, SWP_NOMOVE, SWP_NOSIZE,
  HWND_TOP, HWND_NOTOPMOST,
  SW_RESTORE,
  GWL_EXSTYLE, WS_EX_TOOLWINDOW } = win32;

const CONTROLLER_WIDTH = 300;
const HEADER_HEIGHT = 40;

class WindowManager {
  constructor(options = {}) {
    // Array of managed windows: [{ hwnd, title, processId, originalRect }]
    // Windows maintain their order here.
    this.managedWindows = [];
    this.activeHwnd = 0; // Explicitly track active window rather than relying on index 0
    this.ownPid = process.pid;
    this.stackName = 'Managed Stack';
    this.hideAvailable = false;
    this.backgroundColor = '#000000';
    this.stackGap = 0; // pixels of horizontal gap between controller and managed windows
    this.customWidth = null;  // null = use all available space (default behavior)
    this.customHeight = null; // null = use all available space (default behavior)
    this._restoreAnimationTimers = new Map(); // Map<hwnd, timerId>
    this.restoreAnimationDuration = options.restoreAnimationDuration || 150; // ms
    this.skipAnimation = true;
  }

  setBackgroundColor(color) {
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      this.backgroundColor = color;
    }
  }

  getBackgroundColor() {
    return this.backgroundColor;
  }

  /**
   * Read a window's title using GetWindowTextW with proper buffer handling.
   */
  _getWindowTitle(hwndNum) {
    const titleLen = api.GetWindowTextLengthW(hwndNum);
    if (titleLen <= 0) return '';
    const buf = [' '.repeat(titleLen + 1)];
    api.GetWindowTextW(hwndNum, buf, titleLen + 1);
    return (buf[0] || '').trim();
  }

  /**
   * Enumerate all visible, titled, non-tool windows on the system.
   * Excludes our own process and already-managed windows.
   * @param {Set<number>} [excludeHwnds=new Set()] - Optional set of HWNDs to exclude (e.g. windows managed by other instances)
   */
  getAvailableWindows(excludeHwnds = new Set()) {
    const windows = [];
    const managedHwnds = new Set(this.managedWindows.map(w => w.hwnd));

    const callback = koffi.register((hwnd, lParam) => {
      try {
        const hwndNum = Number(hwnd);

        if (!api.IsWindowVisible(hwndNum)) return 1;
        if (api.IsIconic(hwndNum)) return 1;

        const exStyle = Number(api.GetWindowLongPtrW(hwndNum, GWL_EXSTYLE));
        if (exStyle & WS_EX_TOOLWINDOW) return 1;

        const pidBuf = [0];
        api.GetWindowThreadProcessId(hwndNum, pidBuf);
        if (pidBuf[0] === this.ownPid) return 1;

        if (managedHwnds.has(hwndNum)) return 1;
        if (excludeHwnds.has(hwndNum)) return 1;

        const title = this._getWindowTitle(hwndNum);
        if (!title) return 1;

        const rect = {};
        api.GetWindowRect(hwndNum, rect);

        windows.push({
          hwnd: hwndNum,
          title: title,
          bounds: {
            left: rect.left || 0,
            top: rect.top || 0,
            right: rect.right || 0,
            bottom: rect.bottom || 0
          }
        });
      } catch (e) {
        // Skip windows that cause errors
      }
      return 1;
    }, koffi.pointer(EnumWindowsProc));

    try {
      try {
        api.EnumWindows(koffi.address(callback), 0);
      } catch (e) {
        console.error('EnumWindows failed:', e);
      }
      return windows;
    } finally {
      koffi.unregister(callback);
    }
  }

  /**
   * Add a window to the managed group.
   * This is the ONLY action that calls SetForegroundWindow,
   * because the user explicitly chose to add it.
   */
  addWindow(hwnd, title) {
    const hwndNum = Number(hwnd);

    if (this.managedWindows.some(w => w.hwnd === hwndNum)) return;

    if (!api.IsWindow(hwndNum)) return;

    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const success = api.GetWindowRect(hwndNum, rect);
    if (!success) {
      console.warn('GetWindowRect failed for hwnd:', hwndNum);
    }

    const pidBuf = [0];
    api.GetWindowThreadProcessId(hwndNum, pidBuf);

    const entry = {
      hwnd: hwndNum,
      title: title || this._getWindowTitle(hwndNum) || 'Untitled',
      customTitle: null,
      processId: pidBuf[0],
      originalRect: {
        left: rect.left || 0,
        top: rect.top || 0,
        right: rect.right || 0,
        bottom: rect.bottom || 0
      }
    };

    // Insert at front
    this.managedWindows.unshift(entry);

    // Set as the active window immediately
    this.activeHwnd = hwndNum;

    if (api.IsIconic(hwndNum)) {
      api.ShowWindow(hwndNum, SW_RESTORE);
    }

    // Only place we call SetForegroundWindow — user explicitly added this window
    api.SetForegroundWindow(hwndNum);
  }

  /**
   * Remove a window from the managed group and animate it back to its original position.
   */
  removeWindow(hwnd) {
    const hwndNum = Number(hwnd);
    const idx = this.managedWindows.findIndex(w => w.hwnd === hwndNum);
    if (idx === -1) return;

    const entry = this.managedWindows[idx];
    this.managedWindows.splice(idx, 1);

    // Unset the activeHwnd if it was removed
    if (this.activeHwnd === hwndNum) {
      this.activeHwnd = this.managedWindows.length > 0 ? this.managedWindows[0].hwnd : 0;
    }

    // Animate the removed window back to its original position.
    // The callback is a no-op here; doLayout for remaining windows is triggered
    // by the caller (main.js) independently.
    this._animateRestore(entry, () => {});
  }

  /**
   * Promote a window to active because the OS reported it gained focus.
   * Does NOT modify order.
   * @param {number} hwnd - Window HANDLE
   * @param {boolean} forceNativeForeground - If true, forcefully bring to front
   * Returns true if the active window actually changed.
   */
  promoteToActive(hwnd, forceNativeForeground = false) {
    const hwndNum = Number(hwnd);
    const idx = this.managedWindows.findIndex(w => w.hwnd === hwndNum);
    if (idx === -1) return false;

    if (this.activeHwnd === hwndNum) {
      // Already active in our stack, but may be behind other windows.
      // If explicitly requested, bring to foreground anyway.
      if (forceNativeForeground) {
        if (api.IsIconic(hwndNum)) {
          api.ShowWindow(hwndNum, SW_RESTORE);
        }
        api.SetForegroundWindow(hwndNum);
      }
      return false;
    }

    this.activeHwnd = hwndNum;

    if (api.IsIconic(hwndNum)) {
      api.ShowWindow(hwndNum, SW_RESTORE);
    }

    if (forceNativeForeground) {
      api.SetForegroundWindow(hwndNum);
    }

    return true;
  }

  /**
   * Remove dead windows (where IsWindow returns false).
   */
  removeDeadWindows() {
    const before = this.managedWindows.length;
    let activeWindowStillAlive = false;

    this.managedWindows = this.managedWindows.filter(w => {
      try {
        const alive = api.IsWindow(w.hwnd) !== 0;
        if (alive && w.hwnd === this.activeHwnd) {
          activeWindowStillAlive = true;
        }
        return alive;
      } catch {
        return false;
      }
    });

    if (!activeWindowStillAlive) {
      this.activeHwnd = this.managedWindows.length > 0 ? this.managedWindows[0].hwnd : 0;
    }

    return this.managedWindows.length !== before;
  }

  /**
   * Restore all managed windows to their original positions instantly (no animation).
   * Used during app quit — no time for animation, must be synchronous and immediate.
   */
  restoreAll() {
    // Cancel any in-flight restore animation to avoid interfering with instant snap
    this._stopRestoreAnimation();
    for (const entry of this.managedWindows) {
      if (!api.IsWindow(entry.hwnd)) continue;
      this._restoreWindow(entry);
    }
    this.managedWindows = [];
    this.activeHwnd = 0;
  }

  /**
   * Cancel any in-flight restore animation (separate timer from main layout animation).
   * If hwnd is provided, stops only that window's timer.
   * If hwnd is omitted (or null/undefined), stops all restore timers.
   * @param {number} [hwnd]
   */
  _stopRestoreAnimation(hwnd) {
    if (hwnd != null) {
      const timer = this._restoreAnimationTimers.get(hwnd);
      if (timer) {
        clearTimeout(timer);
        this._restoreAnimationTimers.delete(hwnd);
      }
    } else {
      // Stop all
      for (const timer of this._restoreAnimationTimers.values()) {
        clearTimeout(timer);
      }
      this._restoreAnimationTimers.clear();
    }
  }

  /**
   * Animate a single window sliding back to its originalRect position.
   * Uses a per-window timer keyed by hwnd in _restoreAnimationTimers so that
   * multiple windows can animate concurrently without cancelling each other.
   * Duration: restoreAnimationDuration ms (slightly longer than layout animation for visual distinction).
   * Easing: cubic ease-out (same as _animateLayout).
   * @param {{ hwnd: number, originalRect: {left,top,right,bottom} }} entry
   * @param {Function} callback - Called when animation completes
   */
  _animateRestore(entry, callback) {
    if (this.skipAnimation) {
      this._restoreWindow(entry);
      callback();
      return;
    }

    // Cancel any in-flight restore animation for this specific window only
    this._stopRestoreAnimation(entry.hwnd);

    const r = entry.originalRect;
    const targetX = r.left;
    const targetY = r.top;
    const targetCx = (r.right - r.left) || 800;
    const targetCy = (r.bottom - r.top) || 600;

    // Get current position as animation start
    let startX = targetX;
    let startY = targetY;
    let startCx = targetCx;
    let startCy = targetCy;
    try {
      const currentRect = {};
      api.GetWindowRect(entry.hwnd, currentRect);
      startX = currentRect.left || targetX;
      startY = currentRect.top || targetY;
      startCx = (currentRect.right - currentRect.left) || targetCx;
      startCy = (currentRect.bottom - currentRect.top) || targetCy;
    } catch (e) {
      // fallback to target (no animation, will snap immediately)
    }

    const DURATION = this.restoreAnimationDuration; // ms — slightly longer than layout animation for visual distinction
    const startTime = Date.now();

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / DURATION, 1);
      // Apply ease-out-cubic easing
      const ease = 1 - Math.pow(1 - progress, 3);

      const x = Math.round(startX + (targetX - startX) * ease);
      const y = Math.round(startY + (targetY - startY) * ease);
      const cx = Math.round(startCx + (targetCx - startCx) * ease);
      const cy = Math.round(startCy + (targetCy - startCy) * ease);

      try {
        if (progress >= 1) {
          // Final frame: snap to exact target and clear TOPMOST
          this._restoreAnimationTimers.delete(entry.hwnd);
          api.SetWindowPos(
            entry.hwnd,
            HWND_NOTOPMOST,
            targetX, targetY, targetCx, targetCy,
            SWP_SHOWWINDOW
          );
          callback();
        } else {
          // Intermediate frame: single SetWindowPos (not DeferWindowPos — only one window)
          api.SetWindowPos(
            entry.hwnd,
            HWND_NOTOPMOST,
            x, y, cx, cy,
            SWP_SHOWWINDOW
          );
          this._restoreAnimationTimers.set(entry.hwnd, setTimeout(tick, 1000 / 30));
        }
      } catch (e) {
        console.error(`Restore animation frame failed for hwnd ${entry.hwnd}:`, e);
        this._restoreAnimationTimers.delete(entry.hwnd);
        // Fallback: instant snap to original position
        try {
          api.SetWindowPos(entry.hwnd, HWND_NOTOPMOST, targetX, targetY, targetCx, targetCy, SWP_SHOWWINDOW);
        } catch (er) { }
        callback();
      }
    };

    this._restoreAnimationTimers.set(entry.hwnd, setTimeout(tick, 0));
  }

  _applyLayout(targetLayouts) {
    if (targetLayouts.length === 0) return;

    // Instant snap: single DeferWindowPos batch, no animation loop
    const hWinPosInfo = api.BeginDeferWindowPos(targetLayouts.length);
    if (hWinPosInfo) {
      let hInfo = hWinPosInfo;
      for (const target of targetLayouts) {
        if (target.restore) {
          api.ShowWindow(target.hwnd, SW_RESTORE);
        }
        hInfo = api.DeferWindowPos(hInfo, target.hwnd, HWND_TOP, target.x, target.y, target.cx, target.cy, target.flags);
        if (!hInfo) break;
      }
      if (hInfo) api.EndDeferWindowPos(hInfo);
    } else {
      // Fallback: individual SetWindowPos
      for (const target of targetLayouts) {
        if (target.restore) api.ShowWindow(target.hwnd, SW_RESTORE);
        api.SetWindowPos(target.hwnd, HWND_TOP, target.x, target.y, target.cx, target.cy, target.flags);
      }
    }
  }

  /**
   * Apply the spatial stack layout to all managed windows.
   *
   * Background windows: preview strips at the top, each HEADER_HEIGHT px
   * Active window (this.activeHwnd): fills remaining area below the strips
   *
   * All positioning is done via SetWindowPos — pure Win32.
   */
  layoutStack(screenBounds) {
    if (this.managedWindows.length === 0) return;

    const workArea = screenBounds || { x: 0, y: 0, width: 1920, height: 1040, displayRightEdge: null };
    // The starting X of the stack is the entire width of the controller window
    const startX = workArea.x + workArea.width + this.stackGap;

    // Use displayRightEdge passed from main.js (based on the display where the app lives).
    // Fallback to a safe default if not provided (backward compat).
    const displayRightEdge = workArea.displayRightEdge != null
      ? workArea.displayRightEdge
      : startX + 1920; // fallback: assume 1920px wide display starting at startX
    const availableWidth = displayRightEdge - startX;
    if (availableWidth < 200) {
      console.warn('layoutStack: not enough space to the right of controller, skipping layout');
      return;
    }
    const availableHeight = workArea.height;

    // Apply custom dimensions (clamped to available space so we never exceed the monitor)
    const effectiveWidth = this.customWidth !== null
      ? Math.min(this.customWidth, availableWidth)
      : availableWidth;
    const effectiveHeight = this.customHeight !== null
      ? Math.min(this.customHeight, availableHeight)
      : availableHeight;

    // Determine the active window
    const activeIdx = this.managedWindows.findIndex(w => w.hwnd === this.activeHwnd);
    const activeWindow = activeIdx !== -1 ? this.managedWindows[activeIdx] : this.managedWindows[0];
    const trueActiveHwnd = activeWindow ? activeWindow.hwnd : 0;

    const inactiveCount = this.managedWindows.length - (activeWindow ? 1 : 0);

    // Cap strip area to max 60% of effectiveHeight, reduce header height if needed
    const maxStripArea = Math.floor(effectiveHeight * 0.6);
    let effectiveHeaderHeight = HEADER_HEIGHT;
    if (inactiveCount * effectiveHeaderHeight > maxStripArea) {
      effectiveHeaderHeight = Math.max(Math.floor(maxStripArea / inactiveCount), 10); // min 10px per strip
    }

    const targetLayouts = [];

    // Position background windows first (strips at top)
    let stripIndex = 0;
    for (const w of this.managedWindows) {
      if (w.hwnd === trueActiveHwnd) continue; // Skip the active window

      const y = workArea.y + stripIndex * effectiveHeaderHeight;

      targetLayouts.push({
        hwnd: w.hwnd,
        x: startX,
        y: y,
        cx: effectiveWidth,
        cy: effectiveHeight,
        flags: SWP_NOACTIVATE | SWP_SHOWWINDOW,
        restore: api.IsIconic(w.hwnd) || api.IsZoomed(w.hwnd)
      });

      stripIndex++;
    }

    // Position active window on top, covering background window bodies
    if (activeWindow) {
      const activeY = workArea.y + inactiveCount * effectiveHeaderHeight;
      const activeHeight = effectiveHeight - (inactiveCount * effectiveHeaderHeight);

      targetLayouts.push({
        hwnd: activeWindow.hwnd,
        x: startX,
        y: activeY,
        cx: effectiveWidth,
        cy: activeHeight > 100 ? activeHeight : effectiveHeight,
        flags: SWP_SHOWWINDOW | SWP_NOACTIVATE,
        restore: api.IsIconic(activeWindow.hwnd) || api.IsZoomed(activeWindow.hwnd)
      });
    }

    this._applyLayout(targetLayouts);
  }

  _restoreWindow(entry) {
    try {
      const r = entry.originalRect;
      const w = (r.right - r.left) || 800;
      const h = (r.bottom - r.top) || 600;
      api.SetWindowPos(
        entry.hwnd,
        HWND_NOTOPMOST,
        r.left, r.top, w, h,
        SWP_SHOWWINDOW
      );
    } catch (e) {
      console.error(`Failed to restore window ${entry.hwnd}:`, e);
    }
  }

  /**
   * Get the HWND of the currently active (index 0) window, or 0 if none.
   */
  getActiveHwnd() {
    return this.activeHwnd;
  }

  /**
   * Get array of all managed HWNDs (for the foreground monitor).
   */
  getManagedHwnds() {
    return this.managedWindows.map(w => w.hwnd);
  }

  /**
   * Get the current managed windows list (for UI display).
   */
  getManagedWindows() {
    return this.managedWindows.map(w => ({
      hwnd: w.hwnd,
      title: w.title,
      customTitle: w.customTitle || null,
      processId: w.processId
    }));
  }

  /**
   * Set a custom display name for a managed window.
   * Pass null or empty string to clear the custom name (revert to Win32 title).
   * @param {number} hwnd
   * @param {string|null} customTitle
   * @returns {boolean} true if the window was found and renamed
   */
  renameWindow(hwnd, customTitle) {
    const hwndNum = Number(hwnd);
    const entry = this.managedWindows.find(w => w.hwnd === hwndNum);
    if (!entry) return false;
    entry.customTitle = (customTitle && customTitle.trim()) || null;
    return true;
  }

  /**
   * Set custom dimensions for managed windows.
   * Pass null for either dimension to use all available space (default behavior).
   * Values are clamped to a minimum of 200px.
   * @param {number|null} width
   * @param {number|null} height
   */
  setCustomDimensions(width, height) {
    this.customWidth = width !== null && width !== undefined
      ? Math.max(200, Number(width))
      : null;
    this.customHeight = height !== null && height !== undefined
      ? Math.max(200, Number(height))
      : null;
  }

  /**
   * Set the horizontal gap between the controller panel and managed windows.
   * @param {number} gap - Gap in pixels (0 = no gap, clamped to 0-500)
   */
  setStackGap(gap) {
    this.stackGap = gap !== null && gap !== undefined
      ? Math.max(0, Math.min(500, Math.round(Number(gap))))
      : 0;
  }

  /**
   * Get the current stack gap.
   * @returns {number}
   */
  getStackGap() {
    return this.stackGap;
  }

  /**
   * Get the current custom dimensions.
   * @returns {{ customWidth: number|null, customHeight: number|null }}
   */
  getCustomDimensions() {
    return { customWidth: this.customWidth, customHeight: this.customHeight };
  }

  /**
   * Get serializable state for persistence (version 2 compatible shape in main).
   */
  getState() {
    return {
      stackName: this.stackName,
      hideAvailable: this.hideAvailable,
      backgroundColor: this.backgroundColor,
      customWidth: this.customWidth,
      customHeight: this.customHeight,
      stackGap: this.stackGap,
      windows: this.managedWindows.map(w => ({
        hwnd: w.hwnd,
        title: w.title,
        customTitle: w.customTitle || null,
        processId: w.processId,
        originalRect: w.originalRect
      }))
    };
  }

  /**
   * Load state from persistence. Tries to reconnect to existing windows.
   */
  loadState(savedState) {
    if (!savedState) return;

    // Support either direct array (version 1) or config object (version 2)
    const savedWindows = Array.isArray(savedState) ? savedState : (savedState.windows || []);

    if (savedState.stackName) this.stackName = savedState.stackName;
    if (savedState.hideAvailable !== undefined) this.hideAvailable = savedState.hideAvailable;
    if (savedState.backgroundColor) this.backgroundColor = savedState.backgroundColor;

    // Restore custom dimensions if present, applying the same minimum clamp of 200
    if (savedState.customWidth !== null && savedState.customWidth !== undefined) {
      this.customWidth = Math.max(200, Number(savedState.customWidth));
    } else {
      this.customWidth = null;
    }
    if (savedState.customHeight !== null && savedState.customHeight !== undefined) {
      this.customHeight = Math.max(200, Number(savedState.customHeight));
    } else {
      this.customHeight = null;
    }
    if (savedState.stackGap !== null && savedState.stackGap !== undefined) {
      this.stackGap = Math.max(0, Math.min(500, Math.round(Number(savedState.stackGap))));
    } else {
      this.stackGap = 0;
    }

    for (const saved of savedWindows) {
      try {
        const hwndNum = Number(saved.hwnd);

        if (!api.IsWindow(hwndNum)) {
          console.log(`Window ${saved.title} (${hwndNum}) no longer exists, skipping`);
          continue;
        }

        if (!api.IsWindowVisible(hwndNum)) {
          api.ShowWindow(hwndNum, SW_RESTORE);
          if (!api.IsWindowVisible(hwndNum)) {
            console.log(`Window ${saved.title} (${hwndNum}) not visible, skipping`);
            continue;
          }
        }

        const title = this._getWindowTitle(hwndNum) || saved.title;

        this.managedWindows.push({
          hwnd: hwndNum,
          title: title,
          customTitle: saved.customTitle || null,
          processId: saved.processId || 0,
          originalRect: saved.originalRect || { left: 100, top: 100, right: 900, bottom: 700 }
        });
      } catch (e) {
        console.error(`Failed to restore window ${saved.title}:`, e);
      }
    }

    // Attempt to select the topmost window as active if available to prevent no active windows.
    if (this.managedWindows.length > 0) {
      this.activeHwnd = this.managedWindows[0].hwnd;
    }
  }

  setStackName(name) {
    this.stackName = name || 'Managed Stack';
  }

  setHideAvailable(hide) {
    this.hideAvailable = !!hide;
  }
}

module.exports = { WindowManager, CONTROLLER_WIDTH, HEADER_HEIGHT };
