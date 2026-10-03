/** Reveal colours for the lesion game's target-lock ring: green for a full call, amber for the right branch, rose for a misattribution. */
export const LOCK_GREEN = '#34d399'
export const LOCK_AMBER = '#fbbf24'
export const LOCK_ROSE = '#fb7185'

export const verdictTone = (verdict: 'correct' | 'segment' | 'misattribution') =>
  verdict === 'correct' ? LOCK_GREEN : verdict === 'segment' ? LOCK_AMBER : LOCK_ROSE
