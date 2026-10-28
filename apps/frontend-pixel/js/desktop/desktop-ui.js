// 小葵 OS · 桌面 UI 组合装配
// 把图标、窗口、任务栏、右键菜单装配到 DesktopScene 的独立图层中；
// 各组件之间通过 WindowManager 状态通信，互不直接依赖。

import { WindowManager } from './window-manager.js';
import { WindowsView } from './pixel-window.js';
import { DesktopIcons } from './icons.js';
import { Taskbar } from './taskbar.js';
import { DesktopContextMenu } from './context-menu.js';
import { ChatAttention } from './chat-attention.js';
import { chatStore } from '../chat/store.js';
import { displayPreferences } from '../preferences.js';

const LONG_PRESS_MS = 600; // 触摸设备无右键：长按空白区域呼出菜单

export class DesktopUI {
  /**
   * @param {DesktopScene} desktop 桌面场景（提供图层）
   */
  constructor(desktop) {
    this.desktop = desktop;
    this.wm = new WindowManager();
    this.attention = new ChatAttention();

    // 图层：壁纸层之下已有 wallpaper；之上依次叠图标、窗口、任务栏、浮层
    this.iconsLayer = desktop.addLayer('icons', 'layer-icons');
    this.windowsLayer = desktop.addLayer('windows', 'layer-windows');
    this.taskbarLayer = desktop.addLayer('taskbar', 'layer-taskbar');
    this.overlayLayer = desktop.addLayer('overlay', 'layer-overlay');

    this.icons = new DesktopIcons(this.iconsLayer, this.wm);
    this.windowsView = new WindowsView(this.windowsLayer, this.wm);
    this.taskbar = new Taskbar(this.taskbarLayer, this.wm, {
      onChatAttention: id => this.openAttention(id),
      onResetLayout: () => {
        this.wm.resetLayouts();
        this.windowsView.focusActive();
      },
    });
    this.contextMenu = new DesktopContextMenu(this.overlayLayer, {
      onRefresh: () => this.refresh(),
      onArrange: () => this.icons.arrange(),
    });

    this.bindBlankAreaEvents();
    // 提醒只观察已有状态；不另建流、轮询或取消路径。
    const schedule = () => {
      if (this.attentionFrame) return;
      this.attentionFrame = requestAnimationFrame(() => { this.attentionFrame = 0; this.refreshAttention(); });
    };
    // 同步记下回执/运行转移，避免一帧内完成时漏掉短暂的 accepted 状态。
    chatStore.subscribe(() => { this.observeAttention(); schedule(); });
    this.wm.subscribe(schedule);
    displayPreferences.subscribe(schedule);
    desktop.root.addEventListener('chat-reading', schedule);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);
    schedule();
  }

  refreshAttention() {
    const reading = this.wm.activeId === 'chat' && !document.hidden ?
      this.windowsView.views.get('chat')?.application.readingConversation() : null;
    this.taskbar.setAttention(this.observeAttention(reading));
  }

  observeAttention(reading = null) {
    return this.attention.observe({
      scope: `${chatStore.mode}:${chatStore.session?.ownerId}:${chatStore.generation}`,
      authenticated: !!chatStore.session,
      runs: [...chatStore.runs.values()],
      receipts: Object.values(chatStore.pending).map(item => item.receipt),
      reading,
      enabled: displayPreferences.value.backgroundReminder,
    });
  }

  async openAttention(id) {
    this.wm.open('chat');
    if (chatStore.current !== id) await chatStore.select(id);
    if (chatStore.current === id && !chatStore.loading) this.windowsView.views.get('chat')?.application.showLatest();
    this.refreshAttention();
  }

  /** 桌面空白区域：左键清除选中 / 右键或长按呼出菜单 */
  bindBlankAreaEvents() {
    const root = this.desktop.root;

    const isBlank = (target) =>
      !target.closest(
        '.desktop-icon, .pixel-window, .taskbar, .context-menu, .start-menu'
      );

    root.addEventListener('contextmenu', (e) => {
      if (!isBlank(e.target)) return;
      e.preventDefault();
      this.contextMenu.show(e.clientX, e.clientY);
    });

    root.addEventListener('pointerdown', (e) => {
      if (!isBlank(e.target)) return;
      if (e.button === 0) this.icons.clearSelection();

      // 触摸长按替代右键
      if (e.pointerType === 'touch') {
        const { clientX, clientY } = e;
        this.longPressTimer = setTimeout(() => {
          this.contextMenu.show(clientX, clientY);
        }, LONG_PRESS_MS);
        const cancel = () => {
          clearTimeout(this.longPressTimer);
          window.removeEventListener('pointerup', cancel);
          window.removeEventListener('pointercancel', cancel);
        };
        window.addEventListener('pointerup', cancel);
        window.addEventListener('pointercancel', cancel);
      }
    });
  }

  /** 「刷新桌面」：轻量 UI 重置，不刷新页面、不影响窗口与应用数据 */
  refresh() {
    this.contextMenu.hide();
    this.icons.clearSelection();
    this.taskbar.closeStartMenu();
    this.taskbar.recalibrate(); // 立即校准时钟
  }
}
