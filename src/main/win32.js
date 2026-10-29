'use strict';

/**
 * The few Win32 calls the app viewer (appview.js) needs to keep another
 * program's windows under the pane and pass your mouse and keys to them:
 * the process tree, its windows, where they are, moving them, and posting
 * input. Through koffi (no compiler needed). Windows only: elsewhere
 * `available` is false and the viewer says so.
 */

let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const gdi32 = koffi.load('gdi32.dll');

    const RECT = koffi.struct('XRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const POINT = koffi.struct('XPOINT', { x: 'int32', y: 'int32' });
    const PROCESSENTRY32W = koffi.struct('XPROCESSENTRY32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('char16_t', 260, 'String'),
    });
    const GUITHREADINFO = koffi.struct('XGUITHREADINFO', {
      cbSize: 'uint32',
      flags: 'uint32',
      hwndActive: 'intptr_t',
      hwndFocus: 'intptr_t',
      hwndCapture: 'intptr_t',
      hwndMenuOwner: 'intptr_t',
      hwndMoveSize: 'intptr_t',
      hwndCaret: 'intptr_t',
      rcCaret: RECT,
    });
    const BITMAPINFOHEADER = koffi.struct('XBITMAPINFOHEADER', {
      biSize: 'uint32',
      biWidth: 'int32',
      biHeight: 'int32',
      biPlanes: 'uint16',
      biBitCount: 'uint16',
      biCompression: 'uint32',
      biSizeImage: 'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32',
      biClrImportant: 'uint32',
    });
    const EnumProc = koffi.proto('__stdcall', 'XEnumProc', 'bool', ['intptr_t', 'intptr_t']);

    api = {
      koffi,
      RECT,
      POINT,
      PROCESSENTRY32W,
      GUITHREADINFO,
      EnumWindows: user32.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(EnumProc), 'intptr_t']),
      EnumChildWindows: user32.func('__stdcall', 'EnumChildWindows', 'bool', ['intptr_t', koffi.pointer(EnumProc), 'intptr_t']),
      GetWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr_t', koffi.out(koffi.pointer('uint32'))]),
      IsWindow: user32.func('__stdcall', 'IsWindow', 'bool', ['intptr_t']),
      IsWindowVisible: user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t']),
      IsIconic: user32.func('__stdcall', 'IsIconic', 'bool', ['intptr_t']),
      GetWindowTextW: user32.func('__stdcall', 'GetWindowTextW', 'int', ['intptr_t', koffi.out(koffi.pointer('char16_t')), 'int']),
      GetClassNameW: user32.func('__stdcall', 'GetClassNameW', 'int', ['intptr_t', koffi.out(koffi.pointer('char16_t')), 'int']),
      GetWindowRect: user32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr_t', koffi.out(koffi.pointer(RECT))]),
      GetClientRect: user32.func('__stdcall', 'GetClientRect', 'bool', ['intptr_t', koffi.out(koffi.pointer(RECT))]),
      ClientToScreen: user32.func('__stdcall', 'ClientToScreen', 'bool', ['intptr_t', koffi.inout(koffi.pointer(POINT))]),
      ScreenToClient: user32.func('__stdcall', 'ScreenToClient', 'bool', ['intptr_t', koffi.inout(koffi.pointer(POINT))]),
      GetWindow: user32.func('__stdcall', 'GetWindow', 'intptr_t', ['intptr_t', 'uint32']),
      GetAncestor: user32.func('__stdcall', 'GetAncestor', 'intptr_t', ['intptr_t', 'uint32']),
      GetWindowLongPtrW: user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int']),
      SetWindowLongPtrW: user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int', 'intptr_t']),
      SetWindowPos: user32.func('__stdcall', 'SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32']),
      ShowWindow: user32.func('__stdcall', 'ShowWindow', 'bool', ['intptr_t', 'int']),
      SetForegroundWindow: user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr_t']),
      PostMessageW: user32.func('__stdcall', 'PostMessageW', 'bool', ['intptr_t', 'uint32', 'uintptr_t', 'intptr_t']),
      SendMessageW: user32.func('__stdcall', 'SendMessageW', 'intptr_t', ['intptr_t', 'uint32', 'uintptr_t', 'intptr_t']),
      ChildWindowFromPointEx: user32.func('__stdcall', 'ChildWindowFromPointEx', 'intptr_t', ['intptr_t', POINT, 'uint32']),
      MapVirtualKeyW: user32.func('__stdcall', 'MapVirtualKeyW', 'uint32', ['uint32', 'uint32']),
      GetDpiForWindow: user32.func('__stdcall', 'GetDpiForWindow', 'uint32', ['intptr_t']),
      GetGUIThreadInfo: user32.func('__stdcall', 'GetGUIThreadInfo', 'bool', ['uint32', koffi.inout(koffi.pointer(GUITHREADINFO))]),
      GetCursorPos: user32.func('__stdcall', 'GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]),
      WindowFromPoint: user32.func('__stdcall', 'WindowFromPoint', 'intptr_t', [POINT]),
      // Pictures of a window (screenshots for agents), and the words in a dialog.
      GetDC: user32.func('__stdcall', 'GetDC', 'intptr_t', ['intptr_t']),
      ReleaseDC: user32.func('__stdcall', 'ReleaseDC', 'int', ['intptr_t', 'intptr_t']),
      PrintWindow: user32.func('__stdcall', 'PrintWindow', 'bool', ['intptr_t', 'intptr_t', 'uint32']),
      CreateCompatibleDC: gdi32.func('__stdcall', 'CreateCompatibleDC', 'intptr_t', ['intptr_t']),
      CreateCompatibleBitmap: gdi32.func('__stdcall', 'CreateCompatibleBitmap', 'intptr_t', ['intptr_t', 'int', 'int']),
      SelectObject: gdi32.func('__stdcall', 'SelectObject', 'intptr_t', ['intptr_t', 'intptr_t']),
      DeleteObject: gdi32.func('__stdcall', 'DeleteObject', 'bool', ['intptr_t']),
      DeleteDC: gdi32.func('__stdcall', 'DeleteDC', 'bool', ['intptr_t']),
      GetDIBits: gdi32.func('__stdcall', 'GetDIBits', 'int', ['intptr_t', 'intptr_t', 'uint32', 'uint32', 'void *', koffi.inout(koffi.pointer(BITMAPINFOHEADER)), 'uint32']),
      GetTextTimeout: user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t', ['intptr_t', 'uint32', 'uintptr_t', 'void *', 'uint32', 'uint32', koffi.out(koffi.pointer('uintptr_t'))]),
      AttachThreadInput: user32.func('__stdcall', 'AttachThreadInput', 'bool', ['uint32', 'uint32', 'bool']),
      GetKeyboardState: user32.func('__stdcall', 'GetKeyboardState', 'bool', [koffi.out(koffi.pointer('uint8'))]),
      SetKeyboardState: user32.func('__stdcall', 'SetKeyboardState', 'bool', ['uint8 *']),
      SendMessageTimeoutW: user32.func('__stdcall', 'SendMessageTimeoutW', 'intptr_t', ['intptr_t', 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', koffi.out(koffi.pointer('uintptr_t'))]),
      GetCurrentThreadId: kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []),
      PostThreadMessageW: user32.func('__stdcall', 'PostThreadMessageW', 'bool', ['uint32', 'uint32', 'uintptr_t', 'intptr_t']),
      DwmGetWindowAttribute: dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32', ['intptr_t', 'uint32', koffi.out(koffi.pointer(RECT)), 'uint32']),
      CreateToolhelp32Snapshot: kernel32.func('__stdcall', 'CreateToolhelp32Snapshot', 'intptr_t', ['uint32', 'uint32']),
      Process32FirstW: kernel32.func('__stdcall', 'Process32FirstW', 'bool', ['intptr_t', koffi.inout(koffi.pointer(PROCESSENTRY32W))]),
      Process32NextW: kernel32.func('__stdcall', 'Process32NextW', 'bool', ['intptr_t', koffi.inout(koffi.pointer(PROCESSENTRY32W))]),
      CloseHandle: kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t']),
      OpenProcess: kernel32.func('__stdcall', 'OpenProcess', 'intptr_t', ['uint32', 'bool', 'uint32']),
      GetProcessTimes: kernel32.func('__stdcall', 'GetProcessTimes', 'bool', [
        'intptr_t',
        koffi.out(koffi.pointer('uint64')),
        koffi.out(koffi.pointer('uint64')),
        koffi.out(koffi.pointer('uint64')),
        koffi.out(koffi.pointer('uint64')),
      ]),
    };
  } catch (error) {
    console.log('[appview] win32 unavailable:', error.message);
    api = false;
  }
  return api;
}

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_CHILD = 0x40000000;
const GW_OWNER = 4;
const GA_ROOT = 2;
const HWND_BOTTOM = 1;
const HWND_TOP = 0;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;
const SWP_FRAMECHANGED = 0x20;
const SWP_NOOWNERZORDER = 0x200;
const SWP_ASYNCWINDOWPOS = 0x4000;
const CWP_SKIPINVISIBLE = 0x1;
const CWP_SKIPTRANSPARENT = 0x4;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const TH32CS_SNAPPROCESS = 0x2;

