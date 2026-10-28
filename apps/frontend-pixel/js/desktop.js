// 小葵 OS · 桌面场景组件
// 当前只包含壁纸底层；addLayer() 预留给未来的图标、任务栏、窗口、小葵头像等
// 独立 UI 图层，各图层为同级绝对定位元素，按插入顺序自下而上堆叠。

export const WALLPAPER_URL = './assets/wallpaper.png';

export class DesktopScene {
  constructor(root) {
    this.root = root;
    this.layers = new Map();

    // 壁纸底层
    this.addLayer('wallpaper', 'desktop-wallpaper');
    // 用户提供的透明 Logo，位于壁纸上方、桌面窗口下方，不接收点击。
    const branding = this.addLayer('branding', 'desktop-branding');
    const logo = document.createElement('img');
    logo.src = './assets/xiaokui-logo-v1.png';
    logo.alt = '小葵 XIAOKUI';
    logo.className = 'desktop-logo';
    logo.draggable = false;
    logo.decoding = 'async';
    branding.appendChild(logo);
    // 未来 UI 图层容器（图标 / 任务栏 / 窗口 / 小葵头像挂载于此层之下或独立图层）
    this.addLayer('ui', 'desktop-ui');
  }

  /**
   * 添加一个桌面图层
   * @param {string} name 图层名（如 'icons'、'taskbar'、'windows'、'xiaokui'）
   * @param {string} [className] 附加的 CSS 类
   * @returns {HTMLElement} 图层元素
   */
  addLayer(name, className = '') {
    if (this.layers.has(name)) return this.layers.get(name);
    const el = document.createElement('div');
    el.className = `desktop-layer ${className}`.trim();
    el.dataset.layer = name;
    this.root.appendChild(el);
    this.layers.set(name, el);
    return el;
  }

  getLayer(name) {
    return this.layers.get(name) || null;
  }

  show() {
    this.root.hidden = false;
  }
}

// 预加载壁纸（真实启动任务）：加载并解码完成才 resolve，失败 reject 由加载器重试
export function preloadWallpaper() {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.decode) {
        img.decode().then(resolve, resolve); // 解码失败不阻塞，浏览器仍会按需解码
      } else {
        resolve();
      }
    };
    img.onerror = () => reject(new Error(`壁纸加载失败：${WALLPAPER_URL}`));
    img.src = WALLPAPER_URL;
  });
}
