// One icon family for the Journey pages: 24px grid, 1.75 stroke, rounded joins.
// Icons are decorative by default; the text beside them carries the meaning.

const paths = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  heart: "M3.5 12h4l2-5 4 10 2-5h5",
  flask: "M9.5 3h5M10 3v6l-5 9a2 2 0 001.8 3h10.4a2 2 0 001.8-3l-5-9V3M7.5 15h9",
  person: "M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0",
  people:
    "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 19.5a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M18 14a6 6 0 013.5 5.5",
  alert:
    "M12 8.5v4.5M12 16.5h.01M10.3 4l-7.5 13a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4a2 2 0 00-3.4 0z",
  door: "M13 4h5a1 1 0 011 1v14a1 1 0 01-1 1h-5M9 8l4 4-4 4M13 12H4",
  chat: "M20.5 12a8 8 0 01-11.7 7.1L4 20l1-4.3A8 8 0 1120.5 12z",
  send: "M4.5 12L20 4.5 16 20l-4-6.5L4.5 12zM12 13.5L20 4.5",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6L12 3z",
  pulse: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 8v4.5M12 16h.01",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  phone:
    "M6.5 3h3l1.5 4.5-2 1.5a12 12 0 006 6l1.5-2 4.5 1.5v3a2 2 0 01-2 2A16.5 16.5 0 014.5 5a2 2 0 012-2z",
  globe:
    "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9S9.5 5.7 12 3z",
  list: "M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
  inbox:
    "M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5M5.5 5h13l2 8.5V18a1 1 0 01-1 1h-15a1 1 0 01-1-1v-4.5L5.5 5z",
  board: "M4 5h16v14H4zM4 10h16M9.5 10v9",
  forecast: "M3.5 18.5h17M5 15l4-5 3.5 3 6.5-7.5M15.5 5.5H19V9",
  target: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM12 12h.01",
  spark:
    "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3zM18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z",
  feed: "M5 19a1 1 0 100-2 1 1 0 000 2zM4 11a9 9 0 019 9M4 4a16 16 0 0116 16",
  back: "M19 12H5M11 6l-6 6 6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  home: "M4 10.5L12 4l8 6.5V19a1 1 0 01-1 1h-4.5v-5.5h-5V20H5a1 1 0 01-1-1v-8.5z",
  help: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.2-1.5 2.3M12 17h.01",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="vc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
