// 纯前端跑酷规则：难度按路程增长，固定步长物理与画面帧率分离。
export const GROUND=312;
export const GRAVITY=1800;
export const JUMP_SPEED=620;
export const STORY_DISTANCE=1200;
export const START_SPEED=150;
export const STAGES=[
  {at:0,name:'樱花小径',maxSpeed:200,gap:2.05},
  {at:150,name:'林间晚风',maxSpeed:350,gap:1.8},
  {at:350,name:'灯火远眺',maxSpeed:500,gap:1.6},
  {at:650,name:'星夜归途',maxSpeed:650,gap:1.42},
  {at:1000,name:'花雨挑战',maxSpeed:800,gap:1.27},
  {at:1200,end:1600,name:'月下疾行',maxSpeed:1000,gap:1.27},
];
export const OBSTACLES=[
  {type:'stone',width:32,height:26},
  {type:'stump',width:34,height:40},
  {type:'mushroom',width:30,height:33},
];
export function overlaps(a,b){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
export function difficultyAt(distance) {
  let level=0;for(let i=1;i<STAGES.length;i++)if(distance>=STAGES[i].at)level=i;
  const stage=STAGES[level],next=STAGES[level+1];
  const end=next?.at||stage.end||STORY_DISTANCE;
  const progress=Math.min(1,Math.max(0,(distance-stage.at)/(end-stage.at)));
  const startSpeed=level===0?START_SPEED:STAGES[level-1].maxSpeed;
  // 每个数字是阶段上限；前五段不变，第六段1200—1600m从800连续升至1000。
  return {level,stage,progress,speed:startSpeed+(stage.maxSpeed-startSpeed)*progress};
}
export class RunModel {
  constructor({width=800,random=Math.random}={}){this.width=width;this.random=random;this.mode='story';this.status='ready';this.reset();}
  reset(){
    this.elapsed=0;this.distance=0;this.score=0;this.flowers=0;this.flowerPoints=0;this.bonus=0;
    this.speed=START_SPEED;this.level=0;this.stageProgress=0;this.y=0;this.vy=0;this.jumpBuffer=0;this.landTime=0;this.jumps=0;
    this.obstacles=[];this.pickups=[];this.events=[];this.spawnIn=.9;this.spawnCount=0;this.gait=0;this.reason='';
    this.combo=0;this.maxCombo=0;this.shield=0;this.invulnerable=0;this.magnetTime=0;this.shieldHits=0;this.passed=0;
    this.completed=new Set();
  }
  get playerX(){return this.width<650?115:180;}
  get playerBox(){return {x:this.playerX-12,y:GROUND-this.y-85,width:27,height:81};}
  get multiplier(){return Math.min(3,1+Math.floor(this.combo/5));}
  get missions(){return [
    {id:'flowers',label:'收集15朵樱花',value:this.flowers,target:15,reward:100},
    {id:'obstacles',label:'通过20个障碍',value:this.passed,target:20,reward:150},
    {id:'distance',label:'走过500米',value:Math.floor(this.distance),target:500,reward:150},
  ].map(m=>({...m,done:this.completed.has(m.id)}));}
  get stageName(){return STAGES[this.level].name;}
  start({mode='story'}={}){this.mode=mode==='endless'?'endless':'story';this.reset();this.status='running';}
  pause(reason='manual'){if(this.status==='running'){this.status='paused';this.reason=reason;this.jumpBuffer=0;}}
  resume(){if(this.status==='paused'){this.status='running';this.reason='';}}
  jump(){if(this.status==='running')this.jumpBuffer=.11;}
  spawn(){
    const roll=this.random(),base=this.width+48,level=this.level;
    let pattern;
    if(level>=2&&roll<.22){pattern=[{type:'lantern',width:28,height:30,y:GROUND-170}];}
    else if(level>=1&&roll<(level>=3?.56:.4)){
      pattern=[{type:'stone',width:26,height:27,offset:0},{type:level>=3?'crate':'mushroom',width:30,height:level>=3?42:33,offset:46}];
    }else if(level>=3&&roll>.79){pattern=[{type:'log',width:62,height:36}];}
    else if(level>=2&&roll>.62){pattern=[{type:'crate',width:40,height:45}];}
    else {pattern=[{...OBSTACLES[Math.min(OBSTACLES.length-1,Math.floor(this.random()*OBSTACLES.length))]}];}
    const width=Math.max(...pattern.map(o=>(o.offset||0)+o.width));
    for(const o of pattern)this.obstacles.push({...o,x:base+(o.offset||0),passed:false,hit:false});
    const low=pattern[0].type==='lantern';
    // 每组只有一种通过策略；空中灯笼下面留足站立空间，不叠地面障碍。
    const points=low?[[5,42],[29,42],[53,42]]:[[4,102],[27,118],[50,105]];
    for(const [offset,height] of points)this.pickups.push({kind:'flower',x:base+offset,y:GROUND-height,phase:this.random()*Math.PI*2,collected:false});
    this.spawnCount++;
    if(this.spawnCount%5===0){
      const kind=this.spawnCount%10===0?'magnet':'shield';
      this.pickups.push({kind,x:base+24,y:GROUND-(low?60:145),phase:0,collected:false});
    }
    this.spawnIn=Math.max(STAGES[level].gap,.94+width/this.speed)+this.random()*.24;
  }
  collect(pickup){
    if(pickup.collected)return;pickup.collected=true;
    if(pickup.kind==='shield'){this.shield=1;this.events.push({type:'shield'});}
    else if(pickup.kind==='magnet'){this.magnetTime=6;this.events.push({type:'magnet'});}
    else {
      this.flowers++;this.combo++;this.maxCombo=Math.max(this.maxCombo,this.combo);
      const points=10*this.multiplier;this.flowerPoints+=points;
      this.events.push({type:'flower',x:pickup.x,y:pickup.y,points});
    }
  }
  update(dt){
    if(this.status!=='running')return;dt=Math.max(0,Math.min(dt,1/60));
    this.elapsed+=dt;const difficulty=difficultyAt(this.distance);
    if(difficulty.level!==this.level){this.level=difficulty.level;this.events.push({type:'stage',name:difficulty.stage.name,level:this.level+1});}
    this.stageProgress=difficulty.progress;this.speed=difficulty.speed;
    this.distance+=this.speed*dt/12;// 道路提速不把八帧跑步播放到48fps，限制为20fps以保留已确认的跑步观感。
    this.gait+=dt*Math.min(this.speed/STAGES[0].maxSpeed,20/12)*2.6;
    this.invulnerable=Math.max(0,this.invulnerable-dt);this.magnetTime=Math.max(0,this.magnetTime-dt);
    this.jumpBuffer=Math.max(0,this.jumpBuffer-dt);this.landTime=Math.max(0,this.landTime-dt);
    if(this.jumpBuffer>0&&this.y===0){this.vy=JUMP_SPEED;this.jumpBuffer=0;this.landTime=0;this.jumps++;this.events.push({type:'jump'});}
    if(this.y>0||this.vy>0){this.vy-=GRAVITY*dt;this.y+=this.vy*dt;if(this.y<=0){this.y=0;this.vy=0;this.landTime=.1;this.events.push({type:'land'});}}
    this.spawnIn-=dt;if(this.spawnIn<=0)this.spawn();
    for(const obstacle of this.obstacles){
      obstacle.x-=this.speed*dt;
      const box={x:obstacle.x+4,y:(obstacle.y??(GROUND-obstacle.height))+4,width:obstacle.width-8,height:obstacle.height-5};
      if(!obstacle.hit&&overlaps(this.playerBox,box)){
        if(this.invulnerable>0){obstacle.hit=true;}
        else if(this.shield){this.shield=0;this.invulnerable=1.1;this.shieldHits++;this.combo=0;obstacle.hit=true;this.events.push({type:'protect'});}
        else {this.status='over';this.events.push({type:'over'});break;}
      }
      if(!obstacle.passed&&obstacle.x+obstacle.width<this.playerX-12){obstacle.passed=true;this.passed++;this.events.push({type:'pass'});}
    }
    if(this.status!=='running'){this.updateScore();return;}
    const player=this.playerBox,center={x:this.playerX,y:GROUND-this.y-43};
    for(const pickup of this.pickups){
      pickup.x-=this.speed*dt;
      const magnet=this.magnetTime>0&&Math.hypot(pickup.x-center.x,pickup.y-center.y)<90&&pickup.kind==='flower';
      if(!pickup.collected&&(magnet||overlaps(player,{x:pickup.x-9,y:pickup.y-9,width:18,height:18})))this.collect(pickup);
      if(!pickup.collected&&pickup.kind==='flower'&&pickup.x+9<player.x&&!pickup.missed){pickup.missed=true;this.combo=0;}
    }
    this.obstacles=this.obstacles.filter(o=>o.x>-100);this.pickups=this.pickups.filter(p=>!p.collected&&p.x>-45);
    for(const mission of this.missions)if(!mission.done&&mission.value>=mission.target){this.completed.add(mission.id);this.bonus+=mission.reward;this.events.push({type:'mission',label:mission.label,reward:mission.reward});}
    this.updateScore();
    if(this.mode==='story'&&this.distance>=STORY_DISTANCE){this.distance=STORY_DISTANCE;this.bonus+=300;this.updateScore();this.status='won';this.events.push({type:'won'});}
  }
  updateScore(){this.score=Math.floor(this.distance)+this.flowerPoints+this.bonus;}
  drainEvents(){const events=this.events;this.events=[];return events;}
}
