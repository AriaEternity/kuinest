import { RunModel, STORY_DISTANCE } from './run-model.js';
import { RunRenderer, loadRunAssets } from './run-renderer.js';
import { gameViewport } from './viewport.js';
const RECORD_KEY='xiaokui-run-record-v3';
const MODES={story:'归途闯关',endless:'无尽挑战'};
function readRecords() {
  try{
    const value=JSON.parse(localStorage.getItem(RECORD_KEY)||'null');
    const valid=n=>Number.isSafeInteger(n)&&n>=0&&n<10000000;
    return value?.version===3?{story:valid(value.story)?value.story:0,endless:valid(value.endless)?value.endless:0}:{story:0,endless:0};
  }catch{return {story:0,endless:0};}
}
export class RunView {
  constructor(container) {
    this.container=container;this.model=new RunModel();this.records=readRecords();this.mode='story';this.sound=false;
    this.helpRequired=true;this.visible=true;this.destroyed=false;this.last=0;this.accumulator=0;this.lastHUD=0;this.toastUntil=0;
    this.abort=new AbortController();const options={signal:this.abort.signal};
    container.classList.add('run-content');
    container.innerHTML=`<div class="run-app">
      <div class="run-top"><div><span class="run-eyebrow">XIAOKUI GAME · FINAL</span><h1>小葵快跑<span>樱花归途</span></h1></div><div class="run-best"><span data-record-label>归途 · 本机最好</span><strong data-best>00000</strong></div></div>
      <p class="run-rotate-note" data-rotate hidden>手机推荐横屏游玩。将手机横过来，游戏窗口会自动调整。</p>
      <div class="run-stage"><canvas tabindex="0" aria-label="小葵快跑，空格或上方向键跳跃，地面障碍跳过，灯笼从下方跑过，P暂停"></canvas>
        <div class="run-hud" aria-hidden="true"><span>路程 <b data-distance>0</b> m</span><span>樱花 <b data-flowers>0</b></span><strong data-score>00000</strong></div>
        <div class="run-progress" aria-hidden="true"><div><span data-level>01 · 樱花小径</span><span data-target>终点 1200 m</span></div><div class="run-progress-track"><i data-progress></i></div></div>
        <div class="run-toast" data-toast hidden></div>
        <div class="run-overlay"><div class="run-card"><span class="run-card-label">SAKURA WAY HOME</span><h2 data-heading>小葵，出发啦。</h2><p data-description>带着樱花，跑回亮灯的小屋。</p>
          <div class="run-modes" data-modes role="group" aria-label="选择玩法"><button data-mode="story" aria-pressed="true">归途闯关<span>1200 m 到家</span></button><button data-mode="endless" aria-pressed="false">无尽挑战<span>挑战最好成绩</span></button></div>
          <button class="run-primary" data-start disabled>正在准备小葵…</button><span class="run-card-tip" data-tip>地面障碍跳过 · 灯笼从下方跑过</span></div></div>
      </div>
      <div class="run-strip" aria-hidden="true"><span data-combo>连收 0 · ×1</span><span data-power>护盾 — · 吸引 —</span></div>
      <div class="run-controls"><button class="run-jump" data-jump disabled>跳跃 <span>SPACE / ↑</span></button><button data-pause disabled>暂停</button><button data-sound aria-pressed="false">音效：关</button><button data-help>玩法</button></div>
      <div class="run-footer"><span data-state role="status" aria-live="polite">正在加载游戏素材。</span><span>空格 / ↑ 跳跃 · P 暂停</span></div>
      <details class="run-guide"><summary>本局小目标与玩法</summary><div class="run-missions" data-missions></div><p>速度随路程连续提升，六阶段的速度上限为200 / 350 / 500 / 650 / 800 / 1000。前五段不变；无尽挑战1200米后进入第六段，1600米达到1000。连续收集5朵、10朵樱花后加分倍率变为 ×2、×3，漏掉樱花会重置连收。蓝色护盾挡一次碰撞，金色吸引持续6秒。到家奖励300分。</p></details>
      <p class="run-local-note">两种玩法分别记录成绩，仅保存在当前浏览器。点击画面也能跳跃；切到后台自动暂停。</p>
    </div>
    <div class="run-help-layer" hidden><section class="run-help-dialog" role="dialog" aria-labelledby="run-help-title"><div class="run-help-body" tabindex="0" aria-label="玩法说明内容"><span class="run-card-label">HOW TO PLAY</span><h2 id="run-help-title">小葵快跑 · 玩法</h2>
        <ul><li>跳过地面障碍，灯笼直接从下方跑过。</li><li>连收樱花加分；护盾挡一次，吸引持续6秒。</li><li>归途1200米到家；无尽挑战有六阶段，最高1000速。</li></ul>
        <p>电脑：空格 / ↑ 跳跃，P 暂停。<br>手机：点击画面或跳跃按钮。</p>
        <p class="run-help-mobile" data-help-mobile hidden><b>手机推荐横屏游玩。</b><br>横过来后窗口会自动铺满可用屏幕；如果没有转屏，请先关闭系统的方向锁定。</p>
        </div><button class="run-primary" data-help-close>知道啦，准备出发</button>
      </section>
    </div>`;
    this.root=container.querySelector('.run-app');this.stage=this.root.querySelector('.run-stage');
    this.canvas=this.root.querySelector('canvas');this.overlay=this.root.querySelector('.run-overlay');
    this.helpLayer=container.querySelector('.run-help-layer');
    this.dialog=this.helpLayer.querySelector('.run-help-dialog');
    this.rotateNote=this.root.querySelector('[data-rotate]');
    this.ui=Object.fromEntries(['best','record-label','distance','flowers','score','heading','description','start','tip','jump','pause','sound','state','level','target','progress','combo','power','toast','missions','modes'].map(k=>[k,this.root.querySelector(`[data-${k}]`)]));
    this.updateHUD();
    this.root.querySelector('[data-help]').addEventListener('click',()=>this.showHelp(),options);
    this.helpLayer.querySelector('[data-help-close]').addEventListener('click',()=>this.dismissHelp(),options);
    this.helpLayer.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.dismissHelp();return;}
      if(e.key==='Tab'){
        const first=this.dialog.querySelector('.run-help-body'),last=this.dialog.querySelector('[data-help-close]');
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    },options);
    this.onViewport=()=>this.updateDisplayMode();
    window.addEventListener('resize',this.onViewport,options);
    window.visualViewport?.addEventListener('resize',this.onViewport,options);
    this.updateDisplayMode();
    queueMicrotask(()=>{if(!this.destroyed&&this.dialog.isConnected)this.showHelp();});
    for(const button of this.root.querySelectorAll('[data-mode]'))button.addEventListener('click',()=>this.selectMode(button.dataset.mode),options);
    this.ui.start.addEventListener('click',()=>this.startOrResume(),options);
    this.ui.jump.addEventListener('click',()=>{this.action();this.canvas.focus({preventScroll:true});},options);
    this.ui.pause.addEventListener('click',()=>{this.togglePause();this.canvas.focus({preventScroll:true});},options);
    this.ui.sound.addEventListener('click',()=>{
      this.sound=!this.sound;this.ui.sound.textContent=this.sound?'音效：开':'音效：关';this.ui.sound.setAttribute('aria-pressed',String(this.sound));if(this.sound)this.unlockAudio();
    },options);
    this.canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();this.canvas.focus({preventScroll:true});this.action();},options);
    this.root.addEventListener('keydown',e=>{
      if(this.helpRequired||!this.visible||e.altKey||e.ctrlKey||e.metaKey||e.repeat)return;
      if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;
      if(e.code==='KeyP'||e.code==='Escape'){e.preventDefault();this.togglePause();}
      else if(['Space','ArrowUp','KeyW'].includes(e.code)&&e.target.tagName!=='BUTTON'){e.preventDefault();this.action();}
    },options);
    document.addEventListener('visibilitychange',()=>this.pageVisibility(),options);
    window.addEventListener('blur',()=>this.autoPause('离开窗口时已暂停。'),options);
    window.addEventListener('pagehide',()=>this.autoPause('已暂停。'),options);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.stage);this.load();
  }
  async load() {
    try{
      const assets=await loadRunAssets();if(this.destroyed)return;
      this.renderer=new RunRenderer(this.canvas,assets,{reducedMotion:window.matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.hasAttribute('data-reduced-motion')});
      this.resize();this.ui.start.disabled=false;this.ui.jump.disabled=false;this.ui.start.textContent='开始快跑 →';this.ui.state.textContent='准备好就出发。';this.schedule();
    }catch(error){if(this.destroyed)return;this.ui.heading.textContent='小葵还没准备好';this.ui.description.textContent=error.message;this.ui.start.disabled=false;this.ui.start.textContent='重新加载';this.failed=true;this.ui.state.textContent='素材加载失败。';}
  }
  updateDisplayMode() {
    const {handheld,landscape}=gameViewport();
    this.root.classList.toggle('compact-landscape',landscape);
    this.rotateNote.hidden=!handheld||landscape;
    this.helpLayer.querySelector('[data-help-mobile]').hidden=!handheld;
  }
  showHelp() {
    this.autoPause('阅读玩法时已暂停。');this.helpRequired=true;
    if(this.helpLayer.hidden){this.helpScrollTop=this.container.scrollTop;this.container.scrollTop=0;}
    this.container.classList.add('run-help-open');this.root.inert=true;this.helpLayer.hidden=false;
    this.helpLayer.querySelector('[data-help-close]').focus({preventScroll:true});
  }
  dismissHelp() {
    this.helpLayer.hidden=true;this.root.inert=false;this.container.classList.remove('run-help-open');this.helpRequired=false;
    this.container.scrollTop=this.helpScrollTop||0;
    if(this.visible)(this.ui.start.disabled?this.canvas:this.ui.start).focus({preventScroll:true});
  }
  selectMode(mode) {
    if(!['ready','over','won'].includes(this.model.status)||!(mode in MODES))return;
    this.mode=mode;
    this.ui.description.textContent=this.model.status==='ready'?(mode==='story'?'带着樱花，跑回亮灯的小屋。':'路没有尽头，再跑远一点。'):'已选择新玩法，准备好就再跑一程。';
    this.updateHUD();
  }
  resize() {
    const {width,height}=this.stage.getBoundingClientRect();if(!width||!height||!this.renderer)return;
    const previousX=this.model.playerX,previousWidth=this.model.width;
    this.renderer.resize(width,height);this.model.width=this.renderer.width;
    if(previousWidth!==this.model.width){
      const dx=this.model.playerX-previousX;for(const obstacle of this.model.obstacles)obstacle.x+=dx;for(const pickup of this.model.pickups)pickup.x+=dx;
      this.autoPause('窗口尺寸变化，已暂停。');
    }this.renderer.draw(this.model,this.model.elapsed);
  }
  action() {if(this.helpRequired||!this.renderer)return;if(this.model.status==='running')this.model.jump();else this.startOrResume();}
  startOrResume() {
    if(this.helpRequired)return;
    if(this.failed){this.failed=false;this.ui.start.disabled=true;this.ui.start.textContent='重新加载中…';this.load();return;}
    if(!this.renderer)return;if(this.sound)this.unlockAudio();
    if(this.model.status==='paused')this.model.resume();
    else{this.model.start({mode:this.mode});this.renderer.particles=[];this.renderer.labels=[];this.toastUntil=0;this.ui.toast.hidden=true;}
    this.last=0;this.accumulator=0;this.updateOverlay();this.canvas.focus({preventScroll:true});this.schedule();
  }
  togglePause() {
    if(this.helpRequired)return;
    if(this.model.status==='running')this.model.pause();else if(this.model.status==='paused')this.model.resume();else return;
    this.last=0;this.accumulator=0;this.updateOverlay();this.schedule();
  }
  autoPause(message) {if(this.model.status!=='running')return;this.model.pause('hidden');this.updateOverlay();this.ui.state.textContent=message;}
  pageVisibility() {
    if(document.hidden){this.autoPause('切到后台时已暂停。');cancelAnimationFrame(this.frame);this.frame=0;}else{this.last=0;this.schedule();}
  }
  setVisible(visible) {
    if(this.visible===visible)return;this.visible=visible;
    if(!visible){this.autoPause('切换窗口时已暂停。');cancelAnimationFrame(this.frame);this.frame=0;}else{this.last=0;this.resize();this.schedule();}
  }
  schedule() {if(!this.frame&&this.renderer&&this.visible&&!document.hidden&&!this.destroyed)this.frame=requestAnimationFrame(t=>this.tick(t));}
  showToast(text) {this.ui.toast.textContent=text;this.ui.toast.hidden=false;this.toastUntil=this.model.elapsed+2;this.ui.state.textContent=text;}
  tick(now) {
    this.frame=0;if(this.destroyed||!this.visible||document.hidden)return;
    let dt=this.last?(now-this.last)/1000:0;this.last=now;
    if(dt>.25){this.autoPause('画面暂时中断，已为你暂停。');dt=0;}
    this.accumulator+=Math.min(dt,.1);while(this.accumulator>=1/120){this.model.update(1/120);this.accumulator-=1/120;}
    for(const event of this.model.drainEvents()){
      if(event.type==='flower'){this.renderer.flowerEvent(event);this.tone(750+this.model.multiplier*110,.06);}
      else if(event.type==='jump')this.tone(420,.09);
      else if(event.type==='stage'){this.showToast(`第${event.level}程 · ${event.name}`);this.tone(620,.13);}
      else if(event.type==='shield'){this.showToast('护盾就绪 · 可以抵挡一次碰撞');this.tone(940,.12);}
      else if(event.type==='magnet'){this.showToast('樱花吸引 · 持续6秒');this.tone(1040,.12);}
      else if(event.type==='protect'){this.showToast('护盾挡住了！继续跑。');this.tone(280,.12);}
      else if(event.type==='mission'){this.showToast(`${event.label} ✓ +${event.reward}分`);this.tone(1120,.12);}
      else if(event.type==='over'||event.type==='won'){this.tone(event.type==='won'?940:170,.18);this.record();this.updateOverlay();}
    }
    if(this.toastUntil&&this.model.elapsed>this.toastUntil){this.ui.toast.hidden=true;this.toastUntil=0;if(this.model.status==='running')this.ui.state.textContent=this.hint();}
    const visualTime=this.model.status==='ready'?now/1000:this.model.elapsed;
    this.renderer.draw(this.model,visualTime,this.model.status==='running'?dt:0);
    if(now-this.lastHUD>100){this.lastHUD=now;this.updateHUD();}
    if(this.model.status==='running'||(this.model.status==='ready'&&!this.renderer.reducedMotion))this.schedule();
  }
  hint() {return this.model.level>=2?'地面障碍跳过，灯笼直接从下方跑过。':'跳过障碍，连收樱花会加分。';}
  record() {
    const mode=this.model.mode;if(this.model.score<=this.records[mode])return;this.records[mode]=this.model.score;
    try{localStorage.setItem(RECORD_KEY,JSON.stringify({version:3,...this.records}));}catch{this.storageFailed=true;}
  }
  updateHUD() {
    const m=this.model;
    this.ui.best.textContent=String(this.records[this.mode]).padStart(5,'0');this.ui['record-label'].textContent=`${this.mode==='story'?'归途':'无尽'} · 本机最好`;
    this.ui.distance.textContent=String(Math.floor(m.distance));this.ui.flowers.textContent=String(m.flowers);this.ui.score.textContent=String(m.score).padStart(5,'0');
    this.ui.level.textContent=`0${m.level+1} · ${m.stageName}`;this.ui.target.textContent=this.mode==='story'?`速度 ${Math.round(m.speed)} · 终点 ${STORY_DISTANCE} m`:`速度 ${Math.round(m.speed)}`;
    this.ui.progress.style.width=`${(this.mode==='story'?Math.min(1,m.distance/STORY_DISTANCE):m.stageProgress)*100}%`;
    this.ui.combo.textContent=`连收 ${m.combo} · ×${m.multiplier}`;this.ui.combo.dataset.active=String(m.multiplier>1);
    this.ui.power.textContent=`护盾 ${m.shield?'就绪':'—'} · 吸引 ${m.magnetTime>0?`${Math.ceil(m.magnetTime)}s`:'—'}`;
    // 全部来自固定规则与数值；不接收聊天内容或后端数据。
    this.ui.missions.replaceChildren(...m.missions.map(mission=>{
      const item=document.createElement('span');item.textContent=`${mission.done?'✓':'◇'} ${mission.label} ${Math.min(mission.value,mission.target)}/${mission.target} · +${mission.reward}`;
      if(mission.done)item.className='done';return item;
    }));
    for(const button of this.root.querySelectorAll('[data-mode]'))button.setAttribute('aria-pressed',String(button.dataset.mode===this.mode));
  }
  updateOverlay() {
    const state=this.model.status,terminal=['over','won'].includes(state);
    this.overlay.hidden=state==='running';this.ui.toast.hidden=true;this.toastUntil=0;
    this.ui.pause.disabled=!['running','paused'].includes(state);this.ui.pause.textContent=state==='paused'?'继续':'暂停';
    this.ui.jump.textContent=state==='running'?'跳跃 ↑':state==='paused'?'继续快跑':'开始快跑';this.ui.modes.hidden=['running','paused'].includes(state);this.updateHUD();
    if(state==='paused'){
      this.ui.heading.textContent='歇一小会儿。';this.ui.description.textContent='路还在这里，准备好再继续。';this.ui.start.textContent='继续快跑 →';
      this.ui.tip.textContent='点击继续或按 P，回到刚才的位置。';this.ui.state.textContent='游戏已暂停。';
    }else if(terminal){
      this.ui.heading.textContent=state==='won'?'到家啦，小葵。':'这一程，跑得不错。';
      this.ui.description.textContent=`${Math.floor(this.model.distance)} m · ${this.model.flowers}朵樱花 · ${this.model.score}分`;
      this.ui.start.textContent=state==='won'?'再出发一次 →':'再跑一程 →';
      this.ui.tip.textContent=this.storageFailed?'浏览器未允许保存，最好成绩仅在本次窗口保留。':`最高连收 ${this.model.maxCombo} · 小目标 ${this.model.completed.size}/3${state==='won'?' · 到家奖励 +300':''}`;
      this.ui.state.textContent=state==='won'?`已完成归途，本次 ${this.model.score} 分。`:`本次 ${this.model.score} 分，准备好可以再试一次。`;
    }else if(state==='running')this.ui.state.textContent=this.hint();
  }
  unlockAudio() {
    try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;this.audio||=new Audio();this.audio.resume().catch(()=>{});}catch{/* 音频不可用不影响游戏。 */}
  }
  tone(frequency,duration) {
    if(!this.sound||!this.audio||this.audio.state!=='running')return;
    const start=this.audio.currentTime,osc=this.audio.createOscillator(),gain=this.audio.createGain();
    osc.type='triangle';osc.frequency.setValueAtTime(frequency,start);osc.frequency.exponentialRampToValueAtTime(frequency*.65,start+duration);
    gain.gain.setValueAtTime(.035,start);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);osc.connect(gain);gain.connect(this.audio.destination);osc.start(start);osc.stop(start+duration);
    osc.onended=()=>{osc.disconnect();gain.disconnect();};
  }
  destroy() {this.destroyed=true;this.helpLayer.hidden=true;this.root.inert=false;this.container.classList.remove('run-help-open');this.abort.abort();cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();this.audio?.close().catch(()=>{});this.container.classList.remove('run-content');}
}
