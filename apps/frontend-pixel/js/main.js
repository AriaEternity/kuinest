// 小葵 OS 启动页 · 主编排：场景 + 真实进度 + 完成过渡
import { BootScene, BOOT_REVEAL_AT, BOOT_REVEAL_DURATION } from './boot-scene.js';
import { BootHandoff } from './boot-handoff.js';
import { BootLoader } from './boot-tasks.js';
import { DesktopScene, preloadWallpaper } from './desktop.js';
import { DesktopUI } from './desktop/desktop-ui.js';
import { chatStore } from './chat/store.js';
import { displayPreferences } from './preferences.js';

const params = new URLSearchParams(location.search);
const reducedMotion =
  displayPreferences.reducedMotion ||
  params.has('static');

// 十秒樱花启动：8.4 秒展示和 1.6 秒 Logo 归位；实际资源进度独立计算。
const visualDuration = reducedMotion ? 0 : BOOT_REVEAL_AT;
let visualSkipped = false;
let handoff = null;
const visualStart = performance.now();

const bootEl = document.getElementById('boot');
const desktop = new DesktopScene(document.getElementById('desktop'));
const desktopUI = new DesktopUI(desktop);
const progressLabelEl = document.getElementById('progressLabel');
const progressValueEl = document.getElementById('progressValue');
const progressFillEl = document.getElementById('progressFill');
const progressLabelWrap = progressLabelEl.parentElement;

const scene = new BootScene(
  document.getElementById('matrixCanvas'),
  document.getElementById('fxCanvas'),
  { reducedMotion }
);

// ---------- 关键启动任务 ----------
// 百分比只来自实际资源/初始化任务。登录失败作为可显示的结果，桌面仍可进入。
const loader = new BootLoader([
  {
    id: 'dom-ready',
    label: 'DOM 就绪',
    weight: 1,
    run: () => Promise.resolve(),
  },
  {
    id: 'boot-logo',
    label: '启动标志',
    weight: 1,
    run: () => scene.loadAssets(),
  },
  {
    id: 'fonts-ready',
    label: '字体就绪',
    weight: 1,
    // 字体加载失败可降级为系统等宽字体，4s 超时后按降级处理
    run: () =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
  },
  {
    id: 'glyph-cache-warm',
    label: '字形缓存预热',
    weight: 1,
    run: () =>
      new Promise((resolve) => {
        // 真实工作：离屏预渲染 0/1 字形，触发字体栅格化
        const off = document.createElement('canvas');
        off.width = off.height = 32;
        const ctx = off.getContext('2d');
        ctx.font = '16px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.fillText('0', 4, 20);
        ctx.fillText('1', 20, 20);
        resolve();
      }),
  },
  {
    id: 'wallpaper',
    label: '桌面壁纸',
    weight: 2,
    // 真实任务：桌面壁纸是关键启动资源，加载并解码完成后才计入进度
    run: () => preloadWallpaper(),
  },
  {
    id: 'chat-state',
    label: '聊天室状态初始化',
    weight: 2,
    run: () => chatStore.init(),
  },
]);

// ---------- 进度显示（显示层做平滑，数据层始终是真实任务进度） ----------
let realProgress = 0;
let displayProgress = 0;

function updateProgressUI() {
  const pct = Math.floor(displayProgress * 100);
  progressValueEl.textContent = `${pct}%`;
  document.querySelector('#boot .track')?.setAttribute('aria-valuenow', String(pct));
  progressFillEl.style.width = `${(displayProgress * 100).toFixed(2)}%`;
}

function onFrame() {
  // 显示值向真实值缓动，避免跳动；不会超越真实值后停滞
  displayProgress += (realProgress - displayProgress) * 0.08;
  if (realProgress - displayProgress < 0.001) displayProgress = realProgress;
  updateProgressUI();
  scene.setProgress(realProgress);
  if (realProgress >= 1 && (visualSkipped || performance.now() - visualStart >= visualDuration)) beginTransition();
}

// ---------- 同一 Logo 平滑归位到真实桌面 ----------
let transitioned = false;
function beginTransition() {
  if (transitioned) return;
  transitioned = true;
  handoff = new BootHandoff({
    scene, boot: bootEl, desktop: document.getElementById('desktop'),
    showDesktop: () => desktop.show(), duration: BOOT_REVEAL_DURATION,
    instant: reducedMotion || visualSkipped,
  });
  handoff.start();
}

// 跳过只缩短展示时间，仍等真实资源任务完成。
document.getElementById('bootSkip').addEventListener('click', () => {
  visualSkipped = true;
  if (realProgress >= 1) beginTransition();
  else document.getElementById('bootSkip').textContent = '资源就绪后进入';
});

loader.start({
  onProgress: (p) => {
    realProgress = p;
    if (reducedMotion) {
      scene.setProgress(p);
      displayProgress = p;
      updateProgressUI();
    }
    if (p >= 1 && reducedMotion) beginTransition();
  },
  onStatus: (status, task) => {
    if (status === 'error' && task) {
      progressLabelWrap.classList.add('error');
      progressLabelEl.textContent = `载入受阻，正在重试…（${task.label}）`;
    } else if (status === 'running') {
      progressLabelWrap.classList.remove('error');
      progressLabelEl.textContent = '载入数字世界';
    } else if (status === 'done') {
      realProgress = 1;
      progressLabelEl.textContent = '资源已就绪';
      if (reducedMotion) beginTransition();
    }
  },
});

scene.start(onFrame);

// 供自动化验证使用
window.__boot = {
  loader,
  scene,
  get handoff() { return handoff; },
  get realProgress() {
    return realProgress;
  },
  get displayProgress() {
    return displayProgress;
  },
};
window.__desktop = desktopUI;
