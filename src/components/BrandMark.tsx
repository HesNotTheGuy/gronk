/**
 * Gronk rock — product mark used in the rail (and wherever the app needs the
 * icon in-renderer). Matched to build/icon.png: irregular heptagon, three
 * facets meeting in a Y, phosphor outline on void.
 *
 * Inline SVG (not a PNG import) so Electron HMR and CSP stay happy, and so a
 * single path can scale from 16px favicon-ish to 36px brand without blur.
 */

export interface BrandMarkProps {
  className?: string
  /** Outer box in CSS pixels. Default matches the sidebar brand slot. */
  size?: number
  /**
   * Decorative by default (sidebar already has the wordmark). Set false when
   * the mark is the only identity (e.g. a collapsed control).
   */
  decorative?: boolean
}

/**
 * Outline of the stone in a 0–100 viewBox (traced from the shipping icon).
 * Heptagon, slightly irregular — not a regular polygon.
 */
const OUTLINE =
  'M 42 8 L 68 18 L 86 42 L 80 72 L 52 90 L 22 78 L 10 48 L 18 20 Z'

/** Three lit faces that meet near the center (Y ridge). */
const FACE_LEFT = 'M 18 20 L 42 8 L 48 48 L 10 48 Z'
const FACE_TOP = 'M 42 8 L 68 18 L 86 42 L 48 48 Z'
const FACE_RIGHT = 'M 10 48 L 48 48 L 86 42 L 80 72 L 52 90 L 22 78 Z'

export function BrandMark({
  className = '',
  size = 36,
  decorative = true
}: BrandMarkProps) {
  return (
    <span
      className={`brand-mark ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Gronk'}
    >
      <svg
        className="brand-mark-img"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
      >
        <defs>
          {/* Soft edge so the phosphor rim reads at 16–24px without jagged steps. */}
          <filter id="rock-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Facets first (dark body) */}
        <path d={FACE_LEFT} fill="#5a6562" />
        <path d={FACE_TOP} fill="#3d4543" />
        <path d={FACE_RIGHT} fill="#2a302e" />

        {/* Inner ridge lines — the Y that sells “cut stone” at small size */}
        <path
          d="M 48 48 L 42 8 M 48 48 L 10 48 M 48 48 L 80 72"
          stroke="rgba(234,255,251,0.14)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />

        {/* Phosphor outline — identity stroke, matches --ignite family */}
        <path
          d={OUTLINE}
          stroke="var(--ignite, #eafffb)"
          strokeWidth="3.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
          filter="url(#rock-glow)"
        />
      </svg>
    </span>
  )
}
