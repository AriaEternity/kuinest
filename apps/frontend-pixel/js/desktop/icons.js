// 小葵 OS · 桌面图标组件
// 单击选中、双击打开、自由拖动（位置持久化到 localStorage）；
// 选中态为轻量像素高亮；图标与文字是独立 UI 元素。

import { APPS } from './apps.js';
import { gameViewport } from '../games/viewport.js';

const ICON_X = 28;
const ICON_Y = 28;
const ICON_STEP = 96;   // 默认网格纵向间距
const DRAG_THRESHOLD = 5; // 超过该位移判定为拖动，不再触发选中/双击
const TASKBAR_H = 40;
const STORAGE_KEY = 'xiaokui-icon-positions';

export class DesktopIcons {
  /**
   * @param {HTMLElement} layerEl 图标图层
   * @param {WindowManager} wm
   */
  constructor(layerEl, wm) {
    this.layer = layerEl;
    this.wm = wm;
    this.selectedId = null;
    this.positions = this.loadPositions();
    this.render();
    this.onResize=()=>this.fitPositions();
    window.addEventListener('resize',this.onResize);
  }

  /** 默认网格：左侧竖排 */
  defaultPosition(index) {
    const rows=Math.max(1,Math.floor((window.innerHeight-TASKBAR_H-ICON_Y-84)/ICON_STEP)+1);
    return { x: ICON_X+Math.floor(index/rows)*96, y: ICON_Y+(index%rows)*ICON_STEP };
  }

  loadPositions() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  savePositions() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.positions));
    } catch {
      // 隐私模式等场景写入失败时静默降级为不持久化
    }
  }

  getPosition(appId, index) {
    const p = this.positions[appId];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    return this.defaultPosition(index);
  }

  render() {
    this.layer.innerHTML = '';
    const apps = APPS.filter((a) => !a.system);
    apps.forEach((app, i) => {
      const el = document.createElement('div');
      el.className = 'desktop-icon';
      el.dataset.app = app.id;
      const raw = this.getPosition(app.id, i);
      const pos = {x:clamp(raw.x,4,Math.max(4,window.innerWidth-80)),y:clamp(raw.y,4,Math.max(4,window.innerHeight-TASKBAR_H-84))};
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', app.title);

      const img = document.createElement('div');
      img.className = 'icon-img';
      img.innerHTML = app.iconSrc
        ? `<img src="${app.iconSrc}" alt="" width="48" height="48">`
        : app.iconSvg;

      const label = document.createElement('div');
      label.className = 'icon-label';
      label.textContent = app.title;

      el.append(img, label);
      this.bindPointer(el, app);

      this.layer.appendChild(el);
    });
    this.syncSelection();
  }

  bindPointer(el, app) {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let dragging = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      originX = el.offsetLeft;
      originY = el.offsetTop;
      dragging = false;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        el.classList.add('dragging');
        this.select(app.id);
      }
      // 拖动位置约束在视口内（避开任务栏）
      const x = clamp(e.clientX - startX + originX, 4, window.innerWidth - el.offsetWidth - 4);
      const y = clamp(e.clientY - startY + originY, 4, window.innerHeight - TASKBAR_H - el.offsetHeight - 4);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      this.positions[app.id] = { x, y };
    });

    el.addEventListener('pointerup', (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (dragging) {
        el.classList.remove('dragging');
        this.savePositions();
        // 拖动后的 click/dblclick 视为拖动的余波，不触发选中/打开
        el.dataset.suppressClick = '1';
        setTimeout(() => delete el.dataset.suppressClick, 0);
      }
      dragging = false;
    });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.dataset.suppressClick) return;
      this.select(app.id);
      if (app.id==='games' && gameViewport().handheld) this.wm.open(app.id,app.size);
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (el.dataset.suppressClick) return;
      this.wm.open(app.id, app.size);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.wm.open(app.id, app.size);
    });
  }

  select(appId) {
    this.selectedId = appId;
    this.syncSelection();
  }

  clearSelection() {
    this.selectedId = null;
    this.syncSelection();
  }

  syncSelection() {
    for (const el of this.layer.querySelectorAll('.desktop-icon')) {
      el.classList.toggle('selected', el.dataset.app === this.selectedId);
    }
  }

  // 转屏只修正当前可见位置，不覆盖用户保存的桌面排列，也不重建按钮丢失焦点。
  fitPositions() {
    const apps=APPS.filter(a=>!a.system);
    for(const [index,el] of [...this.layer.querySelectorAll('.desktop-icon')].entries()){
      const raw=this.getPosition(apps[index].id,index);
      el.style.left=clamp(raw.x,4,Math.max(4,window.innerWidth-el.offsetWidth-4))+'px';
      el.style.top=clamp(raw.y,4,Math.max(4,window.innerHeight-TASKBAR_H-el.offsetHeight-4))+'px';
    }
  }
  destroy(){window.removeEventListener('resize',this.onResize);}

  /** 「排列图标」：清除自定义位置，恢复默认网格 */
  arrange() {
    this.positions = {};
    this.savePositions();
    this.clearSelection();
    this.render();
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
