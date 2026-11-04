import { useEffect, useRef, useState } from 'react'
import './brandPill.css'

/**
 * The cath+code header pill: "CathSim: Views ▾" over "a cath+code interactive experience". Tapping it opens the CathSim series switcher
 * (All Experiences, 01 Views, 02 JL, 03 JR, 04 AL). It is the React port of cathsim-al's src/ui/brandPill.js: the same markup, classes and links
 * as every other CathSim app. This app's row is marked aria-current and Active. Shuts on a press outside it or on Esc.
 */
const HOME = { label: 'All CathSim Experiences', href: '/' } as const
const SERIES = [
  { n: '01', label: 'CathSim: Views', sub: '3D C-Arm & Fluoroscopic Projections', href: 'https://cathsim-views.pages.dev', current: true },
  { n: '02', label: 'CathSim: Judkins Left', sub: 'Catheter Mechanics & Root Sizing', href: 'https://cathsim-jl.pages.dev' },
  { n: '03', label: 'CathSim: Judkins Right', sub: 'Clockwise Torque & Ostial Hop', href: 'https://cathsim-jr.pages.dev' },
  { n: '04', label: 'CathSim: Amplatz Left', sub: 'Push-to-Disengage Paradox & Backup', href: 'https://cathsim-al.pages.dev' },
] as const

export function BrandPill() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btn.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <header ref={root} className="brand-pill">
      <button ref={btn} type="button" className="brand-btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="brand-line">
          Cath<span className="brand-sim">Sim</span>
          <span className="brand-sub">
            <span className="brand-colon">: </span>Views
          </span>
          <span className="brand-caret" aria-hidden="true">
            ▾
          </span>
        </span>
        <span className="brand-tag">a cath+code interactive experience</span>
      </button>
      <nav className="brand-menu" aria-label="CathSim series" hidden={!open}>
        <a className="brand-link brand-home" href={HOME.href}>
          🏠 {HOME.label}
        </a>
        {SERIES.map((e) => {
          const text = (
            <span className="brand-item-text">
              <b>
                {e.n} • {e.label}
              </b>
              <small>{e.sub}</small>
            </span>
          )
          return 'current' in e ? (
            <div key={e.n} className="brand-link brand-item" aria-current="page">
              {text}
              <span className="brand-active">Active ●</span>
            </div>
          ) : (
            <a key={e.n} className="brand-link brand-item" href={e.href}>
              {text}
            </a>
          )
        })}
        <p className="brand-foot">
          Crafted by <strong>cath+code</strong> (RJ Cajucom)
        </p>
      </nav>
    </header>
  )
}
