import test from 'node:test';
import assert from 'node:assert/strict';
import { RunModel,GROUND,STORY_DISTANCE,difficultyAt,STAGES,START_SPEED } from '../js/games/run-model.js';
const tick=(model,seconds)=>{for(let i=0;i<Math.round(seconds*120);i++)model.update(1/120);};
const safe=()=>{const m=new RunModel();m.start();m.spawnIn=1000;return m;};
const flower=(x=180,y=GROUND-40)=>({kind:'flower',x,y,phase:0,collected:false});
test('起跳立即响应，空中不能二段跳，随后准确落地',()=>{
  const m=safe();m.jump();m.update(1/120);assert.ok(m.y>0);assert.equal(m.jumps,1);
  m.jump();tick(m,.2);assert.equal(m.jumps,1);tick(m,.6);assert.equal(m.y,0);assert.equal(m.vy,0);
});
test('暂停同时冻结运动、计分、道具和生成计时；恢复原局',()=>{
  const m=safe();m.magnetTime=6;m.invulnerable=1.1;tick(m,.2);m.pause();
  const state=[m.elapsed,m.distance,m.spawnIn,m.score,m.magnetTime,m.invulnerable];tick(m,5);
  assert.deepEqual([m.elapsed,m.distance,m.spawnIn,m.score,m.magnetTime,m.invulnerable],state);m.resume();tick(m,.1);assert.ok(m.distance>state[1]);
});
test('碰撞结束一局；重新开始清理道具、任务、连收和事件',()=>{
  const m=safe();m.obstacles=[{x:m.playerX,type:'stump',width:34,height:40}];m.combo=5;m.magnetTime=6;
  m.update(1/120);assert.equal(m.status,'over');m.start({mode:'endless'});
  assert.equal(m.status,'running');assert.equal(m.mode,'endless');assert.equal(m.score,0);assert.equal(m.combo,0);assert.equal(m.magnetTime,0);assert.equal(m.completed.size,0);assert.deepEqual(m.obstacles,[]);assert.deepEqual(m.events,[]);
});
test('樱花只收一次；5/10连收获得倍率，漏收重置且不回改既得分',()=>{
  const m=safe();const first=flower();m.collect(first);m.collect(first);assert.equal(m.flowers,1);assert.equal(m.flowerPoints,10);
  for(let i=1;i<10;i++)m.collect(flower());assert.equal(m.multiplier,3);assert.equal(m.maxCombo,10);assert.equal(m.flowerPoints,170);
  m.pickups=[flower(m.playerX-30)];m.update(1/120);assert.equal(m.combo,0);assert.equal(m.multiplier,1);assert.equal(m.flowerPoints,170);
});
test('前五阶段不变，新增第六段800→1000且连续封顶',()=>{
  const caps=[200,350,500,650,800,1000];
  assert.deepEqual(STAGES.slice(0,5),[
    {at:0,name:'樱花小径',maxSpeed:200,gap:2.05},
    {at:150,name:'林间晚风',maxSpeed:350,gap:1.8},
    {at:350,name:'灯火远眺',maxSpeed:500,gap:1.6},
    {at:650,name:'星夜归途',maxSpeed:650,gap:1.42},
    {at:1000,name:'花雨挑战',maxSpeed:800,gap:1.27},
  ]);
  for(const [distance,speed] of [[0,150],[75,175],[150,200],[250,275],[350,350],[500,425],[650,500],[825,575],[1000,650],[1100,725],[1200,800]])assert.equal(difficultyAt(distance).speed,speed);
  assert.equal(STORY_DISTANCE,1200);
  assert.equal(difficultyAt(0).speed,START_SPEED);
  for(const [level,stage] of STAGES.entries()){
    const end=STAGES[level+1]?.at||stage.end||STORY_DISTANCE,from=level===0?START_SPEED:caps[level-1];
    assert.equal(stage.maxSpeed,caps[level]);assert.equal(difficultyAt(stage.at).level,level);assert.equal(difficultyAt(stage.at).speed,from);
    assert.equal(difficultyAt((stage.at+end)/2).speed,(from+caps[level])/2);assert.equal(difficultyAt(end).speed,caps[level]);
    assert.ok(Math.abs(difficultyAt(end-.001).speed-difficultyAt(end+.001).speed)<.002);
    for(let d=stage.at;d<end;d++)assert.ok(difficultyAt(d).speed<=caps[level]);
  }
  assert.equal(difficultyAt(1200).level,5);assert.equal(difficultyAt(1400).speed,900);assert.equal(difficultyAt(1600).speed,1000);assert.equal(difficultyAt(100000).speed,1000);
  const a=safe(),b=safe();tick(a,2);for(let i=0;i<120;i++)b.update(1/60);assert.ok(Math.abs(a.distance-b.distance)<.02);
  assert.ok(a.speed>START_SPEED&&a.speed<200);
  const fast=safe();fast.mode='endless';fast.distance=1600;tick(fast,1);assert.equal(fast.speed,1000);assert.ok(Math.abs(fast.gait-2.6*20/12)<.00001);
});
test('灯笼可直接跑过，跳起来接触灯笼会碰撞，障碍判定尊重高度',()=>{
  const ground=safe();ground.obstacles=[{type:'lantern',x:ground.playerX,width:28,height:30,y:GROUND-170}];tick(ground,.4);assert.equal(ground.status,'running');assert.equal(ground.passed,1);
  const jumping=safe();jumping.y=100;jumping.obstacles=[{type:'lantern',x:jumping.playerX,width:28,height:30,y:GROUND-170}];jumping.update(1/120);assert.equal(jumping.status,'over');
});
test('护盾只挡一次；组合障碍的同次碰撞有保护时间，结束后会失败',()=>{
  const m=safe();m.collect({kind:'shield'});m.obstacles=[{type:'stone',x:m.playerX,width:32,height:26},{type:'crate',x:m.playerX+4,width:30,height:42}];
  m.update(1/120);assert.equal(m.status,'running');assert.equal(m.shield,0);assert.equal(m.shieldHits,1);assert.ok(m.invulnerable>1);
  tick(m,1.2);m.obstacles=[{type:'stone',x:m.playerX,width:32,height:26}];m.update(1/120);assert.equal(m.status,'over');
});
test('吸引只收集半径内樱花，6秒后失效，不能远程拾取护盾',()=>{
  const m=safe();m.collect({kind:'magnet'});m.pickups=[flower(m.playerX+65,GROUND-60),{kind:'shield',x:m.playerX+65,y:GROUND-60,phase:0}];
  m.update(1/120);assert.equal(m.flowers,1);assert.equal(m.shield,0);m.pickups=[];tick(m,6);assert.equal(m.magnetTime,0);
  m.pickups=[flower(m.playerX+65,GROUND-60)];m.update(1/120);assert.equal(m.flowers,1);
});
test('每个小目标只奖励一次，闯关到家停止，无尽模式继续',()=>{
  const m=safe();for(let i=0;i<15;i++)m.collect(flower());m.passed=20;m.distance=500;m.update(1/120);
  assert.equal(m.completed.size,3);assert.equal(m.bonus,400);tick(m,.2);assert.equal(m.bonus,400);
  m.distance=STORY_DISTANCE-.1;m.update(1/60);assert.equal(m.status,'won');assert.equal(m.distance,STORY_DISTANCE);assert.equal(m.bonus,700);
  const score=m.score;tick(m,1);assert.equal(m.score,score);assert.equal(m.drainEvents().filter(e=>e.type==='won').length,1);
  const endless=safe();endless.mode='endless';endless.distance=STORY_DISTANCE;tick(endless,.1);assert.equal(endless.status,'running');assert.ok(endless.distance>STORY_DISTANCE);
});
test('窄/宽屏各阶段的混合障碍均能用单跳或跑过通过，不生成无解组合',()=>{
  for(const width of [540,800])for(const startDistance of [0,150,350,650,1000,1200,1600])for(const seed of [1,17,85]){
    let state=seed;const random=()=>((state=(state*1664525+1013904223)>>>0)/4294967296);
    const m=new RunModel({width,random});m.start({mode:'endless'});m.distance=startDistance;
    const seen=new Set();
    for(let i=0;i<120*35;i++){
      const next=m.obstacles.find(o=>!o.hit&&o.x+o.width>=m.playerX-12);
      if(next&&next.type!=='lantern'&&next.x-m.playerX<m.speed*.17+8&&m.y===0)m.jump();
      m.update(1/120);for(const o of m.obstacles)seen.add(o.type);
      assert.equal(m.status,'running',`width=${width}, distance=${startDistance}, seed=${seed}, elapsed=${m.elapsed}, next=${next?.type}`);
    }assert.ok(m.passed>15);if(startDistance>=350)assert.ok(seen.has('lantern'));
  }
});
