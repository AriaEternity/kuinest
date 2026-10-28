// 横竖屏共用十秒节奏：8.4 秒展示，1.6 秒由同一个 Logo 衔接真实桌面。
export const BOOT_REVEAL_AT=8400;
export const BOOT_REVEAL_DURATION=1600;
const PINK='#f49abd', LIGHT='#ffd4e4', MUTED='#9a849d';
const clamp=x=>Math.max(0,Math.min(1,x));
const ease=x=>1-Math.pow(1-clamp(x),3);
const flowerPath=new Path2D('M-2-8h4v3h3v4h-3v3h-4v-3h-3v-4h3z');

export class BootScene {
  constructor(matrixCanvas,fxCanvas,{reducedMotion=false}={}) {
    this.matrixCanvas=matrixCanvas;this.fxCanvas=fxCanvas;
    this.mctx=matrixCanvas.getContext('2d');this.fctx=fxCanvas.getContext('2d');
    this.root=matrixCanvas.closest('#boot');this.reducedMotion=reducedMotion;
    this.progressTarget=0;this.elapsed=0;this.running=false;this.tiles=[];this.lastStage='';
    this.logo=null;this.logoPromise=null;this.lastRender=-100;
    this.handleResize=this.handleResize.bind(this);this.tick=this.tick.bind(this);
    this.handleVisibility=()=>{if(!document.hidden&&this.running&&!this.reducedMotion){cancelAnimationFrame(this.rafId);this.rafId=requestAnimationFrame(this.tick);}};
  }
  loadAssets() {
    if(this.logo)return Promise.resolve();
    if(this.logoPromise)return this.logoPromise;
    this.logoPromise=new Promise((resolve,reject)=>{
      const image=new Image();image.decoding='async';
      image.onload=()=>{this.logo=image;this.createTiles();this.logoPromise=null;if(this.reducedMotion)this.render();resolve();};
      image.onerror=()=>{this.logoPromise=null;reject(new Error('启动 Logo 加载失败'));};
      image.src=new URL('../assets/xiaokui-logo-v1.png',import.meta.url).href;
    });
    return this.logoPromise;
  }
  createTiles() {
    const sample=document.createElement('canvas');sample.width=180;sample.height=Math.round(180*this.logo.height/this.logo.width);
    const ctx=sample.getContext('2d',{willReadFrequently:true});ctx.drawImage(this.logo,0,0,sample.width,sample.height);
    const data=ctx.getImageData(0,0,sample.width,sample.height).data;
    this.tiles=[];
    for(let y=2;y<sample.height;y+=4)for(let x=2;x<sample.width;x+=4) {
      const at=(y*sample.width+x)*4;if(data[at+3]<100)continue;
      const seed=(x*37+y*71)%997/997;
      this.tiles.push({x:x/sample.width,y:y/sample.height,dx:Math.cos(seed*43)*(.25+seed),dy:Math.sin(seed*37)*(.2+seed*.7),delay:seed*.22,color:`rgba(${data[at]},${data[at+1]},${data[at+2]},${data[at+3]/255})`});
    }
  }
  start(onFrame) {
    if(this.running)return;this.running=true;this.onFrame=onFrame;this.startedAt=performance.now();
    window.addEventListener('resize',this.handleResize);window.visualViewport?.addEventListener('resize',this.handleResize);
    document.addEventListener('visibilitychange',this.handleVisibility);this.layout();this.render();
    if(!this.reducedMotion)this.rafId=requestAnimationFrame(this.tick);
  }
  stop() {
    this.running=false;cancelAnimationFrame(this.rafId);
    clearTimeout(this.captionTimer);
    window.removeEventListener('resize',this.handleResize);window.visualViewport?.removeEventListener('resize',this.handleResize);
    document.removeEventListener('visibilitychange',this.handleVisibility);
  }
  setProgress(value) {this.progressTarget=clamp(value);if(this.reducedMotion)this.render();}
  handleResize() {this.layout();this.render();}
  layout() {
    const bounds=this.root.getBoundingClientRect(),w=bounds.width,h=bounds.height;
    const portrait=h>=w,dpr=Math.min(window.devicePixelRatio||1,2);
    for(const canvas of [this.matrixCanvas,this.fxCanvas]) {canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.getContext('2d').setTransform(dpr,0,0,dpr,0,0);}
    const compact=!portrait&&h<=700;
    const logoWidth=portrait?Math.min(w*.88,650):Math.min(w*.65,h*(compact?1.04:1.23),1000);
    this.metrics={width:w,height:h,portrait,logoWidth,cx:w/2,cy:h*(portrait?.416:compact?.37:.41),radius:portrait?Math.min(w*.365,h*.2):Math.min(h*(compact?.2:.29),w*.23),dpr};
    this.root.dataset.layout=portrait?'portrait':'landscape';
    this.drawBackground();
  }
  tick(now) {
    if(!this.running||document.hidden)return;
    this.rafId=requestAnimationFrame(this.tick);
    if(now-this.lastRender<1000/45)return;
    this.lastRender=now;this.elapsed=(now-this.startedAt)/1000;
    this.onFrame?.();if(this.running)this.render();
  }
  drawBackground() {
    const {width:w,height:h,cx,cy,portrait}=this.metrics,ctx=this.mctx;
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#080810';ctx.fillRect(0,0,w,h);
    const glow=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(w,h)*.62);
    glow.addColorStop(0,'#201329');glow.addColorStop(.6,'#0d0b15');glow.addColorStop(1,'#080810');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
    const step=portrait?32:48;ctx.strokeStyle='#55415b';ctx.globalAlpha=.18;ctx.lineWidth=.6;ctx.beginPath();
    for(let x=w%step/2;x<w;x+=step){ctx.moveTo(x,105);ctx.lineTo(x,h-84);}
    for(let y=118;y<h-84;y+=step){ctx.moveTo(18,y);ctx.lineTo(w-18,y);}ctx.stroke();ctx.globalAlpha=1;
    for(let i=0;i<62;i++){const x=((i*127+47)%997)/997*w,y=112+((i*223+73)%991)/991*Math.max(0,h-210);ctx.globalAlpha=i%9===0?.45:.13;ctx.fillStyle=i%9===0?PINK:'#baa5c1';ctx.fillRect(x,y,i%7===0?2:1,1);}ctx.globalAlpha=1;
    const pad=portrait?17:Math.min(42,w*.035),top=portrait?103:105,bottom=h-84;
    ctx.lineWidth=1;ctx.strokeStyle='#62405c';
    for(let i=0;i<4;i++){const x=i%2===0?pad:w-pad,y=i<2?top:bottom,dx=i%2===0?1:-1,dy=i<2?1:-1;ctx.beginPath();ctx.moveTo(x+dx*16,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy*16);ctx.stroke();ctx.fillStyle=PINK;ctx.fillRect(x-1,y-1,2,2);}
  }
  flower(ctx,x,y,size,alpha=1) {ctx.save();ctx.translate(x,y);ctx.scale(size,size);ctx.globalAlpha*=alpha;ctx.fillStyle=PINK;for(let i=0;i<5;i++){ctx.rotate(Math.PI*2/5);ctx.fill(flowerPath);}ctx.fillStyle=LIGHT;ctx.fillRect(-2,-2,4,4);ctx.restore();}
  arc(ctx,r,start,length,color,width=1) {const {cx,cy}=this.metrics;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.arc(cx,cy,r,start,start+length);ctx.stroke();}
  logoBounds() {
    const box=this.root.getBoundingClientRect(),m=this.metrics;
    const height=m.logoWidth*this.logo.height/this.logo.width;
    return {left:box.left+m.cx-m.logoWidth/2,top:box.top+m.cy-height/2,width:m.logoWidth,height};
  }
  render() {
    if(!this.metrics)return;
    const {width:w,height:h,cx,cy,logoWidth:lw,radius:r,portrait}=this.metrics,ctx=this.fctx;
    const t=this.reducedMotion?7:this.elapsed;
    ctx.clearRect(0,0,w,h);
    const awake=ease((t-.1)/.8);
    if(t<1.4){const alpha=1-ease((t-.85)/.5);this.flower(ctx,cx,cy,portrait?.95:1.4,alpha);ctx.globalAlpha=.7*alpha;ctx.fillStyle=PINK;ctx.font='9px monospace';ctx.textAlign='center';ctx.fillText('S A K U R A  C O R E',cx,cy+34);ctx.globalAlpha=1;}
    const lh=lw*(this.logo?.height||821)/(this.logo?.width||1916),lx=cx-lw/2,ly=cy-lh/2;
    if(this.logo&&t>.65&&t<2.65&&!this.reducedMotion) {
      ctx.globalAlpha=(1-ease((t-2.1)/.5))*.9;
      for(const tile of this.tiles){const p=ease((t-.65-tile.delay)/1.45),inv=1-p;if(p<=0)continue;const size=lw*4/180*(.3+.7*p);ctx.fillStyle=tile.color;ctx.fillRect(lx+tile.x*lw+tile.dx*lw*inv*inv-size/2,ly+tile.y*lh+tile.dy*lw*inv*inv-size/2,size,size);}
      ctx.globalAlpha=1;
    }
    const ring=ease((t-2.05)/.6)*(1-ease((t-6.4)/.6));
    ctx.save();ctx.globalAlpha=ring*.5;
    this.arc(ctx,r,-2.7+t*.13,.9,'#97617e',.7);this.arc(ctx,r,.44+t*.13,.9,'#97617e',.7);
    this.arc(ctx,r+9,-.5-t*.12,.3,PINK,1.2);this.arc(ctx,r+9,2.64-t*.12,.3,PINK,1.2);
    ctx.strokeStyle=PINK;ctx.lineWidth=.7;
    for(let i=0;i<48;i++){const a=i*Math.PI/24,inner=r+(i%4===0?12:15),outer=r+19;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*inner,cy+Math.sin(a)*inner);ctx.lineTo(cx+Math.cos(a)*outer,cy+Math.sin(a)*outer);ctx.stroke();}ctx.restore();
    if(this.logo&&!this.hideLogo&&t>1.2){ctx.save();ctx.globalAlpha=this.reducedMotion?1:ease((t-1.3)/1.12);ctx.drawImage(this.logo,lx,ly,lw,lh);ctx.restore();}
    if(t>2.4&&t<4.4&&!this.reducedMotion){const p=clamp((t-2.4)/1.8),x=lx+lw*p;ctx.save();ctx.globalAlpha=Math.sin(p*Math.PI)*.65;ctx.strokeStyle=PINK;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,ly-9);ctx.lineTo(x,ly+lh+9);ctx.stroke();ctx.restore();}
    ctx.save();ctx.globalAlpha=ease((t-1.9)/.6);ctx.strokeStyle='#815168';ctx.lineWidth=.8;
    const gap=portrait?6:16;
    for(let i=0;i<4;i++){const x=i%2===0?lx-gap:lx+lw+gap,y=i<2?ly-9:ly+lh+9,dx=i%2===0?1:-1,dy=i<2?1:-1;ctx.beginPath();ctx.moveTo(x+dx*20,y);ctx.lineTo(x,y);ctx.lineTo(x,y+dy*12);ctx.stroke();}
    ctx.fillStyle=MUTED;ctx.font=`${portrait?7:9}px monospace`;ctx.textAlign='left';ctx.fillText('IDENTITY / XIAOKUI',lx-gap,ly-20);ctx.textAlign='right';ctx.fillText('PX · 001',lx+lw+gap,ly-20);ctx.restore();
    if(t>6.35&&!this.reducedMotion)for(let i=0;i<7;i++){const p=clamp((t-6.35-i*.06)/1.55),a=i*2.399;this.flower(ctx,cx+Math.cos(a)*(r+28+p*20),cy+Math.sin(a)*(r*.68+p*20),portrait?.22:.32,Math.sin(p*Math.PI)*.55);}
    this.root.style.setProperty('--awakening',awake);
    const waiting=t>=8.4&&this.progressTarget<1;
    const stage=waiting?'waiting':t<2.4?'identity':t<4.4?'interface':t<6.4?'workspace':'welcome';
    if(stage!==this.lastStage) {
      const first=!this.lastStage;this.lastStage=stage;clearTimeout(this.captionTimer);
      const text={identity:['小葵，正在醒来。','SAKURA CORE / AWAKENING','一片樱花，一个新的开始。'],interface:['初始化界面','INITIALIZING INTERFACE','像素正在亮起。'],workspace:['准备工作空间','PREPARING WORKSPACE','为你留好熟悉的位置。'],welcome:['欢迎回来','WELCOME BACK, XIAOKUI','樱花已绽放，开始创造。'],waiting:['正在准备桌面','WAITING FOR RESOURCES','加载完成后自动进入。']}[stage];
      const message=this.root.querySelector('.boot-message');
      const replace=()=>{['.boot-message-title','.boot-message-en','.boot-message-note'].forEach((selector,i)=>{const node=this.root.querySelector(selector);if(node)node.textContent=text[i];});message?.classList.remove('is-changing');};
      if(first||this.reducedMotion||this.instantCaptions)replace();
      else {message?.classList.add('is-changing');this.captionTimer=setTimeout(replace,160);}
    }
  }
}