/** Every process and its parent: Map<pid, ppid>. */
function processParents() {
  const w = load();
  const parents = new Map();
  if (!w) return parents;
  const snap = w.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap || snap === -1) return parents;
  try {
    const entry = { dwSize: w.koffi.sizeof(w.PROCESSENTRY32W) };
    let ok = w.Process32FirstW(snap, entry);
    while (ok) {
      parents.set(entry.th32ProcessID, entry.th32ParentProcessID);
      ok = w.Process32NextW(snap, entry);
    }
  } finally {
    w.CloseHandle(snap);
  }
  return parents;
}

/** When a process started (FILETIME ticks), or 0 if it can't be asked. */
function startedAt(pid) {
  const w = load();
  if (!w) return 0;
  const handle = w.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
  if (!handle) return 0;
  try {
    const created = [0n];
    return w.GetProcessTimes(handle, created, [0n], [0n], [0n]) ? Number(created[0]) : 0;
  } finally {
    w.CloseHandle(handle);
  }
}

/**
 * A process and everything it started (and they started). Never this app
 * itself: Windows reuses the number of a process that has ended, so a
 * parent link is only believed when the child started after the parent.
 */
function processTree(rootPid) {
  const parents = processParents();
  const candidates = descendants(rootPid, parents);
  const born = new Map([...candidates].map((pid) => [pid, startedAt(pid)]));
  return descendants(rootPid, parents, { born, exclude: process.pid });
}

