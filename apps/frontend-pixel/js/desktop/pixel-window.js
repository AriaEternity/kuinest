// 小葵 OS · 像素窗口组件（PixelWindow）
// 统一可复用窗口：标题栏（图标 / 中文标题 / 最小化 / 最大化 / 关闭）、像素描边、
// 标题栏拖动、点击置顶、内容插槽与边缘缩放。

import { getApp, asciiIcon } from './apps.js';
import { ChatView } from '../chat/view.js';
import { SettingsView } from './settings-view.js';
import { RunView } from '../games/run-view.js';
import { GameRoomView } from '../games/room-view.js';
import { gameViewport } from '../games/viewport.js';
import { isDesktopViewport } from './window-layout.js';

const EDGE = 6;        // 边缘缩放感应区（px）
const MIN_W = 240;
const MIN_H = 200;

const CURSORS = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

// 标题栏按钮的像素图形（不用文本符号）
const GLYPH = { X: 'currentColor' };
const BTN_MIN = asciiIcon(
  ['..........', '..........', '..........', '..........', '..........',
   '..........', '..........', '.XXXXXXXX.', '.XXXXXXXX.', '..........'],
  GLYPH, 10
);
const BTN_CLOSE = asciiIcon(
  ['XX......XX', '.XX....XX.', '..XX..XX..', '...XXXX...', '....XX....',
   '....XX....', '...XXXX...', '..XX..XX..', '.XX....XX.', 'XX......XX'],
  GLYPH, 10
);
const BTN_MAX = asciiIcon(
  ['XXXXXXXXXX', 'XXXXXXXXXX', 'X........X', 'X........X', 'X........X',
   'X........X', 'X........X', 'X........X', 'X........X', 'XXXXXXXXXX'], GLYPH, 10
);
const BTN_RESTORE = asciiIcon(
  ['...XXXXXXX', '...XXXXXXX', '...X.....X', 'XXXXXXXX.X', 'XXXXXXXX.X',
   'X.....XX.X', 'X.....XXXX', 'X.....XX..', 'X.....XX..', 'XXXXXXXX..'], GLYPH, 10
);

export class PixelWindow {
  /**
   * @param {object} app 应用注册信息
   * @param {WindowManager} wm
   */
  constructor(app, wm) {
    this.app = app;
    this.wm = wm;

    this.el = document.createElement('section');
    this.el.className = 'pixel-window xk-pixel-box';
    this.el.dataset.app = app.id;
    this.el.setAttribute('aria-labelledby', `pw-title-${app.id}`);

    this.el.innerHTML = `
      <header class="pw-titlebar" tabindex="0">
        <span class="pw-icon">${app.iconSrc ? `<img src="${app.iconSrc}" alt="" width="16" height="16">` : app.iconSvg}</span>
        <span class="pw-title"></span>
        <button class="xk-btn pw-btn pw-min" aria-label="最小化">${BTN_MIN}</button>
        <button class="xk-btn pw-btn pw-max" aria-label="最大化">${BTN_MAX}</button>
        <button class="xk-btn pw-btn pw-close" aria-label="关闭">${BTN_CLOSE}</button>
      </header>
      <div class="pw-content"></div>
    `;
    this.el.querySelector('.pw-title').textContent = app.title;
    this.el.querySelector('.pw-title').id = `pw-title-${app.id}`;
    this.titlebar = this.el.querySelector('.pw-titlebar');
    this.titlebar.setAttribute('aria-label', `${app.title}窗口标题栏`);
    this.titlebar.title = '方向键移动 · Shift+方向键调整大小 · Enter 最大化或还原';
    this.lastFocused = this.titlebar;
    this.maxButton = this.el.querySelector('.pw-max');

    // 内容插槽：聊天室挂载应用，其他入口保留占位。
    const content = this.el.querySelector('.pw-content');
    if (app.id === 'chat') {
      this.application = new ChatView(content);
    } else if (app.id === 'games') {
      this.application = new GameRoomView(content, wm);
    } else if (app.id === 'game') {
      this.application = new RunView(content);
    } else if (app.id === 'settings') {
      this.application = new SettingsView(content, wm);
    } else if (app.about) {
      content.innerHTML = `
        <div class="about-home">
          <p class="about-home-title">葵栖 · 小葵的像素小屋</p>
          <p class="about-home-note">独立运行的像素桌面与对话后端。</p>
          <nav class="about-social" aria-label="小葵的社交主页">
            <a class="xk-btn" href="https://github.com/AriaEternity/kuinest" target="_blank" rel="noopener noreferrer" aria-label="开源仓库（在新标签页打开）">开源仓库 ↗</a>
            <a class="xk-btn" href="https://github.com/AriaEternity/kuinest/issues" target="_blank" rel="noopener noreferrer" aria-label="问题反馈（在新标签页打开）">问题反馈 ↗</a>
          </nav>
          <div class="about-contact"><span>个人联系方式</span><p>QQ：<span class="about-qq">2189920244</span></p></div>
          <p class="about-home-version">小葵 OS · Pixel Desktop</p>
        </div>`;
    } else {
    content.innerHTML = `
      <div class="app-placeholder">
        <div class="icon-img">${app.iconSrc ? `<img src="${app.iconSrc}" alt="" width="48" height="48">` : app.iconSvg}</div>
        <div class="app-name"></div>
        <div class="app-tagline"></div>
        ${app.about ? '<div class="app-about">Version 0.3 · Pixel Desktop</div>' : '<div class="app-wip">建设中…</div>'}
      </div>
    `;
    content.querySelector('.app-name').textContent = app.title;
    content.querySelector('.app-tagline').textContent = app.tagline || '';
    }

    // 事件
    this.el.querySelector('.pw-close').addEventListener('click', (e) => {
      e.stopPropagation();
      wm.close(app.id);
    });
    this.el.querySelector('.pw-min').addEventListener('click', (e) => {
      e.stopPropagation();
      wm.minimize(app.id);
    });
    this.maxButton.addEventListener('click', (e) => {
      e.stopPropagation();
      wm.toggleMaximize(app.id);
    });
    this.el.addEventListener('pointerdown', () => wm.activate(app.id));
    this.el.addEventListener('focusin', (e) => {
      if (!e.target.closest('.pw-btn')) this.lastFocused = e.target;
      wm.activate(app.id);
    });

    this.bindMove();
    this.bindResize();
    this.bindCursor();
    this.bindKeyboard();
  }

