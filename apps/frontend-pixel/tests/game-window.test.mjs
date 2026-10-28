import test from 'node:test';
import assert from 'node:assert/strict';
import {gameViewport} from '../js/games/viewport.js';
import {getApp,APPS} from '../js/desktop/apps.js';
import {fitWindowBounds} from '../js/desktop/window-layout.js';
import {DesktopIcons} from '../js/desktop/icons.js';
const screen=(width,height,coarse=false)=>({innerWidth:width,innerHeight:height,matchMedia:()=>({matches:coarse})});
test('桌面只提供游戏室入口，具体游戏保留独立窗口注册',()=>{
  assert.ok(APPS.some(a=>a.id==='games'&&!a.system&&a.title==='小葵游戏室'));
  assert.equal(getApp('game').system,true);assert.equal(getApp('game').title,'小葵快跑');
});
test('游戏窗口随手机竖屏/横屏铺满可用范围，宽屏桌面与其他应用保持原规则',()=>{
  const old=globalThis.window;
  try{
    globalThis.window=screen(390,844);assert.deepEqual(gameViewport(),{handheld:true,landscape:false});
    assert.deepEqual(fitWindowBounds({x:96,y:64,width:820,height:680},getApp('game')),{x:8,y:8,width:374,height:788});
    globalThis.window=screen(844,390);assert.deepEqual(gameViewport(),{handheld:true,landscape:true});
    assert.deepEqual(fitWindowBounds({x:96,y:64,width:820,height:680},getApp('game')),{x:8,y:8,width:828,height:334});
    assert.equal(fitWindowBounds({x:96,y:64,width:560,height:380},getApp('album')).width,560);
    globalThis.window=screen(1280,720);assert.deepEqual(gameViewport(),{handheld:false,landscape:false});
    assert.equal(fitWindowBounds({x:96,y:64,width:820,height:680},getApp('game')).width,820);
    globalThis.window=screen(1280,800,true);assert.equal(gameViewport().handheld,true);
  }finally{globalThis.window=old;}
});
test('手机横屏时游戏室图标换到下一列，不落到任务栏之外',()=>{
  const old=globalThis.window;
  try{globalThis.window=screen(844,390);const pos=DesktopIcons.prototype.defaultPosition(3);assert.deepEqual(pos,{x:124,y:28});assert.ok(pos.y+84<390-40);}
  finally{globalThis.window=old;}
});
