'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { WindowManager, CONTROLLER_WIDTH } = require('./window-manager');
const { Persistence } = require('./persistence');
const { ForegroundMonitor } = require('./foreground-monitor');
const { InstanceRegistry } = require('./instance-registry');

let mainWindow = null;
let windowManager = null;
let persistence = null;
let foregroundMonitor = null;
let instanceRegistry = null;
let cleanupTimer = null;
let saveTimer = null;
let _layoutDebounceTimer = null;
let _saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 2000; // 2 seconds

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
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('resize', () => {
    doLayout();
    if (saveTimer) {
      debouncedSave();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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
      backgroundColor: windowManager.getBackgroundColor()
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

function syncMonitor() {
  if (foregroundMonitor) {
    foregroundMonitor.updateManagedSet(windowManager.getManagedHwnds());
  }
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
        backgroundColor: windowManager.getBackgroundColor()
      };
    } catch (e) {
      console.error('get-managed-windows error:', e);
      return { windows: [], activeHwnd: 0 };
    }
  });

  ipcMain.handle('add-window', async (event, hwnd, title) => {
    try {
      windowManager.addWindow(hwnd, title);
      syncMonitor();
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
      windowManager.removeWindow(hwnd);
      syncMonitor();
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
      const changed = windowManager.promoteToActive(hwnd, true);
      if (changed) {
        syncMonitor();
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
    windowManager.setStackName(name);
    persistence.save(windowManager.getState());
    return { success: true };
  });

  ipcMain.handle('toggle-available-visibility', async (event, isHidden) => {
    windowManager.setHideAvailable(isHidden);
    persistence.save(windowManager.getState());
    return { success: true };
  });

  ipcMain.handle('resize-app', async (event, width, height) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentBounds = mainWindow.getBounds();
      mainWindow.setBounds({
        x: currentBounds.x,
        y: currentBounds.y,
        width: width || currentBounds.width,
        height: height || currentBounds.height
      });
    }
    return { success: true };
  });

  ipcMain.handle('set-custom-dimensions', async (event, width, height) => {
    try {
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
    return windowManager.getCustomDimensions();
  });

  ipcMain.handle('set-background-color', async (event, color) => {
    try {
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
    return windowManager.getBackgroundColor();
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
  syncMonitor();

  // Register IPC handlers
  registerIPC();

  // Cleanup timer: remove dead windows every 2 seconds
  cleanupTimer = setInterval(() => {
    const changed = windowManager.removeDeadWindows();
    if (changed) {
      syncMonitor();
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
  if (foregroundMonitor) foregroundMonitor.stop();
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (saveTimer) clearInterval(saveTimer);
  if (_layoutDebounceTimer) clearTimeout(_layoutDebounceTimer);
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }

  if (windowManager) {
    persistence.saveSync(windowManager.getState());
    windowManager.restoreAll();
  }

  persistence.cleanupFile();
  instanceRegistry.unregister();

  app.quit();
});

app.on('before-quit', () => {
  if (foregroundMonitor) foregroundMonitor.stop();
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }

  if (windowManager) {
    persistence.saveSync(windowManager.getState());
    windowManager.restoreAll();
  }

  persistence.cleanupFile();
  instanceRegistry.unregister();
});
