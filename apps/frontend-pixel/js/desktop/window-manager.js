// 小葵 OS · 窗口管理器
// 统一维护所有窗口状态（open / minimized / maximized / active / zIndex / position），
// 界面通过 subscribe 订阅状态变化来渲染，应用本身不各自维护窗口状态。

import { getApp } from './apps.js';
import { readWindowLayouts, writeWindowLayouts, fitWindowBounds, isDesktopViewport } from './window-layout.js';

export class WindowManager {
  constructor() {
    this.windows = new Map(); // appId → { open, minimized, zIndex, position:{x,y}, size:{width,height} }
    this.activeId = null;
    this.zCounter = 10;
    this.cascadeCount = 0;
    this.listeners = new Set();
    this.layouts = readWindowLayouts();
    window.addEventListener('pagehide', () => this.rememberAll());
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.getState());
  }

  getState() {
    return {
      activeId: this.activeId,
      windows: new Map(this.windows),
    };
  }

  /** 打开应用；已打开则激活（或从最小化恢复），不创建副本 */
  open(appId, size) {
    const app = getApp(appId);
    if (!app) return;
    const win = this.windows.get(appId);
    if (win && win.open) {
      win.minimized = false;
      this.activate(appId);
      return;
    }
    const offset = (this.cascadeCount++ % 6) * 32;
    const saved = this.layouts[appId];
    this.windows.set(appId, {
      open: true,
      minimized: false,
      zIndex: ++this.zCounter,
      maximized: saved?.maximized || false,
      position: saved ? { x: saved.x, y: saved.y } : { x: 96 + offset, y: 64 + offset },
      size: saved ? { width: saved.width, height: saved.height } : { ...(size || app.size) },
    });
    this.activeId = appId;
    this.emit();
  }

  close(appId) {
    this.remember(appId);
    this.windows.delete(appId);
    if (this.activeId === appId) {
      this.activeId = this.topMostId();
    }
    this.emit();
  }

  minimize(appId) {
    const win = this.windows.get(appId);
    if (!win) return;
    win.minimized = true;
    if (this.activeId === appId) {
      this.activeId = this.topMostId();
    }
    this.emit();
  }

  /** 激活并置顶；若已最小化则恢复 */
  activate(appId) {
    const win = this.windows.get(appId);
    if (!win) return;
    if (this.activeId === appId && !win.minimized) return;
    win.minimized = false;
    win.zIndex = ++this.zCounter;
    this.activeId = appId;
    this.emit();
  }

  /** 任务栏按钮行为：激活态 → 最小化；其余 → 恢复并激活 */
  toggle(appId) {
    const win = this.windows.get(appId);
    if (!win) return;
    if (win.minimized || this.activeId !== appId) {
      this.activate(appId);
    } else {
      this.minimize(appId);
    }
  }

  setPosition(appId, x, y) {
    const win = this.windows.get(appId);
    if (!win) return;
    this.setBounds(appId, { x, y, ...win.size });
  }

  setSize(appId, width, height) {
    const win = this.windows.get(appId);
    if (!win) return;
    this.setBounds(appId, { ...win.position, width, height });
  }

  /** 移动/缩放一次合并更新，避免一帧触发两次桌面重绘。 */
  setBounds(appId, bounds) {
    const win = this.windows.get(appId);
    if (!win || win.maximized || !isDesktopViewport()) return;
    const fitted = fitWindowBounds(bounds, getApp(appId));
    win.position = { x: Math.round(fitted.x), y: Math.round(fitted.y) };
    win.size = { width: Math.round(fitted.width), height: Math.round(fitted.height) };
    this.emit();
  }

  getBounds(appId) {
    const win = this.windows.get(appId);
    return win ? fitWindowBounds({ ...win.position, ...win.size }, getApp(appId), win.maximized) : null;
  }

  toggleMaximize(appId) {
    const win = this.windows.get(appId);
    if (!win || !isDesktopViewport()) return;
    win.maximized = !win.maximized;
    win.minimized = false;
    win.zIndex = ++this.zCounter;
    this.activeId = appId;
    this.remember(appId);
    this.emit();
  }

  remember(appId) {
    if (!isDesktopViewport()) return;
    const win = this.windows.get(appId);
    if (!win) return;
    this.layouts[appId] = { ...win.position, ...win.size, maximized: win.maximized };
    writeWindowLayouts(this.layouts);
  }

  rememberAll() {
    if (!isDesktopViewport()) return;
    for (const [id, win] of this.windows) {
      this.layouts[id] = { ...win.position, ...win.size, maximized: win.maximized };
    }
    writeWindowLayouts(this.layouts);
  }

  /** 只恢复窗口布局；保留打开/最小化状态及应用内容。 */
  resetLayouts() {
    this.layouts = {};
    let index = 0;
    for (const [id, win] of this.windows) {
      const offset = (index++ % 6) * 32;
      win.position = { x: 96 + offset, y: 64 + offset };
      win.size = { ...getApp(id).size };
      win.maximized = false;
    }
    this.cascadeCount = index;
    writeWindowLayouts(this.layouts);
    this.emit();
  }

  topMostId() {
    let best = null;
    let bestZ = -1;
    for (const [id, w] of this.windows) {
      if (!w.minimized && w.zIndex > bestZ) {
        best = id;
        bestZ = w.zIndex;
      }
    }
    return best;
  }
}
