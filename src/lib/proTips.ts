import type { VesselId } from './heartIndex'

/**
 * Explore-mode angiographic pearls for the live C-arm pose (alpha: +LAO / -RAO, beta: +CRA / -CAU, degrees).
 * Rules are checked top to bottom and the first match wins: the named LCA views, then the two orientation rules (spine for the
 * primary angle, diaphragm for the secondary), then the AP baseline. Poses that match nothing (e.g. LAO 17 / CRA 5) return null.
 * The named views are LCA teaching points, so they only apply while the LCA is injected; the orientation rules hold for either.
 *
 * Spine rule check (patient space LPS, detector direction d = (sin a cos b, -cos a cos b, sin b)): the screen-right vector in the
 * mirrored fluoro image is (cos a, sin a, 0), and the spine sits posterior of the cardiac centre, so its screen-x is +sin a * dy
 * > 0 for LAO. LAO puts the spine on the screen right, RAO on the left.
 */
export function getAngioProTip(alpha: number, beta: number, vessel: VesselId): string | null {
  if (vessel === 'LCA') {
    if (alpha >= 35 && beta <= -15)
      return '🕷️ Spider View (LAO Caudal): Uncrosses the Left Main bifurcation. LAD courses toward 1 o\'clock; LCx branches toward 5 o\'clock.'
    if (alpha <= -15 && beta >= 15) return '🎯 RAO Cranial: Elongates the LAD and separates diagonal bifurcations.'
    if (alpha <= -15 && beta <= -15) return '🎯 RAO Caudal: Elongates the LCx trunk and displays Obtuse Marginal takeoffs.'
    if (alpha >= 20 && beta >= 20) return '🎯 LAO Cranial: Direct elongation of the mid and distal LAD.'
  }
  if (alpha >= 20) return '💡 Spine Rule: The spine is on the screen-RIGHT ⇒ you are in an LAO projection.'
  if (alpha <= -20) return '💡 Spine Rule: The spine is on the screen-LEFT ⇒ you are in an RAO projection.'
  if (beta >= 20) return '💡 Diaphragm Rule: The diaphragm dome rises into the lower field ⇒ you are tilted Cranial.'
  if (beta <= -20) return '💡 Diaphragm Rule: The diaphragm drops out of the frame ⇒ you are tilted Caudal.'
  if (Math.abs(alpha) < 15 && Math.abs(beta) < 15)
    return '💡 AP Baseline: High overlap. Swing RAO to move away from the spine or LAO to uncross branches.'
  return null
}

/**
 * Explore coronary-sinus injection. Only landmark rules that hold for any structure (spine, diaphragm) plus one anatomical pearl taken from
 * the venous model itself; no projection claims about specific veins, which would need clinical review.
 */
export function getVenousProTip(alpha: number, beta: number): string {
  if (alpha >= 20) return '💡 Spine Rule: The spine is on the screen-RIGHT ⇒ you are in an LAO projection.'
  if (alpha <= -20) return '💡 Spine Rule: The spine is on the screen-LEFT ⇒ you are in an RAO projection.'
  if (beta >= 20) return '💡 Diaphragm Rule: The diaphragm dome rises into the lower field ⇒ you are tilted Cranial.'
  if (beta <= -20) return '💡 Diaphragm Rule: The diaphragm drops out of the frame ⇒ you are tilted Caudal.'
  return '🩸 Coronary sinus: opens into the right atrium at the CS ostium and runs along the left AV groove as the great cardiac vein, which turns into the anterior interventricular vein beside the LAD. The middle cardiac vein joins near the ostium; the posterior vein of the LV joins at the distal CS.'
}