  /** 指针所在的边缘缩放区：'' 或 n/s/e/w/ne/nw/se/sw */
  resizeZone(e) {
    if (!isDesktopViewport() || this.wm.windows.get(this.app.id)?.maximized) return '';
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const l = x < EDGE;
    const rr = r.width - x < EDGE;
    const t = y < EDGE;
    const b = r.height - y < EDGE;
    if (t && l) return 'nw';
    if (t && rr) return 'ne';
    if (b && l) return 'sw';
    if (b && rr) return 'se';
    if (t) return 'n';
    if (b) return 's';
    if (l) return 'w';
    if (rr) return 'e';
    return '';
  }

  /** 光标反馈：边缘显示缩放光标，标题栏显示移动光标 */
  bindCursor() {
    this.el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const zone = this.resizeZone(e);
      if (zone) {
        this.el.style.cursor = CURSORS[zone];
      } else if (e.target.closest('.pw-titlebar') && !e.target.closest('.pw-btn') &&
                 isDesktopViewport() && !this.wm.windows.get(this.app.id)?.maximized) {
        this.el.style.cursor = 'move';
      } else {
        this.el.style.cursor = '';
      }
    });
  }

  /** 边缘/角落拖动缩放 */
  bindResize() {
    this.el.addEventListener('pointerdown', (e) => {
      const zone = this.resizeZone(e);
      if (!zone || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      this.titlebar.focus({ preventScroll: true });
      const minWidth = this.app.minSize?.width || MIN_W;
      const minHeight = this.app.minSize?.height || MIN_H;
      const start = {
        ...this.wm.getBounds(this.app.id),
        mx: e.clientX, my: e.clientY,
      };

      this.startGesture(e, (ev) => {
        const dx = ev.clientX - start.mx;
        const dy = ev.clientY - start.my;
        let { x, y, width: w, height: h } = start;

        if (zone.includes('e')) w = start.width + dx;
        if (zone.includes('s')) h = start.height + dy;
        if (zone.includes('w')) { w = start.width - dx; x = start.x + dx; }
        if (zone.includes('n')) { h = start.height - dy; y = start.y + dy; }

        // 最小尺寸约束；西/北侧缩放时位置随尺寸回锚，避免跳变
        if (w < minWidth) { if (zone.includes('w')) x += w - minWidth; w = minWidth; }
        if (h < minHeight) { if (zone.includes('n')) y += h - minHeight; h = minHeight; }

        return { x, y, width: w, height: h };
      });
    });
  }

  bindMove() {
    const titlebar = this.titlebar;
    titlebar.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.pw-btn')) this.wm.toggleMaximize(this.app.id);
    });
    titlebar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !isDesktopViewport() || e.target.closest('.pw-btn') ||
          this.resizeZone(e) || this.wm.windows.get(this.app.id)?.maximized) return;
      e.preventDefault();
      titlebar.focus({ preventScroll: true });
      const startX = e.clientX;
      const startY = e.clientY;
      const bounds = this.wm.getBounds(this.app.id);
      this.startGesture(e, (ev) => ({ ...bounds,
        x: bounds.x + ev.clientX - startX, y: bounds.y + ev.clientY - startY }));
    });
  }

  /** 指针捕获与帧合并：释放/中断时提交最后一帧，并移除临时监听。 */
  startGesture(e, calculate) {
    this.endGesture?.();
    // 标题栏捕获自己的拖动，保留 click/dblclick 的原始目标。
    const captureTarget = e.currentTarget;
    let frame = 0;
    let pending = null;
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (pending) this.wm.setBounds(this.app.id, pending);
      pending = null;
    };
    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      pending = calculate(ev);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const onEnd = (ev) => {
      if (ev?.pointerId != null && ev.pointerId !== e.pointerId) return;
      flush();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      captureTarget.removeEventListener('lostpointercapture', onEnd);
      this.endGesture = null;
      if (captureTarget.hasPointerCapture(e.pointerId)) captureTarget.releasePointerCapture(e.pointerId);
      this.wm.remember(this.app.id);
    };
    this.endGesture = onEnd;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
    captureTarget.addEventListener('lostpointercapture', onEnd);
    captureTarget.setPointerCapture(e.pointerId);
  }

  bindKeyboard() {
    this.titlebar.addEventListener('keydown', (e) => {
      if (e.target !== this.titlebar || e.altKey || e.ctrlKey || e.metaKey || !isDesktopViewport()) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.wm.toggleMaximize(this.app.id);
        return;
      }
      const direction = { ArrowLeft: [-16, 0], ArrowRight: [16, 0],
        ArrowUp: [0, -16], ArrowDown: [0, 16] }[e.key];
      if (!direction || this.wm.windows.get(this.app.id)?.maximized) return;
      e.preventDefault();
      const bounds = this.wm.getBounds(this.app.id);
      const [dx, dy] = direction;
      if (e.shiftKey) { bounds.width += dx; bounds.height += dy; }
      else { bounds.x += dx; bounds.y += dy; }
      this.wm.setBounds(this.app.id, bounds);
      this.wm.remember(this.app.id);
    });
  }

  focusPreferred() {
    const target = this.lastFocused;
    if (this.el.contains(target) && target.getClientRects().length && !target.disabled) {
      target.focus({ preventScroll: true });
    } else this.titlebar.focus({ preventScroll: true });
  }

  /** 按状态同步 DOM（显示 / 激活 / 层级 / 位置 / 尺寸） */
  sync(state) {
    const win = state.windows.get(this.app.id);
    if (!win) return;
    const bounds = this.wm.getBounds(this.app.id);
    this.el.style.display = win.minimized ? 'none' : '';
    this.el.style.zIndex = win.zIndex;
    this.el.style.left = `${bounds.x}px`;
    this.el.style.top = `${bounds.y}px`;
    this.el.style.width = `${bounds.width}px`;
    this.el.style.height = `${bounds.height}px`;
    this.el.classList.toggle('active', state.activeId === this.app.id);
    this.el.classList.toggle('handheld-game', ['game','games'].includes(this.app.id) && gameViewport().handheld);
    this.application?.setVisible?.(!win.minimized && state.activeId === this.app.id);
    this.el.classList.toggle('maximized', win.maximized);
    const label = win.maximized ? '还原' : '最大化';
    this.maxButton.setAttribute('aria-label', label);
    this.maxButton.title = label;
    if (this.maxButton.dataset.maximized !== String(win.maximized)) {
      this.maxButton.innerHTML = win.maximized ? BTN_RESTORE : BTN_MAX;
      this.maxButton.dataset.maximized = String(win.maximized);
    }
  }
  destroy() {
    this.endGesture?.();
    this.application?.destroy();
  }
}

