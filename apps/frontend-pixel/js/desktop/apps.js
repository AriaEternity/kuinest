// 小葵 OS · 应用注册表
// 用户确认的透明图集已裁切为独立PNG；原SVG保留为备用，应用交互不变。

const PAL = {
  P: '#e9b7c8', // 淡粉
  H: '#f7d7e6', // 高亮粉白
  D: '#987489', // 灰粉
  K: '#241722', // 深紫黑
  W: '#ffffff', // 白
  '.': 'transparent',
};

function asciiIcon(rows, pal = PAL, size = 16) {
  const rects = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = pal[ch];
      if (c && c !== 'transparent') {
        rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`);
      }
    });
  });
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

export { asciiIcon };

// 小葵聊天室：带笑脸的对话泡泡
const ICON_CHAT = asciiIcon([
  '................',
  '..PPPPPPPPPP....',
  '.PHHHHHHHHHHP...',
  '.PHPPPPPPPPHP...',
  '.PHPKKPPKKPHP...',
  '.PHPKKPPKKPHP...',
  '.PHPPPPPPPPHP...',
  '.PHPPKPPKPPHP...',
  '.PHPPKKKKPPHP...',
  '.PHHHHHHHHHHP...',
  '..PPPPPPPPPP....',
  '...PPP..........',
  '....PP..........',
  '................',
  '................',
  '................',
]);

// 相册：带落日和山峦的相框
const ICON_ALBUM = asciiIcon([
  '................',
  '.PPPPPPPPPPPP...',
  '.PHHHHHHHHHHP...',
  '.PHPPPPPPPPHP...',
  '.PHPPPWWPPPHP...',
  '.PHPPWWWWPPHP...',
  '.PHPPPWWPPPHP...',
  '.PHPKPPPPKPHP...',
  '.PHPKKPPKKKHP...',
  '.PHKKKPKKKKHP...',
  '.PHHHHHHHHHHP...',
  '.PPPPPPPPPPPP...',
  '................',
  '................',
  '................',
  '................',
]);

// 日记：带书签的笔记本
const ICON_DIARY = asciiIcon([
  '................',
  '..PPPPPPPPPP....',
  '.PDHPPPPPPPPP...',
  '.PDHPHHPPHHPP...',
  '.PDHPHHPPHHPP...',
  '.PDHPHHHHHHPP...',
  '.PDHPHHHHHHPP...',
  '.PDHPHHPPHHPP...',
  '.PDHPHHPPHHPP...',
  '.PDHPHHHHHHPP...',
  '.PDHPHHHHHHPP...',
  '.PDPPPPPPPPPP...',
  '..PPPPPPPPPP....',
  '................',
  '................',
  '................',
]);

// 向日葵（关于窗口 / 系统入口标记）
const ICON_SUNFLOWER = asciiIcon([
  '......PP........',
  '.....PHHP.......',
  '..PP.PHHP.PP....',
  '.PHHPHHHHPHHP...',
  '.PHHHKDDKHHHP...',
  '..PPKDDDDKPP....',
  '..PPKDDDDKPP....',
  '.PHHHKDDKHHHP...',
  '.PHHPHHHHPHHP...',
  '..PP.PHHP.PP....',
  '.....PHHP.......',
  '......PP........',
  '................',
  '................',
  '................',
  '................',
]);

export const APPS = [
  {
    id: 'chat',
    title: '小葵聊天室',
    iconSrc: './assets/pink-icons-v1/01-chat.png',
    iconSvg: ICON_CHAT,
    size: { width: 800, height: 580 },
    minSize: { width: 320, height: 360 },
    tagline: '和小葵说点什么吧。',
  },
  {
    id: 'album',
    title: '相册',
    iconSrc: './assets/pink-icons-v1/04-camera.png',
    iconSvg: ICON_ALBUM,
    size: { width: 560, height: 380 },
    tagline: '相册尚未接入后端，暂不提供上传或保存。',
  },
  {
    id: 'diary',
    title: '日记',
    iconSrc: './assets/pink-icons-v1/05-diary.png',
    iconSvg: ICON_DIARY,
    size: { width: 480, height: 360 },
    tagline: '日记尚未接入后端，记忆候选可在聊天室中查看。',
  },
  {
    id: 'games',
    title: '小葵游戏室',
    iconSrc: './assets/pink-icons-v1/03-folder.png',
    size: { width: 600, height: 420 },
    minSize: { width: 300, height: 300 },
    tagline: '挑一个小游戏，和小葵玩一会儿。',
  },
  {
    id: 'game',
    system: true,
    title: '小葵快跑',
    iconSrc: './assets/games/xiaokui-run/icon.png',
    size: { width: 820, height: 680 },
    minSize: { width: 320, height: 460 },
    tagline: '樱花归途，轻轻一跳。',
  },
  {
    id: 'settings',
    title: '桌面设置',
    system: true,
    iconSrc: './assets/pink-icons-v1/07-settings.png',
    iconSvg: asciiIcon([
      '......PP........', '.....PHHP.......', '..PP.PHHP.PP....', '.PHHPPHHPPHHP...',
      '.PHHHHHHHHHHP...', '..PHHKDDKHHP....', '.PHHK....KHHP...', '.PHHK....KHHP...',
      '..PHHKDDKHHP....', '.PHHHHHHHHHHP...', '.PHHPPHHPPHHP...', '..PP.PHHP.PP....',
      '.....PHHP.......', '......PP........', '................', '................',
    ]),
    size: { width: 440, height: 510 },
    minSize: { width: 300, height: 360 },
  },
  {
    // 系统内置：仅从「小葵 OS」入口打开，不显示桌面图标
    id: 'about',
    title: '关于小葵 OS',
    system: true,
    iconSrc: null,
    iconSvg: ICON_SUNFLOWER,
    size: { width: 420, height: 330 },
    minSize: { width: 280, height: 280 },
    tagline: '安静、温柔、克制、有生命感。',
    about: true,
  },
];

// 系统入口的向日葵标记（16×16）
export const SUNFLOWER_SVG = ICON_SUNFLOWER;

export function getApp(id) {
  return APPS.find((a) => a.id === id) || null;
}
