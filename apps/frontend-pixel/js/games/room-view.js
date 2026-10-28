import { gameViewport } from './viewport.js';
export class GameRoomView {
  constructor(container,wm) {
    this.container=container;this.wm=wm;this.abort=new AbortController();const options={signal:this.abort.signal};
    container.classList.add('game-room-content');
    container.innerHTML=`<div class="game-room"><header><span class="room-eyebrow">XIAOKUI GAME ROOM</span><h1>小葵游戏室</h1><p>挑一个小游戏，和小葵玩一会儿。</p></header>
      <div class="room-library" aria-label="游戏列表"><button class="room-game" aria-label="小葵快跑" aria-pressed="false"><img src="./assets/games/xiaokui-run/icon.png" width="72" height="72" alt=""><strong>小葵快跑</strong><span>樱花归途 · 像素跑酷</span></button></div>
      <footer><span data-room-tip>双击游戏图标打开，也可以按 Enter。</span><span>无需登录 · 成绩保存在本机</span></footer></div>`;
    this.root=container.querySelector('.game-room');this.game=this.root.querySelector('.room-game');
    this.game.addEventListener('click',e=>{
      this.game.setAttribute('aria-pressed','true');
      if(gameViewport().handheld||e.detail===0)this.openGame();
    },options);
    this.game.addEventListener('dblclick',()=>this.openGame(),options);
    this.updateTip=()=>{this.root.querySelector('[data-room-tip]').textContent=gameViewport().handheld?'点按游戏图标即可打开。':'双击游戏图标打开，也可以按 Enter。';};
    window.addEventListener('resize',this.updateTip,options);this.updateTip();
  }
  openGame(){this.wm.open('game');}
  destroy(){this.abort.abort();this.container.classList.remove('game-room-content');}
}
