// Inline icons (24 x 24, stroke = currentColor).

const PATHS = {
  overview: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  console: 'M6 4v16M12 4v16M18 4v16M4 14h4M10 8h4M16 16h4',
  eq: 'M3 17c3 0 4-10 7-10s3 7 5 7 3-4 6-4',
  geq: 'M4 20V10M8 20V6M12 20v-8M16 20V8M20 20v-5',
  dynamics: 'M3 20L11 12h10M11 12V4',
  delay: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  matrix: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  presets: 'M4 6h16M4 12h16M4 18h10',
  device: 'M4 7h16v10H4zM8 11h.01M12 11h4M8 17v2M16 17v2',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5 1-3 14-3.5-1',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM17 8a5 5 0 0 1 0 8',
  phase: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5 19L19 5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  open: 'M3 7h6l2 2h10v10H3zM3 7V5h6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  refresh: 'M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  warning: 'M12 3L2 20h20zM12 10v4M12 17h.01',
  check: 'M5 12l5 5L20 7',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  wave: 'M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0',
  usb: 'M12 3v14M12 3l-2 3h4zM8 9v3l4 3M16 8v2l-4 3M12 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  ethernet: 'M5 4h14v10H5zM9 14v3h6v-3M8 7v3M11 7v3M13 7v3M16 7v3',
  serial: 'M4 8h16l-2 8H6zM8 11h.01M12 11h.01M16 11h.01M10 14h.01M14 14h.01',
  demo: 'M9 3h6M10 3v6l-5.5 9.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3M7.2 15h9.6',
  print: 'M7 9V4h10v5M6 18H4v-7h16v7h-2M7 14h10v6H7z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5',
  moon: 'M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  ab: 'M3 18L7 6l4 12M4.5 14h5M14 6h4a3 3 0 0 1 0 6h-4zM14 12h5a3 3 0 0 1 0 6h-5z',
  speaker2: 'M7 3h10v18H7zM12 7h.01M12 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  scene: 'M4 5h16v14H4zM4 9h16M9 5v4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15.1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  gauge: 'M3.5 16.5a8.5 8.5 0 0 1 17 0M12 16.5l4.2-5.2M6.5 16.5h.01M17.5 16.5h.01',
  turntable: 'M11 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM11 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM20 3v8l-3 4',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
