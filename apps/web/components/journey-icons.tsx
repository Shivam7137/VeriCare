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
