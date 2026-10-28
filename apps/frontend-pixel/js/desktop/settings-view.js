import { displayPreferences as preferences } from '../preferences.js';

export class SettingsView {
  constructor(root, wm) {
    root.classList.add('settings-content');
    root.innerHTML = `
      <div class="settings-heading"><span class="settings-kicker">小葵 OS · 桌面设置</span><h1>按你喜欢的节奏。</h1><p>这些偏好只在此浏览器生效。</p></div>
      <label class="setting-row"><span class="setting-copy"><span class="setting-title">回复打字机</span><span class="setting-help">让新回复逐字展开。关闭后直接显示已收到的文字。</span></span><input type="checkbox" name="typewriter"></label>
      <label class="setting-row setting-motion"><span class="setting-copy"><span class="setting-title">动态效果</span><span class="setting-help">减少窗口弹出、光标闪动与启动动画。</span></span><select class="pixel-input" name="motion"><option value="system">跟随系统</option><option value="reduce">减少动态效果</option></select></label>
      <p class="settings-motion-note"></p>
      <label class="setting-row"><span class="setting-copy"><span class="setting-title">后台回复提醒</span><span class="setting-help">在任务栏标记未查看的回复结束或失败。提醒保持安静。</span></span><input type="checkbox" name="backgroundReminder"></label>
      <div class="settings-actions"><button class="xk-btn" type="button" data-setting-action="defaults">恢复显示偏好</button><button class="xk-btn" type="button" data-setting-action="layout">复位窗口布局</button></div>
      <p class="settings-notice" role="status" aria-live="polite"></p>
    `;
    this.controls = Object.fromEntries([...root.querySelectorAll('[name]')].map(node => [node.name, node]));
    this.notice = root.querySelector('.settings-notice');
    this.motionNote = root.querySelector('.settings-motion-note');
    for (const [key, control] of Object.entries(this.controls)) {
      control.addEventListener('change', () => this.report(preferences.set({ [key]: control.type === 'checkbox' ? control.checked : control.value })));
    }
    root.querySelector('[data-setting-action="defaults"]').addEventListener('click', () => this.report(preferences.reset()));
    root.querySelector('[data-setting-action="layout"]').addEventListener('click', () => {
      wm.resetLayouts(); this.notice.textContent = '窗口布局已复位，应用内容仍保留。';
    });
    this.unsubscribe = preferences.subscribe(() => this.render());
    this.render();
  }
  report(saved) { this.notice.textContent = saved ? '偏好已保存，下次打开仍会生效。' : '当前页面已生效；浏览器未允许保存，刷新后可能恢复默认。'; }
  render() {
    for (const [key, control] of Object.entries(this.controls)) {
      if (control.type === 'checkbox') control.checked = preferences.value[key];
      else control.value = preferences.value[key];
    }
    this.motionNote.textContent = preferences.systemMotion.matches ? '系统已开启减少动态效果，当前优先使用静态展示。' : preferences.reducedMotion ? '当前使用静态展示；新回复直接显示已收到的文字。' : '当前保留像素动效；回复按上面的打字机偏好显示。';
  }
  destroy() { this.unsubscribe(); }
}
