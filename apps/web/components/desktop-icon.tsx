const paths = {
  overview: "M3 3h18v18H3z M9 3v18 M9 10h12",
  external: "M7 17 18 6 M7 6h11v11",
  inbound: "M18 6 7 17 M7 6v11h11",
  calendar: "M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
} as const;

export default function DesktopIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
