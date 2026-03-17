import { vi } from 'vitest';

// Mock 'electron' module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadFile: vi.fn(),
    on: vi.fn(),
    webContents: { send: vi.fn(), on: vi.fn() },
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 300, height: 800 })),
    setBounds: vi.fn(),
    setTitle: vi.fn(),
    isDestroyed: vi.fn(() => false),
  })),
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    })),
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    })),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

// Mock 'koffi' module
vi.mock('koffi', () => {
  const mockFunc = vi.fn(() => vi.fn());
  return {
    default: {
      load: vi.fn(() => ({ func: mockFunc })),
      register: vi.fn(() => ({})),
      unregister: vi.fn(),
      proto: vi.fn(() => 'proto'),
      struct: vi.fn(() => 'struct'),
      alias: vi.fn(() => 'alias'),
      pointer: vi.fn((x) => x),
      address: vi.fn(() => 0),
    },
    load: vi.fn(() => ({ func: mockFunc })),
    register: vi.fn(() => ({})),
    unregister: vi.fn(),
    proto: vi.fn(() => 'proto'),
    struct: vi.fn(() => 'struct'),
    alias: vi.fn(() => 'alias'),
    pointer: vi.fn((x) => x),
    address: vi.fn(() => 0),
  };
});
