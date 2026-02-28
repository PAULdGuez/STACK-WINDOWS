'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { WindowManager, CONTROLLER_WIDTH } = require('./window-manager');
const { Persistence } = require('./persistence');
const { ForegroundMonitor } = require('./foreground-monitor');
const { ResizeMonitor } = require('./resize-monitor');
const { InstanceRegistry } = require('./instance-registry');
const { api } = require('./win32');

function validateHwnd(hwnd) {
  const n = Number(hwnd);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid hwnd: ' + hwnd);
  return n;
}

let mainWindow = null;
let windowManager = null;
let persistence = null;
let foregroundMonitor = null;
let resizeMonitor = null;
let instanceRegistry = null;
let cleanupTimer = null;
let saveTimer = null;
let _layoutDebounceTimer = null;
let _saveDebounceTimer = null;
let _focusDebounceTimer = null;
let _cleanedUp = false;
const SAVE_DEBOUNCE_MS = 2000; // 2 seconds

function performCleanup() {
  if (_cleanedUp) return;
  _cleanedUp = true;

  if (foregroundMonitor) foregroundMonitor.stop();
  if (resizeMonitor) resizeMonitor.stop();
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (saveTimer) clearInterval(saveTimer);
  if (_layoutDebounceTimer) clearTimeout(_layoutDebounceTimer);
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }
  if (_focusDebounceTimer) {
    clearTimeout(_focusDebounceTimer);
    _focusDebounceTimer = null;
  }

  if (windowManager) {
    persistence.saveSync(windowManager.getState());
    windowManager.restoreAll();
  }

  persistence.cleanupFile();
  instanceRegistry.unregister();
}

function debouncedSave() {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(() => {
    _saveDebounceTimer = null;
    if (windowManager) {
      persistence.save(windowManager.getState());
    }
  }, SAVE_DEBOUNCE_MS);
}

function getWorkArea(point) {
  const display = point
    ? screen.getDisplayNearestPoint(point)
    : screen.getPrimaryDisplay();
  return display.workArea;
}