/**
 * Pure: the pids under root (root included), from a Map<pid, ppid>. With
 * `born` (pid → start time), a child that started before its "parent" is
 * a stranger whose parent's number was reused; `exclude` is never included.
 */
function descendants(rootPid, parents, { born = null, exclude = 0 } = {}) {
  const tree = new Set([rootPid]);
  const believed = (pid, ppid) => {
    if (!born) return true;
    const child = born.get(pid);
    const parent = born.get(ppid);
    return Boolean(child && parent && child >= parent);
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (!tree.has(pid) && tree.has(ppid) && pid !== ppid && pid !== exclude && believed(pid, ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
}

function text(fn, hwnd) {
  const w = load();
  const buffer = Buffer.alloc(512 * 2);
  const n = fn(hwnd, buffer, 512);
  return n > 0 ? buffer.toString('utf16le', 0, n * 2) : '';
}

/** Screen rectangles of a window: its whole frame, what DWM draws of it, its client area. */
function bounds(hwnd) {
  const w = load();
  if (!w || !w.IsWindow(hwnd)) return null;
  const outer = {};
  w.GetWindowRect(hwnd, outer);
  const frame = {};
  if (w.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, frame, 16) !== 0) Object.assign(frame, outer);
  const size = {};
  w.GetClientRect(hwnd, size);
  const origin = { x: 0, y: 0 };
  w.ClientToScreen(hwnd, origin);
  return {
    outer: { x: outer.left, y: outer.top, width: outer.right - outer.left, height: outer.bottom - outer.top },
    frame: { x: frame.left, y: frame.top, width: frame.right - frame.left, height: frame.bottom - frame.top },
    client: { x: origin.x, y: origin.y, width: size.right, height: size.bottom },
    dpi: w.GetDpiForWindow(hwnd) || 96,
  };
}

/** The visible top-level windows of these processes, in z-order (topmost first). */
function windowsOf(pids) {
  const w = load();
  if (!w) return [];
  const found = [];
  const pidOut = [0];
  w.EnumWindows((hwnd) => {
    w.GetWindowThreadProcessId(hwnd, pidOut);
    if (!pids.has(pidOut[0]) || !w.IsWindowVisible(hwnd)) return true;
    const exStyle = Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    const style = Number(w.GetWindowLongPtrW(hwnd, GWL_STYLE));
    const b = bounds(hwnd);
    if (!b || b.outer.width < 2 || b.outer.height < 2) return true;
    found.push({
      hwnd,
      pid: pidOut[0],
      title: text(w.GetWindowTextW, hwnd),
      className: text(w.GetClassNameW, hwnd),
      owner: w.GetWindow(hwnd, GW_OWNER),
      tool: Boolean(exStyle & WS_EX_TOOLWINDOW),
      noActivate: Boolean(exStyle & WS_EX_NOACTIVATE),
      style,
      exStyle,
      iconic: w.IsIconic(hwnd),
      ...b,
    });
    return true;
  }, 0);
  return found;
}

/** Every visible top-level window's place: [{ hwnd, x, y, width, height }]. */
function windowRects() {
  const w = load();
  if (!w) return [];
  const rects = [];
  const rect = {};
  w.EnumWindows((hwnd) => {
    if (w.IsWindowVisible(hwnd) && w.GetWindowRect(hwnd, rect) && rect.right > rect.left && rect.bottom > rect.top) {
      rects.push({ hwnd, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top });
    }
    return true;
  }, 0);
  return rects;
}

/** Move and size a window (screen pixels), under (`after`) another or at the bottom. */
function place(hwnd, { x, y, width, height }, { after = HWND_BOTTOM, size = true } = {}) {
  const w = load();
  if (!w) return false;
  let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS;
  if (!size) flags |= SWP_NOSIZE;
  return w.SetWindowPos(hwnd, after, Math.round(x), Math.round(y), Math.round(width || 0), Math.round(height || 0), flags);
}

/** Bring a window to the front (popping it out, or a fullscreen view). */
function raise(hwnd) {
  const w = load();
  if (!w) return false;
  w.ShowWindow(hwnd, 9 /* SW_RESTORE */);
  w.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
  return w.SetForegroundWindow(hwnd);
}

/** Kept off the taskbar and Alt+Tab while it lives in the pane (or back on them). */
function setToolWindow(hwnd, on) {
  const w = load();
  if (!w) return;
  const ex = Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const next = on ? (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW : ex & ~WS_EX_TOOLWINDOW;
  if (next === ex) return;
  // The taskbar only notices while the window is hidden.
  w.ShowWindow(hwnd, 0 /* SW_HIDE */);
  w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  w.ShowWindow(hwnd, 8 /* SW_SHOWNA */);
}

/** The deepest visible child of a window at a point in its client area, and the point in that child's. */
function childAt(hwnd, x, y) {
  const w = load();
  let target = hwnd;
  let point = { x, y };
  for (let depth = 0; depth < 12; depth += 1) {
    const child = w.ChildWindowFromPointEx(target, point, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
    if (!child || child === target) break;
    const screen = { ...point };
    w.ClientToScreen(target, screen);
    w.ScreenToClient(child, screen);
    target = child;
    point = screen;
  }
  return { hwnd: target, x: point.x, y: point.y };
}

function post(hwnd, msg, wParam, lParam) {
  const w = load();
  return w ? w.PostMessageW(hwnd, msg >>> 0, wParam, lParam) : false;
}

function send(hwnd, msg, wParam, lParam) {
  const w = load();
  return w ? w.SendMessageW(hwnd, msg >>> 0, wParam, lParam) : 0;
}

function toScreen(hwnd, x, y) {
  const w = load();
  const point = { x, y };
  w.ClientToScreen(hwnd, point);
  return point;
}

const scanCode = (vk) => {
  const w = load();
  return w ? w.MapVirtualKeyW(vk, 0 /* MAPVK_VK_TO_VSC */) : 0;
};

/**
 * Keys with modifiers held: Chromium (and most apps) read Ctrl, Shift and
 * Alt with GetKeyState, which posted messages don't change. For the length
 * of one sent message our thread shares the window's input state, with
 * the modifiers set as they should be; then both go back as they were.
 */
function sendWithModifiers(hwnd, messages, { ctrl = false, shift = false, alt = false } = {}) {
  const w = load();
  if (!w) return false;
  const pidOut = [0];
  const theirs = w.GetWindowThreadProcessId(hwnd, pidOut);
  const ours = w.GetCurrentThreadId();
  if (!theirs || !w.AttachThreadInput(ours, theirs, true)) return false;
  const saved = Buffer.alloc(256);
  try {
    w.GetKeyboardState(saved);
    const state = Buffer.from(saved);
    const set = (vk, on) => {
      state[vk] = on ? state[vk] | 0x80 : state[vk] & ~0x80;
    };
    set(0x11, ctrl); set(0xa2, ctrl);
    set(0x10, shift); set(0xa0, shift);
    set(0x12, alt); set(0xa4, alt);
    w.SetKeyboardState(state);
    const result = [0];
    for (const [msg, wParam, lParam] of messages) w.SendMessageTimeoutW(hwnd, msg, wParam, lParam, 0x2 /* ABORTIFHUNG */, 200, result);
    w.SetKeyboardState(saved);
  } finally {
    w.AttachThreadInput(ours, theirs, false);
  }
  return true;
}

/** The window with the keyboard in this window's thread, and its top-level window: { focus, root } (0s if none). */
function focusOf(hwnd) {
  const w = load();
  const none = { focus: 0, root: 0 };
  if (!w) return none;
  const thread = w.GetWindowThreadProcessId(hwnd, [0]);
  const info = { cbSize: w.koffi.sizeof(w.GUITHREADINFO) };
  if (!thread || !w.GetGUIThreadInfo(thread, info) || !info.hwndFocus) return none;
  return { focus: info.hwndFocus, root: w.GetAncestor(info.hwndFocus, GA_ROOT) };
}

/**
 * A window's client area as it is now, even off-screen or covered (Windows
 * asks the compositor for it): { width, height, data } with data as BGRA
 * rows, top to bottom; null if it can't be had.
 */
function capture(hwnd) {
  const w = load();
  if (!w || !w.IsWindow(hwnd)) return null;
  const size = {};
  w.GetClientRect(hwnd, size);
  const width = size.right;
  const height = size.bottom;
  if (width < 1 || height < 1) return null;
  const screenDc = w.GetDC(0);
  const dc = w.CreateCompatibleDC(screenDc);
  const bitmap = w.CreateCompatibleBitmap(screenDc, width, height);
  const old = w.SelectObject(dc, bitmap);
  try {
    if (!w.PrintWindow(hwnd, dc, 3 /* PW_CLIENTONLY | PW_RENDERFULLCONTENT */)) return null;
    const data = Buffer.alloc(width * height * 4);
    const header = { biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
    w.SelectObject(dc, old);
    if (w.GetDIBits(dc, bitmap, 0, height, data, header, 0 /* DIB_RGB_COLORS */) !== height) return null;
    // GDI leaves alpha at 0: opaque.
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width, height, data };
  } finally {
    w.SelectObject(dc, old);
    w.DeleteObject(bitmap);
    w.DeleteDC(dc);
    w.ReleaseDC(0, screenDc);
  }
}

/** The words in a window and its controls (a dialog's message), from another process too. */
function texts(hwnd) {
  const w = load();
  if (!w) return [];
  const out = [];
  const read = (h) => {
    const buffer = Buffer.alloc(4096 * 2);
    const length = [0];
    if (w.GetTextTimeout(h, 0x0d /* WM_GETTEXT */, 4096, buffer, 0x2 /* ABORTIFHUNG */, 200, length) && length[0] > 0) {
      out.push(buffer.toString('utf16le', 0, Number(length[0]) * 2));
    }
    return true;
  };
  read(hwnd);
  w.EnumChildWindows(hwnd, (child) => read(child), 0);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** The top-level window at a point on the screen (0 if none). */
function windowAt(x, y) {
  const w = load();
  if (!w) return 0;
  const hit = w.WindowFromPoint({ x, y });
  return hit ? w.GetAncestor(hit, GA_ROOT) : 0;
}

/** Where the real mouse pointer is, in screen pixels. */
function cursor() {
  const w = load();
  const point = { x: 0, y: 0 };
  if (w) w.GetCursorPos(point);
  return point;
}

const alive = (hwnd) => Boolean(load() && api.IsWindow(hwnd));

module.exports = {
  get available() {
    return Boolean(load());
  },
  processParents,
  processTree,
  descendants,
  windowsOf,
  windowRects,
  bounds,
  place,
  raise,
  setToolWindow,
  focusOf,
  cursor,
  windowAt,
  capture,
  texts,
  childAt,
  post,
  sendWithModifiers,
  send,
  toScreen,
  scanCode,
  alive,
  HWND_BOTTOM,
  HWND_TOP,
  WS_CHILD,
};
