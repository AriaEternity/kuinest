// 只改变浏览器标签；分享元信息固定，不读取聊天或制造未读提醒。
const normalTitle = document.title;
const awayTitle = '偷偷探头，等你回来 · 葵栖';
const welcomeTitle = '回来啦，给你留着位置呢 · 葵栖';
let wasHidden = document.hidden;
let restoreTimer;

function updateTitle() {
  clearTimeout(restoreTimer);
  if (document.hidden) {
    wasHidden = true;
    document.title = awayTitle;
  } else if (wasHidden) {
    wasHidden = false;
    document.title = welcomeTitle;
    restoreTimer = setTimeout(() => { document.title = normalTitle; }, 2600);
  } else {
    document.title = normalTitle;
  }
}
document.addEventListener('visibilitychange', updateTitle);
window.addEventListener('pagehide', () => clearTimeout(restoreTimer));
window.addEventListener('pageshow', event => {
  if (event.persisted) updateTitle();
});
if (document.hidden) updateTitle();
