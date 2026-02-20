'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Get list of available (non-managed) windows
  getAvailableWindows: () => ipcRenderer.invoke('get-available-windows'),

  // Get list of currently managed windows + active hwnd
  getManagedWindows: () => ipcRenderer.invoke('get-managed-windows'),

  // Add a window to the managed group
  addWindow: (hwnd, title) => ipcRenderer.invoke('add-window', hwnd, title),

  // Remove a window from the managed group
  removeWindow: (hwnd) => ipcRenderer.invoke('remove-window', hwnd),

  // Activate an already managed window
  activateWindow: (hwnd) => ipcRenderer.invoke('activate-window', hwnd),

  // Refresh available windows list
  refresh: () => ipcRenderer.invoke('refresh'),

  // Listen for state updates pushed from main process (foreground monitor events)
  onStateUpdate: (callback) => {
    ipcRenderer.on('state-update', (event, data) => callback(data));
  }
});
