// 小葵 OS · 桌面右键菜单
// 只在桌面空白区域右键时弹出；点击菜单外 / Esc 关闭；弹出位置不超出视口。

export class DesktopContextMenu {
  /**
   * @param {HTMLElement} overlayEl 菜单挂载层
   * @param {{ onRefresh: () => void, onArrange: () => void }} actions
   */
  constructor(overlayEl, actions) {
    this.actions = actions;
    this.el = document.createElement('div');
    this.el.className = 'context-menu xk-pixel-box';
    this.el.hidden = true;
    this.el.innerHTML = `
      <button class="menu-item" data-action="refresh">刷新桌面</button>
      <button class="menu-item" data-action="arrange">排列图标</button>
    `;
    overlayEl.appendChild(this.el);

    this.el.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      e.stopPropagation();
      this.hide();
      if (item.dataset.action === 'refresh') this.actions.onRefresh();
      if (item.dataset.action === 'arrange') this.actions.onArrange();
    });

    // 点击菜单外关闭；Esc 关闭
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  /** 在指定坐标弹出，自动收进视口内 */
  show(x, y) {
    this.el.hidden = false;
    const mw = this.el.offsetWidth;
    const mh = this.el.offsetHeight;
    const left = Math.min(x, window.innerWidth - mw - 4);
    const top = Math.min(y, window.innerHeight - mh - 4);
    this.el.style.left = `${Math.max(4, left)}px`;
    this.el.style.top = `${Math.max(4, top)}px`;
  }

  hide() {
    this.el.hidden = true;
  }
}
