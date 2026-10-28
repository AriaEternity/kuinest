import { GROUND, STORY_DISTANCE } from './run-model.js';
const TAU=Math.PI*2;
const FILES={runAtlas:'run-frames-v2/run-atlas.png',background:'dusk.png',takeoff:'jump-01-takeoff.png',rise:'jump-02-rise.png',apex:'jump-03-apex.png',fall:'jump-04-fall.png',land:'jump-05-land.png'};
export async function loadRunAssets() {
  const root=new URL('../../assets/games/xiaokui-run/',import.meta.url);
  const entries=await Promise.all(Object.entries(FILES).map(async([key,file])=>{
    const image=new Image();
    const loaded=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('游戏素材未能加载，请重试。'));});
    image.src=new URL(file,root).href;await loaded;return [key,image];
  }));return Object.fromEntries(entries);
}
function block(ctx,x,y,w,h,color) {ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));}
export class RunRenderer {
  constructor(canvas,assets,{reducedMotion=false}={}) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.assets=assets;
    this.reducedMotion=reducedMotion;this.width=800;this.height=400;this.particles=[];this.labels=[];
  }
  resize(cssWidth,cssHeight) {
    // 随画面的实际比例选择世界宽度，窄窗口与手机不会拉扁小葵。
    this.height=400;this.width=Math.max(320,Math.round(cssWidth/cssHeight*this.height));
    const dpr=Math.min(window.devicePixelRatio||1,2);
    this.canvas.width=Math.round(cssWidth*dpr);this.canvas.height=Math.round(cssHeight*dpr);
  }
  flowerEvent(event) {
    if(this.reducedMotion)return;
    for(let i=0;i<8;i++)this.particles.push({x:event.x,y:event.y,vx:Math.cos(i*TAU/8)*55,vy:Math.sin(i*TAU/8)*55,life:.45});
    this.labels.push({x:event.x,y:event.y-14,text:`+${event.points}`,life:.65});
  }
  draw(model,time,dt=0) {
    const ctx=this.ctx,W=this.width,H=this.height;
    ctx.setTransform(this.canvas.width/W,0,0,this.canvas.height/H,0,0);ctx.imageSmoothingEnabled=false;
    const bg=this.assets.background,srcH=bg.height,srcW=srcH*W/H,sx=(bg.width-srcW)/2;
    ctx.drawImage(bg,Math.max(0,sx),0,Math.min(bg.width,srcW),srcH,0,0,W,H);
    if(model.level>0){ctx.fillStyle=`rgba(19,13,46,${model.level*.045})`;ctx.fillRect(0,0,W,GROUND);}
    if(model.level>=2)for(let i=0;i<12;i++)block(ctx,(i*97+41)%W,70+(i*43)%100,2,2,'#fff0c4aa');
    block(ctx,0,GROUND-2,W,4,'#ce9ab0');block(ctx,0,GROUND+2,W,16,'#9d6d91');
    const scroll=model.distance*12;
    for(let i=-1;i<W/70+2;i++){
      const x=i*70-scroll%70;block(ctx,x,GROUND+6,48,2,'#d9a1b8');block(ctx,x+25,GROUND+8,2,9,'#694d74');block(ctx,x+7,GROUND+12,12,2,'#bd8ba7');
    }
    if(!this.reducedMotion)this.petals(ctx,time,W);
    if(model.mode==='story'&&model.distance>STORY_DISTANCE-65)this.house(ctx,model.playerX+(STORY_DISTANCE-model.distance)*12);
    for(const pickup of model.pickups){
      const y=pickup.y+Math.sin(time*3+pickup.phase)*3;
      if(pickup.kind==='shield'||pickup.kind==='magnet')this.power(ctx,pickup.x,y,pickup.kind);else this.flower(ctx,pickup.x,y);
    }
    for(const obstacle of model.obstacles)this.obstacle(ctx,obstacle);
    ctx.fillStyle='#34213877';ctx.beginPath();ctx.ellipse(model.playerX,GROUND+2,22-Math.min(model.y*.08,10),4,0,0,TAU);ctx.fill();
    if(model.shield||model.invulnerable>0||model.magnetTime>0){
      ctx.save();ctx.strokeStyle=model.shield||model.invulnerable>0?'#b5f4f1':'#ffd39b';ctx.lineWidth=2;
      ctx.setLineDash(model.magnetTime>0&&!model.shield?[5,5]:[]);ctx.beginPath();ctx.ellipse(model.playerX-12,GROUND-model.y-62,48,64,0,0,TAU);ctx.stroke();ctx.restore();
    }
    ctx.save();if(!this.reducedMotion&&model.invulnerable>0&&Math.floor(time*12)%2)ctx.globalAlpha=.5;
    if(model.y>0||model.landTime>0)this.jumpCharacter(ctx,model);
    else this.runner(ctx,model.playerX,GROUND,model.status==='ready'?time*2.6:model.gait,['over','won'].includes(model.status));
    ctx.restore();
    for(const p of this.particles){p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;ctx.globalAlpha=Math.max(0,p.life*2);this.flower(ctx,p.x,p.y,.35);}
    ctx.globalAlpha=1;this.particles=this.particles.filter(p=>p.life>0);
    ctx.font='12px "Fusion Pixel 12px", monospace';ctx.textAlign='center';ctx.fillStyle='#fff1b2';
    for(const label of this.labels){label.life-=dt;label.y-=dt*28;ctx.globalAlpha=Math.min(1,Math.max(0,label.life*3));ctx.fillText(label.text,label.x,label.y);}
    ctx.globalAlpha=1;this.labels=this.labels.filter(p=>p.life>0);
  }
  petals(ctx,time,W) {
    for(let i=0;i<14;i++){
      const x=((i*137-time*(12+i%3*5))%(W+40)+W+40)%(W+40)-20,y=(i*53+time*(9+i%4*3))%285;
      ctx.save();ctx.translate(x,y);ctx.rotate(Math.sin(time+i)*.7);ctx.fillStyle=i%2?'#ffbdd394':'#eb9cbc99';ctx.fillRect(-2,-1,5,3);ctx.restore();
    }
  }
  flower(ctx,x,y,scale=1) {
    ctx.save();ctx.translate(Math.round(x),Math.round(y));ctx.scale(scale,scale);
    ctx.fillStyle='#fff2cc';ctx.fillRect(-3,-9,6,18);ctx.fillRect(-9,-3,18,6);
    ctx.fillStyle='#f7adc9';ctx.fillRect(-6,-6,12,12);ctx.fillStyle='#a76290';ctx.fillRect(-2,-2,4,4);ctx.restore();
  }
  power(ctx,x,y,kind) {
    ctx.save();ctx.translate(Math.round(x),Math.round(y));
    block(ctx,-15,-17,30,34,'#322441');block(ctx,-13,-15,26,30,kind==='shield'?'#c2f3e7':'#ffddad');
    if(kind==='shield'){
      block(ctx,-8,-8,16,14,'#568b94');block(ctx,-5,6,10,3,'#568b94');block(ctx,-2,9,4,3,'#568b94');
      block(ctx,-5,-5,3,8,'#e7ffff');block(ctx,-2,0,7,3,'#e7ffff');
    }else{
      block(ctx,-8,-9,5,16,'#c57593');block(ctx,3,-9,5,16,'#c57593');block(ctx,-5,6,10,5,'#c57593');
      block(ctx,-8,-9,5,4,'#faf4dd');block(ctx,3,-9,5,4,'#faf4dd');
    }ctx.restore();
  }
  obstacle(ctx,o) {
    const x=Math.round(o.x),y=o.y??GROUND-o.height;
    if(o.type==='lantern'){
      block(ctx,x+13,y-48,2,48,'#a68199');block(ctx,x+7,y-4,14,5,'#533849');
      block(ctx,x+3,y,o.width-6,o.height,'#9b526d');block(ctx,x,y+7,o.width,o.height-14,'#d88a9e');
      block(ctx,x+7,y+3,o.width-14,o.height-6,'#f3c29d');block(ctx,x+12,y+3,3,o.height-6,'#ffe9b2');
      block(ctx,x+7,y+o.height-1,14,4,'#533849');block(ctx,x+13,y+o.height+3,2,8,'#d894a7');
      // 下箭头给出直接从灯笼下方通过的视觉提示。
      block(ctx,x+11,y+o.height+18,6,3,'#ffe2ac');block(ctx,x+9,y+o.height+14,10,3,'#ffe2ac');
    }else if(o.type==='stone'){
      block(ctx,x+4,y,o.width-8,o.height,'#393143');block(ctx,x,y+8,o.width,o.height-8,'#393143');
      block(ctx,x+4,y+4,o.width-10,6,'#a09ab4');block(ctx,x+4,y+10,o.width-8,10,'#756e91');block(ctx,x+o.width-10,y+13,6,9,'#4b425d');
    }else if(o.type==='stump'){
      block(ctx,x+5,y+5,o.width-10,o.height-5,'#59374e');block(ctx,x,y+2,o.width,9,'#d398ab');
      block(ctx,x+5,y,o.width-10,4,'#f3b7c4');block(ctx,x+7,y+5,o.width-14,3,'#825165');
      block(ctx,x+10,y+15,3,20,'#af758e');block(ctx,x+23,y+12,3,25,'#7b4c65');
    }else if(o.type==='crate'){
      block(ctx,x,y,o.width,o.height,'#4d344e');block(ctx,x+3,y+3,o.width-6,o.height-6,'#b8889b');
      block(ctx,x+6,y+6,o.width-12,o.height-12,'#806074');block(ctx,x+5,y+Math.floor(o.height/2)-2,o.width-10,4,'#d4a7b5');
      block(ctx,x+Math.floor(o.width/2)-2,y+5,4,o.height-10,'#d4a7b5');
    }else if(o.type==='log'){
      block(ctx,x+5,y,o.width-10,o.height,'#56374d');block(ctx,x,y+5,o.width,o.height-10,'#56374d');
      block(ctx,x+8,y+4,o.width-14,7,'#b87d91');block(ctx,x+13,y+17,o.width-21,4,'#a57088');
      block(ctx,x+o.width-18,y+4,14,o.height-8,'#e2abba');block(ctx,x+o.width-15,y+10,8,o.height-20,'#986179');
    }else{
      block(ctx,x+11,y+15,9,o.height-15,'#f6c9d1');block(ctx,x+3,y+5,o.width-6,13,'#ca759d');
      block(ctx,x+8,y,o.width-16,6,'#e8a0bd');block(ctx,x,y+11,o.width,6,'#a55380');block(ctx,x+6,y+7,4,4,'#fff0e2');block(ctx,x+20,y+10,4,4,'#fff0e2');
    }
  }
  house(ctx,x) {
    x=Math.round(x);const y=GROUND-111;
    block(ctx,x-42,y+26,84,85,'#382638');block(ctx,x-38,y+30,76,81,'#b57f99');
    for(let i=0;i<5;i++)block(ctx,x-50+i*8,y+24-i*6,100-i*16,7,'#623f60');
    block(ctx,x-12,y+61,24,50,'#5e3b55');block(ctx,x-9,y+64,18,47,'#ffe3aa');
    block(ctx,x-31,y+45,14,17,'#ffe3aa');block(ctx,x+17,y+45,14,17,'#ffe3aa');
    block(ctx,x-29,y+52,10,2,'#8e637a');block(ctx,x+19,y+52,10,2,'#8e637a');
    block(ctx,x-46,GROUND-3,92,4,'#e5b4c4');this.flower(ctx,x,y+17,.7);
  }
  runner(ctx,x,ground,cycle,over=false) {
    const size=148;if(over){ctx.drawImage(this.assets.land,x-size*.63,ground-size*.94,size,size);return;}
    // 已确认的八张全身帧共用画布，随道路速度加快；不拆分身体、不插值变形。
    const index=((Math.floor(cycle/2.6*12)%8)+8)%8;
    ctx.drawImage(this.assets.runAtlas,index%4*256,Math.floor(index/4)*256,256,256,x-size*.63,ground-size*.94,size,size);
  }
  jumpCharacter(ctx,model) {
    let image;if(model.landTime>0)image=this.assets.land;
    else if(model.vy>460)image=this.assets.takeoff;else if(model.vy>100)image=this.assets.rise;else if(model.vy>-100)image=this.assets.apex;else image=this.assets.fall;
    const size=148;ctx.drawImage(image,model.playerX-size*.63,GROUND-model.y-size*.94,size,size);
  }
}
