// 小葵 OS 启动页 · 资源感知启动任务加载器
//
// 进度真实性（任务书 3.6 / P0 验收）：
// - 百分比 = 已完成任务权重 / 总权重，由实际可观测任务的完成状态决定；
// - 任务失败会按退避策略自动重试，绝不把失败冒充为 100%；
// - simulated === true 仅保留给独立的动画开发场景；主页面已移除模拟任务，
//   百分比由字体、壁纸与聊天室初始化等实际工作驱动。

const MAX_ATTEMPTS = 3;        // 单个任务连续失败的最大快速重试次数
const BACKOFF_BASE_MS = 400;   // 快速重试退避基数
const ERROR_RETRY_MS = 5000;   // 进入错误状态后的持续重试间隔

export class BootLoader {
  /**
   * @param {Array<{id:string, label:string, weight:number, simulated?:boolean,
   *               run:(report:(fraction:number)=>void)=>Promise<void>}>} tasks
   */
  constructor(tasks) {
    this.tasks = tasks;
    this.totalWeight = tasks.reduce((s, t) => s + t.weight, 0);
    this.completedWeight = 0;
    this.currentFraction = 0;
    this.done = false;
  }

  get progress() {
    if (this.totalWeight <= 0) return 1;
    const current = this.tasks[this.currentIndex];
    const w = current ? current.weight * this.currentFraction : 0;
    return Math.min(1, (this.completedWeight + w) / this.totalWeight);
  }

  async start({ onProgress, onStatus } = {}) {
    this.currentIndex = 0;
    for (const task of this.tasks) {
      if (task.simulated) {
        console.info(
          `[boot] "${task.id}" 是开发模拟任务（DEV SIMULATION），` +
          `用于在正式桌面资源就绪前测试启动动画，接入真实资源后应替换。`
        );
      }
      onStatus && onStatus('running', task);
      await this.runWithRetry(task, onProgress, onStatus);
      this.completedWeight += task.weight;
      this.currentFraction = 0;
      this.currentIndex++;
      onProgress && onProgress(this.progress);
    }
    this.done = true;
    onStatus && onStatus('done', null);
  }

  async runWithRetry(task, onProgress, onStatus) {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        await task.run((fraction) => {
          this.currentFraction = Math.min(1, Math.max(0, fraction));
          onProgress && onProgress(this.progress);
        });
        return;
      } catch (err) {
        console.warn(`[boot] 任务 "${task.id}" 第 ${attempt} 次尝试失败：`, err);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BACKOFF_BASE_MS * attempt);
        } else {
          // 进入错误状态：不前进、不报 100%，持续退避重试
          onStatus && onStatus('error', task);
          await sleep(ERROR_RETRY_MS);
          attempt = 0;
          onStatus && onStatus('running', task);
        }
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
