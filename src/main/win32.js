'use strict';

const koffi = require('koffi');

// Load user32.dll
const user32 = koffi.load('user32.dll');

// Register type aliases with koffi so they work in inline signatures
const HWND = koffi.alias('HWND', 'size_t');
const BOOL = koffi.alias('BOOL', 'int');

// RECT struct
const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long'
});

// Callback prototype for EnumWindows
const EnumWindowsProc = koffi.proto('int EnumWindowsProc(intptr hwnd, intptr lParam)');

// Callback prototype for SetWinEventHook
const WinEventProc = koffi.proto('void WinEventProc(intptr hWinEventHook, uint32_t event, intptr hwnd, int32_t idObject, int32_t idChild, uint32_t idEventThread, uint32_t dwmsEventTime)');

// Win32 API function declarations
const api = {
  EnumWindows: user32.func('BOOL EnumWindows(intptr lpEnumFunc, intptr lParam)'),
  GetWindowTextW: user32.func('int GetWindowTextW(size_t hWnd, _Out_ str16 lpString, int nMaxCount)'),
  GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(size_t hWnd)'),
  IsWindowVisible: user32.func('BOOL IsWindowVisible(size_t hWnd)'),
  IsWindow: user32.func('BOOL IsWindow(size_t hWnd)'),
  IsIconic: user32.func('BOOL IsIconic(size_t hWnd)'),
  IsZoomed: user32.func('BOOL IsZoomed(size_t hWnd)'),
  GetWindowRect: user32.func('BOOL GetWindowRect(size_t hWnd, _Out_ RECT *lpRect)'),
  SetWindowPos: user32.func('BOOL SetWindowPos(size_t hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'),
  BeginDeferWindowPos: user32.func('intptr BeginDeferWindowPos(int nNumWindows)'),
  DeferWindowPos: user32.func('intptr DeferWindowPos(intptr hWinPosInfo, size_t hWnd, intptr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags)'),
  EndDeferWindowPos: user32.func('BOOL EndDeferWindowPos(intptr hWinPosInfo)'),
  ShowWindow: user32.func('BOOL ShowWindow(size_t hWnd, int nCmdShow)'),
  SetForegroundWindow: user32.func('BOOL SetForegroundWindow(size_t hWnd)'),
  GetForegroundWindow: user32.func('size_t GetForegroundWindow()'),
  GetWindowLongPtrW: user32.func('intptr GetWindowLongPtrW(size_t hWnd, int nIndex)'),
  GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(size_t hWnd, _Out_ uint32_t *lpdwProcessId)'),
  SetWinEventHook: user32.func('intptr SetWinEventHook(uint32_t eventMin, uint32_t eventMax, intptr hmodWinEventProc, intptr lpfnWinEventProc, uint32_t idProcess, uint32_t idThread, uint32_t dwFlags)'),
  UnhookWinEvent: user32.func('BOOL UnhookWinEvent(intptr hWinEventHook)')
};

// Constants
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

const HWND_TOP = 0;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;

const SW_RESTORE = 9;
const SW_SHOW = 5;

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;

const EVENT_SYSTEM_MOVESIZEEND = 0x000B;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const OBJID_WINDOW = 0;

module.exports = {
  koffi,
  api,
  EnumWindowsProc,
  WinEventProc,
  RECT,
  SWP_NOSIZE,
  SWP_NOMOVE,
  SWP_NOZORDER,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
  HWND_TOP,
  HWND_TOPMOST,
  HWND_NOTOPMOST,
  SW_RESTORE,
  SW_SHOW,
  GWL_EXSTYLE,
  WS_EX_TOOLWINDOW,
  WS_EX_APPWINDOW,
  EVENT_SYSTEM_MOVESIZEEND,
  WINEVENT_OUTOFCONTEXT,
  OBJID_WINDOW
};