function createWindow() {
  const workArea = getWorkArea();

  mainWindow = new BrowserWindow({
    width: CONTROLLER_WIDTH,
    height: Math.floor(workArea.height * 0.9),
    x: workArea.x,
    y: workArea.y,
    resizable: true,
    minWidth: 250,
    minHeight: 120,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    frame: true,
    title: 'Stack Windows',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('resize', () => {
    doLayout();
    if (windowManager) {
      debouncedSave();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('focus', () => {
    if (!windowManager) return;
    if (_focusDebounceTimer) clearTimeout(_focusDebounceTimer);
    _focusDebounceTimer = setTimeout(() => {
      _focusDebounceTimer = null;
      const activeHwnd = windowManager.getActiveHwnd();
      if (activeHwnd > 0) {
        try {
          if (api.IsWindow(activeHwnd) !== 0) {
            api.SetForegroundWindow(activeHwnd);
          }
        } catch (e) {
          // Silently ignore — window may have been closed
        }
      }
    }, 200);
  });
}

function sendStateUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const dims = windowManager.getCustomDimensions();
    mainWindow.webContents.send('state-update', {
      managed: windowManager.getManagedWindows(),
      activeHwnd: windowManager.getActiveHwnd(),
      stackName: windowManager.stackName,
      hideAvailable: windowManager.hideAvailable,
      customWidth: dims.customWidth,
      customHeight: dims.customHeight,
      backgroundColor: windowManager.getBackgroundColor(),
      stackGap: windowManager.getStackGap(),
      topOffset: windowManager.getTopOffset()
    });
  }
}

function doLayout() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const workArea = display.workArea;

  windowManager.layoutStack({
    x: bounds.x,
    y: workArea.y,
    width: bounds.width,
    height: workArea.height,
    displayRightEdge: workArea.x + workArea.width
  });
}

function doLayoutDebounced() {
  if (_layoutDebounceTimer) clearTimeout(_layoutDebounceTimer);
  _layoutDebounceTimer = setTimeout(() => { doLayout(); }, 16);
}

function syncMonitors() {
  const hwnds = windowManager.getManagedHwnds();
  foregroundMonitor.updateManagedSet(hwnds);
  resizeMonitor.updateManagedSet(hwnds);
}

/**
 * Called by ForegroundMonitor when a managed window gains OS focus.
 * This is the primary activation path. A secondary path exists via the
 * 'activate-window' IPC handler for explicit UI-driven activation.
 */
function onManagedWindowFocused(hwnd) {
  const changed = windowManager.promoteToActive(hwnd);
  if (changed) {
    doLayoutDebounced();
    sendStateUpdate();
    debouncedSave();
  }
}

function onManagedWindowResized(hwnd) {
  if (!windowManager || !mainWindow) return;
  try {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const success = api.GetWindowRect(hwnd, rect);
    if (!success) return;

    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const workArea = display.workArea;
    const panelRightEdge = bounds.x + bounds.width;

    // 1. Compute new gap (horizontal position)
    const newGap = rect.left - panelRightEdge;
    if (newGap >= 0) {
      windowManager.setStackGap(newGap);
    }

    // 2. Compute new topOffset (vertical position)
    const isActive = hwnd === windowManager.getActiveHwnd();
    const inactiveCount = windowManager.managedWindows.length - 1;
    let newTopOffset;
    if (isActive && inactiveCount > 0) {
      newTopOffset = rect.top - workArea.y - (inactiveCount * 40);
    } else {
      newTopOffset = rect.top - workArea.y;
    }
    if (newTopOffset >= 0 && newTopOffset <= 500) {
      windowManager.setTopOffset(newTopOffset);
    }

    // 3. Compute new dimensions (width and height)
    const newWidth = rect.right - rect.left;
    const effectiveTopOffset = windowManager.topOffset || 0;
    const topOfStack = workArea.y + effectiveTopOffset;
    const newHeight = rect.bottom - topOfStack;

    if (newWidth >= 200) {
      windowManager.setCustomDimensions(newWidth, newHeight >= 200 ? newHeight : null);
    }

    doLayout();
    sendStateUpdate();
    debouncedSave();
  } catch (e) {
    console.error('onManagedWindowResized error:', e);
  }
}

// Register IPC handlers.
// Activation is primarily driven by Win32 focus detection (ForegroundMonitor),
// but an activate-window handler also exists for explicit UI-driven activation.
function registerIPC() {
  ipcMain.handle('get-available-windows', async () => {
    try {
      const excludeHwnds = instanceRegistry.getOtherInstancesHwnds();
      return windowManager.getAvailableWindows(excludeHwnds);
    } catch (e) {
      console.error('get-available-windows error:', e);
      return [];
    }
  });

  ipcMain.handle('get-managed-windows', async () => {
    try {
      return {
        windows: windowManager.getManagedWindows(),
        activeHwnd: windowManager.getActiveHwnd(),
        stackName: windowManager.stackName,
        hideAvailable: windowManager.hideAvailable,
        ...windowManager.getCustomDimensions(),
        backgroundColor: windowManager.getBackgroundColor(),
        stackGap: windowManager.getStackGap(),
        topOffset: windowManager.getTopOffset()
      };
    } catch (e) {
      console.error('get-managed-windows error:', e);
      return { windows: [], activeHwnd: 0 };
    }
  });

  ipcMain.handle('add-window', async (event, hwnd, title) => {
    try {
      hwnd = validateHwnd(hwnd);
      if (typeof title !== 'string') throw new Error('Invalid title: must be a string');
      title = title.slice(0, 500);
      windowManager.addWindow(hwnd, title);
      syncMonitors();
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      instanceRegistry.updateManagedHwnds(windowManager.getManagedHwnds());
      return { success: true };
    } catch (e) {
      console.error('add-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('remove-window', async (event, hwnd) => {
    try {
      hwnd = validateHwnd(hwnd);
      windowManager.removeWindow(hwnd);
      syncMonitors();
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      instanceRegistry.updateManagedHwnds(windowManager.getManagedHwnds());
      return { success: true };
    } catch (e) {
      console.error('remove-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('activate-window', async (event, hwnd) => {
    try {
      hwnd = validateHwnd(hwnd);
      const changed = windowManager.promoteToActive(hwnd, true);
      if (changed) {
        syncMonitors();
        doLayout();
        sendStateUpdate();
        persistence.save(windowManager.getState());
      }
      return { success: true };
    } catch (e) {
      console.error('activate-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('rename-window', async (event, hwnd, customTitle) => {
    try {
      hwnd = validateHwnd(hwnd);
      if (customTitle !== null && typeof customTitle !== 'string') throw new Error('Invalid customTitle: must be string or null');
      if (typeof customTitle === 'string') customTitle = customTitle.slice(0, 200);
      const found = windowManager.renameWindow(hwnd, customTitle);
      if (found) {
        sendStateUpdate();
        persistence.save(windowManager.getState());
      }
      return { success: found };
    } catch (e) {
      console.error('rename-window error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('refresh', async () => {
    try {
      const excludeHwnds = instanceRegistry.getOtherInstancesHwnds();
      return windowManager.getAvailableWindows(excludeHwnds);
    } catch (e) {
      console.error('refresh error:', e);
      return [];
    }
  });

  ipcMain.handle('update-stack-name', async (event, name) => {
    try {
      if (typeof name !== 'string' && name !== null && name !== undefined) {
        throw new Error('Invalid name: must be a string, null, or undefined');
      }
      if (typeof name === 'string') name = name.slice(0, 200);
      windowManager.setStackName(name);
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('update-stack-name error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('toggle-available-visibility', async (event, isHidden) => {
    try {
      windowManager.setHideAvailable(isHidden);
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('toggle-available-visibility error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('resize-app', async (event, width, height) => {
    try {
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) throw new Error('Invalid width');
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) throw new Error('Invalid height');
      if (mainWindow && !mainWindow.isDestroyed()) {
        const currentBounds = mainWindow.getBounds();
        mainWindow.setBounds({ x: currentBounds.x, y: currentBounds.y, width, height });
      }
      return { success: true };
    } catch (e) {
      console.error('resize-app error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('set-custom-dimensions', async (event, width, height) => {
    try {
      if (width !== null && (typeof width !== 'number' || !Number.isFinite(width) || width < 200)) throw new Error('Invalid width: must be null or a number >= 200');
      if (height !== null && (typeof height !== 'number' || !Number.isFinite(height) || height < 200)) throw new Error('Invalid height: must be null or a number >= 200');
      windowManager.setCustomDimensions(width, height);
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('set-custom-dimensions error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-custom-dimensions', async () => {
    try {
      return windowManager.getCustomDimensions();
    } catch (e) {
      console.error('get-custom-dimensions error:', e);
      return { customWidth: null, customHeight: null };
    }
  });

  ipcMain.handle('set-background-color', async (event, color) => {
    try {
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Invalid color: must match #rrggbb format');
      windowManager.setBackgroundColor(color);
      sendStateUpdate();
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('set-background-color error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-background-color', async () => {
    try {
      return windowManager.getBackgroundColor();
    } catch (e) {
      console.error('get-background-color error:', e);
      return '#000000';
    }
  });

  ipcMain.handle('set-stack-gap', async (event, gap) => {
    try {
      if (gap !== null && (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0)) {
        throw new Error('Invalid gap: must be null or a non-negative number');
      }
      windowManager.setStackGap(gap);
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('set-stack-gap error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('set-top-offset', async (event, offset) => {
    try {
      if (offset !== null && (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0)) {
        throw new Error('Invalid offset: must be null or a non-negative number');
      }
      windowManager.setTopOffset(offset);
      doLayout();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      return { success: true };
    } catch (e) {
      console.error('set-top-offset error:', e);
      return { success: false, error: e.message };
    }
  });
}

app.whenReady().then(() => {
  // 1. Initialize instance registry
  instanceRegistry = new InstanceRegistry();
  const instanceId = instanceRegistry.init();

  // Clean up orphaned persistence files from crashed instances
  const userDataPath = app.getPath('userData');
  const fs = require('fs');
  try {
    const files = fs.readdirSync(userDataPath);
    const registry = instanceRegistry.getRegistry();
    const liveIds = new Set(Object.keys(registry.instances || {}));

    for (const file of files) {
      const match = file.match(/^window-group-(.+)\.json$/);
      if (match && !liveIds.has(match[1])) {
        fs.unlinkSync(path.join(userDataPath, file));
        console.log('Cleaned up orphaned persistence file:', file);
      }
    }
  } catch (e) {
    console.error('Failed to clean orphaned files:', e);
  }

  // 2. Initialize persistence with instance-specific file
  persistence = new Persistence();
  persistence.init(instanceId);

  // 3. Initialize window manager — starts EMPTY, no loadState()
  windowManager = new WindowManager();

  // NOTE: We intentionally do NOT call persistence.load() or windowManager.loadState().
  // Each new instance starts with an empty managed stack.
  // The user adds windows manually to this instance's group.

  // Create the controller window
  createWindow();

  // Set window title with short instance ID for visual distinction between instances
  const shortId = instanceId.substring(0, 8);
  mainWindow.setTitle('Stack Windows [' + shortId + ']');

  // Initialize foreground monitor — detects when user clicks/focuses a managed window
  foregroundMonitor = new ForegroundMonitor();
  foregroundMonitor.start(onManagedWindowFocused);
  resizeMonitor = new ResizeMonitor();
  try { resizeMonitor.start(onManagedWindowResized); } catch (e) { console.error("[ResizeMonitor] Failed to start:", e); }
  syncMonitors();

  // Register IPC handlers
  registerIPC();

  // Cleanup timer: remove dead windows every 2 seconds
  cleanupTimer = setInterval(() => {
    const changed = windowManager.removeDeadWindows();
    if (changed) {
      syncMonitors();
      doLayoutDebounced();
      sendStateUpdate();
      persistence.save(windowManager.getState());
      instanceRegistry.updateManagedHwnds(windowManager.getManagedHwnds());
    }
  }, 2000);

  // Auto-save timer: save state every 10 seconds
  saveTimer = setInterval(() => {
    if (windowManager.managedWindows.length > 0) {
      persistence.save(windowManager.getState());
    }
  }, 10000);
});

app.on('window-all-closed', () => {
  performCleanup();
  app.quit();
});

app.on('before-quit', () => {
  performCleanup();
});
