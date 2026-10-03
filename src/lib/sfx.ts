/**
 * Tiny synthesized sound + haptics for the lesion game. No audio assets: short oscillator blips through one lazily created
 * AudioContext (browsers only allow audio after a gesture, and every cue here is triggered from a pointer / key handler).
 * Everything is best-effort: no AudioContext, a blocked context or no vibration motor just means a silent cue.
 */
const MUTE_KEY = 'cathsim.muted'

let ctx: AudioContext | null = null
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
})()

export const isMuted = () => muted

export function setMuted(value: boolean): void {
  muted = value
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0')
  } catch {
    /* storage unavailable: the choice just does not persist */
  }
}

function audio(): AudioContext | null {
  if (muted) return null
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** One enveloped oscillator note: `at` seconds after now, `dur` seconds long. */
function note(c: AudioContext, freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
  const t0 = c.currentTime + at
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* unsupported */
  }
}

export const sfx = {
  /** A chip was selected in the diagnosis console. */
  tick() {
    const c = audio()
    if (c) note(c, 1500, 0, 0.05, 0.05, 'triangle')
    buzz(8)
  },
  /** Pedal: image frozen (a soft low click, like a relay). */
  freeze() {
    const c = audio()
    if (c) {
      note(c, 180, 0, 0.09, 0.12, 'square', 90)
      note(c, 2400, 0, 0.02, 0.03, 'square')
    }
    buzz(18)
  },
  /** Diagnosis locked in: a short rising "target acquired" sweep. */
  commit() {
    const c = audio()
    if (c) note(c, 500, 0, 0.16, 0.07, 'sawtooth', 1400)
    buzz(12)
  },
  /** Bullseye. */
  success() {
    const c = audio()
    if (c) {
      ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(c, f, 0.07 * i, 0.32, 0.09, 'triangle'))
      note(c, 261.63, 0, 0.5, 0.08, 'sine')
    }
    buzz([15, 40, 15, 40, 70])
  },
  /** A miss: two soft falling notes, not a harsh buzzer. */
  miss() {
    const c = audio()
    if (c) {
      note(c, 330, 0, 0.18, 0.08, 'triangle')
      note(c, 247, 0.14, 0.28, 0.08, 'triangle')
    }
    buzz([35, 45, 35])
  },
  /** Round over without finding it. */
  fail() {
    const c = audio()
    if (c) note(c, 220, 0, 0.5, 0.08, 'triangle', 130)
    buzz([60, 40, 90])
  },
}
