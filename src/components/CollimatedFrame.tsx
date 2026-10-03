import type { ReactNode } from 'react'

/** Fluoro detector background (light gray, inverted-cine look). */
export const DETECTOR_BG = '#d2d7dc'

/** Fraction of the square frame occupied by the collimator circle. */
export const APERTURE_INSET_PCT = 3

interface CollimatedFrameProps {
  /** The WebGL canvas. It is horizontally mirrored here so the image matches a cath-lab monitor. */
  children: ReactNode
  /** Un-mirrored overlay drawn inside the aperture (crosshair, calibration ticks). */
  overlay?: ReactNode
}

/**
 * Square black frame with a circular collimator aperture.
 *
 * Display mirroring: the canvas renders the view from the X-ray tube, in which patient-right is on screen-right.
 * The operator looks at the monitor face-to-face with the patient (patient-left on screen-right, apex to the
 * right in AP), so the canvas wrapper is flipped with -scale-x-100. Overlays are NOT flipped, so text stays legible.
 * Pointer handlers live on an outer element and receive un-mirrored screen coordinates.
 */
export function CollimatedFrame({ children, overlay }: CollimatedFrameProps) {
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
      <div
        className="absolute overflow-hidden rounded-full"
        style={{ inset: `${APERTURE_INSET_PCT}%`, background: DETECTOR_BG }}
      >
        <div className="absolute inset-0 -scale-x-100">{children}</div>
        {/* Vignette */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(circle at center, transparent 58%, rgba(0,0,0,0.30) 100%)' }}
        />
        {overlay}
      </div>
      {/* Collimator edge */}
      <div
        className="pointer-events-none absolute rounded-full ring-1 ring-zinc-600/70"
        style={{ inset: `${APERTURE_INSET_PCT}%` }}
      />
    </div>
  )
}
