// 只保存本机窗口偏好：不保存打开列表、聊天正文、口令或业务状态。
import { APPS } from './apps.js';
import { gameViewport } from '../games/viewport.js';

const STORAGE_KEY = 'xiaokui-window-layout-v1';
const MARGIN = 8;
const TASKBAR_H = 40;

export function readWindowLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const layouts = {};
    for (const { id } of APPS) {
      const item = raw?.[id];
      if (!item || ![item.x, item.y, item.width, item.height].every(Number.isFinite)) continue;
      if (Math.abs(item.x) > 100000 || Math.abs(item.y) > 100000 ||
          item.width < 1 || item.height < 1 || item.width > 16384 || item.height > 16384) continue;
      layouts[id] = { x: item.x, y: item.y, width: item.width, height: item.height,
        maximized: item.maximized === true };
    }
    return layouts;
  } catch {
    return {};
  }
}

export function writeWindowLayouts(layouts) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts)); }
  catch { /* 存储不可用时仍可在当前页面操作窗口。 */ }
}

export function viewportBounds() {
  const viewport = window.visualViewport;
  return { width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight };
}

export function fitWindowBounds(bounds, app, fill = false) {
  const viewport = viewportBounds();
  const availableWidth = Math.max(1, viewport.width - MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - TASKBAR_H - MARGIN * 2);
  if (fill || window.innerWidth <= 720 || (['game','games'].includes(app.id) && gameViewport().handheld)) {
    return { x: MARGIN, y: MARGIN, width: availableWidth, height: availableHeight };
  }
  const minWidth = Math.min(app.minSize?.width || 240, availableWidth);
  const minHeight = Math.min(app.minSize?.height || 200, availableHeight);
  const width = clamp(bounds.width, minWidth, availableWidth);
  const height = clamp(bounds.height, minHeight, availableHeight);
  return { x: clamp(bounds.x, MARGIN, viewport.width - width - MARGIN),
    y: clamp(bounds.y, MARGIN, viewport.height - TASKBAR_H - height - MARGIN), width, height };
}

export function isDesktopViewport() { return window.innerWidth > 720; }

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
