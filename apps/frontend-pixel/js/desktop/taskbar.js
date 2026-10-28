// 小葵 OS · 动态任务栏
// 左侧「小葵 OS」系统入口；中间仅显示当前已打开的应用（状态驱动）；
// 右侧用户设备本地时间（HH:mm）与日期（YYYY/MM/DD）两行右对齐。

import { getApp, SUNFLOWER_SVG } from './apps.js';

const pad2 = (value) => String(value).padStart(2, '0');

// 时间来源：浏览器所在设备的本地日期时间（不写死时区、不用 toISOString）
function getDeviceLocalClock() {
  const now = new Date();
  return {
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    date: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`,
  };
}

export class Taskbar {
  /**
   * @param {HTMLElement} layerEl 任务栏图层
   * @param {WindowManager} wm
   */
  constructor(layerEl, wm, { onResetLayout = () => wm.resetLayouts(), onChatAttention = () => wm.open('chat') } = {}) {
    this.layer = layerEl;
    this.wm = wm;
    this.timer = 0;
    this.startMenuOpen = false;
    this.appButtons = new Map();
    this.appsSignature = '';
    this.attention = [];
    this.onChatAttention = onChatAttention;

    this.el = document.createElement('footer');
    this.el.className = 'taskbar';
    this.el.innerHTML = `
      <button class="xk-btn tb-start"><span class="pw-icon">${SUNFLOWER_SVG}</span>小葵 OS</button>
      <div class="tb-apps" role="list"></div>
      <div class="tb-tray">
        <div class="tb-clock" aria-label="设备本地时间">
          <span class="tb-time"></span>
          <span class="tb-date"></span>
        </div>
      </div>
      <span class="tb-attention-status" role="status" aria-live="polite"></span>
    `;
    layerEl.appendChild(this.el);

    this.appsEl = this.el.querySelector('.tb-apps');
    this.timeEl = this.el.querySelector('.tb-time');
    this.dateEl = this.el.querySelector('.tb-date');
    this.attentionStatus = this.el.querySelector('.tb-attention-status');
    this.startButton = this.el.querySelector('.tb-start');
    this.startButton.setAttribute('aria-expanded', 'false');
    this.startButton.setAttribute('aria-controls', 'xk-start-menu');

    // 系统入口：简单菜单
    this.startMenu = document.createElement('div');
    this.startMenu.className = 'start-menu xk-pixel-box';
    this.startMenu.id = 'xk-start-menu';
    this.startMenu.hidden = true;
    this.startMenu.innerHTML = `
      <button class="menu-item" data-action="settings">桌面设置</button>
      <button class="menu-item" data-action="about">关于小葵 OS</button>
      <button class="menu-item" data-action="reset" title="恢复窗口位置和大小，保留应用内容">恢复默认窗口布局</button>
    `;
    layerEl.appendChild(this.startMenu);

    this.startButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleStartMenu();
    });
    this.startMenu.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      this.closeStartMenu(true);
      if (action === 'about') this.wm.open('about', getApp('about').size);
      if (action === 'settings') this.wm.open('settings');
      if (action === 'reset') onResetLayout();
    });
    this.onOutsideClick = () => this.closeStartMenu();
    this.onMenuKey = (e) => {
      if (!this.startMenuOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); this.closeStartMenu(true); }
      if (e.target.closest('#xk-start-menu') && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        const buttons = [...this.startMenu.querySelectorAll('button')];
        const next = (buttons.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    document.addEventListener('click', this.onOutsideClick);
    document.addEventListener('keydown', this.onMenuKey);

    this.unsubscribe = wm.subscribe((state) => this.syncApps(state));

    this.startClock();
  }

  toggleStartMenu() {
    this.startMenuOpen = !this.startMenuOpen;
    this.startMenu.hidden = !this.startMenuOpen;
    this.startButton.setAttribute('aria-expanded', String(this.startMenuOpen));
    if (this.startMenuOpen) this.startMenu.querySelector('button').focus();
  }

  closeStartMenu(returnFocus = false) {
    this.startMenuOpen = false;
    this.startMenu.hidden = true;
    this.startButton.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.startButton.focus({ preventScroll: true });
  }

  /** 仅增减必要按钮；移动/缩放期间保留节点与键盘焦点。 */
  syncApps(state) {
    const windows = new Map(state.windows);
    // 已收到的提醒即使随后关闭聊天窗口，也保留一个可返回的入口。
    if (this.attention.length && !windows.has('chat')) windows.set('chat', { open: true, minimized: true });
    const signature = `${state.activeId}:${[...windows].map(([id, win]) => `${id}/${win.minimized}`).join(',')}:${JSON.stringify(this.attention)}`;
    if (signature === this.appsSignature) return;
    this.appsSignature = signature;
    for (const [id, { item }] of this.appButtons) {
      if (windows.has(id)) continue;
      item.remove();
      this.appButtons.delete(id);
    }
    for (const [appId, win] of windows) {
      if (!win.open) continue;
      const app = getApp(appId);
      if (!this.appButtons.has(appId)) {
        const item = document.createElement('div');
        item.className = 'tb-app-item';
        item.setAttribute('role', 'listitem');
        const btn = document.createElement('button');
        btn.className = 'xk-btn tb-app-btn';
        btn.dataset.app = appId;
        btn.setAttribute('aria-label', app.title);
        btn.title = app.title;
        btn.innerHTML = `
          <span class="pw-icon">${app.iconSrc ? `<img src="${app.iconSrc}" alt="" width="16" height="16">` : app.iconSvg}</span>
          <span class="tb-label"></span>
        `;
        btn.querySelector('.tb-label').textContent = app.title;
        btn.addEventListener('click', () => {
          if (appId === 'chat' && this.attention.length) this.onChatAttention(this.attention[0].conversationId);
          else this.wm.toggle(appId);
        });
        item.appendChild(btn);
        this.appsEl.appendChild(item);
        this.appButtons.set(appId, { item, btn });
      }
      const { btn } = this.appButtons.get(appId);
      const active = state.activeId === appId && !win.minimized;
      btn.classList.toggle('active', active);
      btn.classList.toggle('minimized', win.minimized);
      btn.setAttribute('aria-pressed', String(active));
      const count = appId === 'chat' ? this.attention.length : 0;
      const hasFailure = count && this.attention.some(note => note.failed);
      const reminder = count ? `${count}个会话有未查看的回复${hasFailure ? '（含回复失败）' : ''}` : '';
      btn.classList.toggle('has-attention', !!count);
      btn.setAttribute('aria-label', app.title + (count ? '，' + reminder : ''));
      btn.title = count ? `${app.title} · ${reminder}，点击查看` : `${app.title} · ${win.minimized ? '已最小化，点击恢复' : active ? '点击最小化' : '点击切换'}`;
    }
  }

  setAttention(entries) {
    if (JSON.stringify(entries) === JSON.stringify(this.attention)) return;
    this.attention = entries;
    this.attentionStatus.textContent = entries.length ? `${entries.length}个会话的后台回复有更新${entries.some(note => note.failed) ? '，含回复失败' : ''}。可从任务栏查看。` : '';
    this.syncApps(this.wm.getState());
  }

  /** 时钟：对齐分钟边界更新；页面恢复可见 / 聚焦时立即以当前 new Date() 校准 */
  startClock() {
    const tick = () => {
      clearTimeout(this.timer); // 防止校准路径叠加多个定时链
      const { time, date } = getDeviceLocalClock();
      this.timeEl.textContent = time;
      this.dateEl.textContent = date;
      // 对齐下一分钟边界（+50ms 缓冲），跨分钟与跨午夜都能正确切换
      const now = Date.now();
      const next = 60000 - (now % 60000) + 50;
      this.timer = setTimeout(tick, next);
    };
    this.recalibrate = () => tick();
    this.onVisibility = () => {
      if (!document.hidden) this.recalibrate();
    };
    tick();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.recalibrate);
  }

  destroy() {
    this.unsubscribe();
    document.removeEventListener('click', this.onOutsideClick);
    document.removeEventListener('keydown', this.onMenuKey);
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('focus', this.recalibrate);
  }
}
