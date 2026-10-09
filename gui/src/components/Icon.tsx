// 图标路径改编自 SerialArm-Core launcher，授权说明见 gui/THIRD_PARTY_NOTICES.md
const paths = {
  overview: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  system: 'M5 21v-4h14v4M8 17l-3-5 4-3 4 3-2 5M9 9l3-5 6 3-5 5M18 7l2-3M2 21h20',
  templates: 'M4 5h16v14H4zM8 9h8M8 13h5M6 3v4M18 3v4',
  runtime: 'M10 3h4v4h-4zM5 8h14v12H5zM9 12h6M9 16h3',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  plug: 'M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3'
}
export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{name === 'sun' && <circle cx="12" cy="12" r="4" />}<path d={paths[name]} /></svg>
}