// 窗口视图：按 WindowManager 状态增减窗口 DOM（状态驱动渲染）
export class WindowsView {
  constructor(layerEl, wm) {
    this.layer = layerEl;
    this.wm = wm;
    this.views = new Map(); // appId → PixelWindow
    this.activeId = null;
    wm.subscribe((state) => this.sync(state));
    window.addEventListener('resize', () => this.sync(wm.getState()));
    window.visualViewport?.addEventListener('resize', () => this.sync(wm.getState()));
  }

  sync(state) {
    const previousId = this.activeId;
    const previousView = this.views.get(previousId);
    const focused = document.activeElement;
    const hadWindowFocus = previousView?.el.contains(focused);
    const nextView = this.views.get(state.activeId);
    const opening = state.activeId && (!nextView || nextView.el.style.display === 'none');
    const fromTaskbar = focused?.closest('.tb-app-btn');
    for (const [appId, win] of state.windows) {
      if (!win.open) continue;
      if (!this.views.has(appId)) {
        const view = new PixelWindow(getApp(appId), this.wm);
        this.views.set(appId, view);
        this.layer.appendChild(view.el);
      }
      this.views.get(appId).sync(state);
    }
    for (const [appId, view] of this.views) {
      if (!state.windows.has(appId)) {
        view.destroy();
        view.el.remove();
        this.views.delete(appId);
      }
    }
    this.activeId = state.activeId;
    const previousHidden = !state.windows.has(previousId) || state.windows.get(previousId)?.minimized;
    if (opening || fromTaskbar || (hadWindowFocus && previousHidden)) {
      if (state.activeId) this.focusActive();
      else if (hadWindowFocus) {
        const root = this.layer.closest('#desktop');
        const target = (state.windows.has(previousId) && root.querySelector(`.tb-app-btn[data-app="${previousId}"]`)) ||
          root.querySelector(`.desktop-icon[data-app="${previousId}"]`) || root.querySelector('.tb-start');
        target?.focus({ preventScroll: true });
      }
    }
  }

  focusActive() { this.views.get(this.wm.activeId)?.focusPreferred(); }
}
