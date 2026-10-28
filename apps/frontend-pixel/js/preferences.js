// 仅保存显示偏好，不包含聊天、鉴权或后端业务状态。
const KEY = 'xiaokui-display-preferences-v1';
const DEFAULTS = { typewriter: true, motion: 'system', backgroundReminder: true };
function normalize(value) {
  return {
    typewriter: typeof value?.typewriter === 'boolean' ? value.typewriter : DEFAULTS.typewriter,
    motion: value?.motion === 'reduce' ? 'reduce' : 'system',
    backgroundReminder: typeof value?.backgroundReminder === 'boolean' ? value.backgroundReminder : DEFAULTS.backgroundReminder,
  };
}
function parse(raw) { try { return normalize(JSON.parse(raw)); } catch { return { ...DEFAULTS }; } }

class DisplayPreferences {
  constructor() {
    this.listeners = new Set();
    try { this.value = parse(localStorage.getItem(KEY)); } catch { this.value = { ...DEFAULTS }; }
    this.systemMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.systemMotion.addEventListener('change', () => this.changed());
    window.addEventListener('storage', event => {
      if (event.key === KEY || event.key === null) { this.value = parse(event.newValue); this.changed(); }
    });
    this.apply();
  }
  get reducedMotion() { return this.systemMotion.matches || this.value.motion === 'reduce'; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  apply() { document.documentElement.toggleAttribute('data-reduced-motion', this.reducedMotion); }
  changed() { this.apply(); for (const fn of this.listeners) fn(); }
  set(patch) {
    this.value = normalize({ ...this.value, ...patch });
    let saved = true;
    try { localStorage.setItem(KEY, JSON.stringify(this.value)); } catch { saved = false; }
    this.changed();
    return saved;
  }
  reset() { return this.set(DEFAULTS); }
}
export const displayPreferences = new DisplayPreferences();
