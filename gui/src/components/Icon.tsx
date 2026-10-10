// 图标路径改编自 SerialArm-Core launcher，授权说明见 gui/THIRD_PARTY_NOTICES.md
const paths = {
  overview: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  system: 'M5 21v-4h14v4M8 17l-3-5 4-3 4 3-2 5M9 9l3-5 6 3-5 5M18 7l2-3M2 21h20',
  templates: 'M4 5h16v14H4zM8 9h8M8 13h5M6 3v4M18 3v4',
  runtime: 'M10 3h4v4h-4zM5 8h14v12H5zM9 12h6M9 16h3',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  plug: 'M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3',
  eye: 'M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  navigation: 'M3 11l18-8-8 18-2-8-8-2z',
  bot: 'M8 4h8v4H8z M12 8v4 M5 12h14v8H5z M8 16h1 M15 16h1 M3 15h2 M19 15h2',
  cpu: 'M5 5h14v14H5z M9 9h6v6H9z M9 1v4 M15 1v4 M9 19v4 M15 19v4 M1 9h4 M1 15h4 M19 9h4 M19 15h4',
  'layout-dashboard': 'M3 3h8v8H3z M13 3h8v5h-8z M13 10h8v11h-8z M3 13h8v8H3z',
  boxes: 'M12 2l8 4-8 4-8-4z M4 6v8l8 4 8-4V6 M12 10v8 M12 18v4',
  network: 'M12 3v6 M12 9H5v5 M12 9h7v5 M5 14v4 M19 14v4 M2 18h6v4H2z M16 18h6v4h-6z M9 2h6v4H9z',
  'git-branch': 'M6 3v12 M6 8c0 0 0 5 6 5h6 M3 3h6v4H3z M15 10h6v5h-6z M3 17h6v4H3z',
  'play-circle': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M10 8l6 4-6 4z',
  'graduation-cap': 'M2 9l10-5 10 5-10 5z M6 11v6c4 3 8 3 12 0v-6 M22 9v8',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 11v6 M12 7h.01',
  'mouse-pointer-2': 'M4 3l15 9-7 1-3 7z',
  'check-circle': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M7 12l3 3 7-7',
  'chevron-down': 'M5 9l7 7 7-7',
  'chevron-up': 'M5 15l7-7 7 7',
  x: 'M5 5l14 14 M19 5L5 19'
}
export function Icon({ name, size }: { name: string; size?: "xl" }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" style={size === "xl" ? {width: 30,height: 30} : undefined}>{name === 'sun' && <circle cx="12" cy="12" r="4" />}<path d={paths[name as keyof typeof paths] || paths.system} /></svg>
}
