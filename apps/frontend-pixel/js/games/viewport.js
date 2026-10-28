// 游戏窗口单独适配手机横屏，不改变聊天室等应用的桌面布局规则。
export function gameViewport(view=window) {
  const handheld=view.innerWidth<=720||!!view.matchMedia?.('(pointer: coarse)').matches||
    (view.innerWidth<=1100&&view.innerHeight<=520);
  return {handheld,landscape:handheld&&view.innerWidth>view.innerHeight};
}
