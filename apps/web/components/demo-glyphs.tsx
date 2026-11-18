// Small icons for the demo bar. Filled for transport controls, outlined for the rest.

const filled = {
  play: "M8 5.2v13.6a.6.6 0 00.9.5l11-6.8a.6.6 0 000-1L8.9 4.7a.6.6 0 00-.9.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  bolt: "M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6l1-8z",
} as const;
const stroked = {
  up: "M6 14.5l6-6 6 6",
  down: "M6 9.5l6 6 6-6",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  reset: "M19.5 12a7.5 7.5 0 11-2.6-5.7M19.5 4.5v4h-4",
} as const;

export type GlyphName = keyof typeof filled | keyof typeof stroked;

export function Glyph({ name, size = 18 }: { name: GlyphName; size?: number }) {
  const solid = name in filled;
  return (
    <svg
      className="dbar-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? "currentColor" : "none"}
      stroke={solid ? "none" : "currentColor"}
      strokeWidth={name === "grip" ? 2.6 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={solid ? filled[name as keyof typeof filled] : stroked[name as keyof typeof stroked]}
      />
    </svg>
  );
}
