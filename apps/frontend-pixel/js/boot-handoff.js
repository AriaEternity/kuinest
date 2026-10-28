// 把已解码的同一张 Logo 从画布位置送到真实桌面位置，避免两张标志交叉重影。
const clamp=value=>Math.max(0,Math.min(1,value));
const smooth=value=>{const p=clamp(value);return p*p*(3-2*p);};
const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
const mix=(a,b,p)=>Object.fromEntries(['left','top','width','height'].map(key=>[key,a[key]+(b[key]-a[key])*p]));

export class BootHandoff {
  constructor({scene,boot,desktop,showDesktop,duration=1600,instant=false}) {
    Object.assign(this,{scene,boot,desktop,showDesktop,duration,instant});
    this.phase=0;this.retargets=0;this.done=false;this.prepared=false;
    this.onResize=this.onResize.bind(this);this.tick=this.tick.bind(this);
    this.completed=new Promise(resolve=>{this.resolve=resolve;});
  }
  async prepare() {
    if(this.prepared)return;this.prepared=true;
    this.wasInert=this.desktop.inert;this.desktop.inert=true;
    this.desktop.setAttribute('data-boot-handoff','');
    this.showDesktop();this.scene.stop();
    this.target=this.desktop.querySelector('.desktop-logo');
    if(this.instant||!this.target||!this.scene.logo) {this.finish(this.instant?'instant':'missing-logo');return;}
    try {await this.target.decode();} catch { /* 同一公开图片已由真实启动任务加载，保留已知几何兜底。 */ }
    this.from=this.scene.logoBounds();this.base={...this.from};this.motionFrom=0;
    this.to=box(this.target);
    if(this.to.width<=0||this.to.height<=0){this.finish('invalid-target');return;}
    // 直接使用画布原先绘制的已解码图片，不再创建第二份可见 Logo。
    this.image=this.scene.logo;this.image.className='boot-handoff-logo';this.image.alt='';
    this.image.setAttribute('aria-hidden','true');this.image.draggable=false;
    this.image.style.width=this.base.width+'px';this.image.style.height=this.base.height+'px';
    this.image.style.filter=getComputedStyle(this.target).filter;
    this.scene.hideLogo=true;this.scene.render();
    this.image.style.transform=`translate3d(${this.from.left}px,${this.from.top}px,0)`;
    document.body.appendChild(this.image);
    this.boot.inert=true;this.boot.classList.add('boot-handoff');
    window.addEventListener('resize',this.onResize);window.visualViewport?.addEventListener('resize',this.onResize);
    this.render(0);
  }
  async start() {
    await this.prepare();if(this.done)return this.completed;
    this.startedAt=performance.now();this.raf=requestAnimationFrame(this.tick);return this.completed;
  }
  tick(now) {
    if(this.done)return;
    try {this.render((now-this.startedAt)/this.duration);if(!this.done)this.raf=requestAnimationFrame(this.tick);}
    catch(error){console.warn('[boot] 页面衔接降级：',error);this.finish('render-fallback');}
  }
  onResize() {this.needsRetarget=true;}
  render(value) {
    if(this.done||!this.image)return;
    const p=clamp(value);
    if(this.needsRetarget) {
      this.needsRetarget=false;this.retargets++;
      const current=box(this.image),limit=Math.min(current.width,innerWidth*.9),ratio=limit/current.width;
      this.from={left:Math.max(0,Math.min(current.left,innerWidth-limit)),top:Math.max(0,Math.min(current.top,innerHeight-current.height*ratio)),width:limit,height:current.height*ratio};
      this.to=box(this.target);this.motionFrom=this.phase;
    }
    this.phase=p;
    const segment=clamp((p-this.motionFrom)/Math.max(.0001,1-this.motionFrom));
    const rect=mix(this.from,this.to,1-Math.pow(1-segment,3));
    this.image.style.transform=`translate3d(${rect.left}px,${rect.top}px,0) scale(${rect.width/this.base.width})`;
    this.scene.matrixCanvas.style.opacity=String(1-smooth(p/.95));
    const ui=smooth((p-.45)/.55);
    this.desktop.style.setProperty('--boot-ui-opacity',String(ui));
    this.desktop.style.setProperty('--boot-ui-offset',`${(1-ui)*4}px`);
    if(p>=1)this.finish('matched');
  }
  finish(reason='matched') {
    if(this.done)return;this.done=true;cancelAnimationFrame(this.raf);
    const moving=this.image?box(this.image):null,target=this.target?box(this.target):null;
    const error=moving&&target?Math.max(...['left','top','width','height'].map(key=>Math.abs(moving[key]-target[key]))):null;
    this.result={reason,matched:error!==null&&error<1,alignmentError:error,retargets:this.retargets,durationMs:this.startedAt?performance.now()-this.startedAt:0};
    // 以下改动在同一帧提交：显示原桌面标志并移除移动标志，不出现双 Logo。
    this.desktop.removeAttribute('data-boot-handoff');this.desktop.inert=this.wasInert;
    this.desktop.style.removeProperty('--boot-ui-opacity');this.desktop.style.removeProperty('--boot-ui-offset');
    this.image?.remove();this.scene.stop();this.boot.remove();
    window.removeEventListener('resize',this.onResize);window.visualViewport?.removeEventListener('resize',this.onResize);
    this.resolve(this.result);
  }
}
