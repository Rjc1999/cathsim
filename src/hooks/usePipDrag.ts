import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * The phone's picture-in-picture view (the small window over the main image) can be dragged to any of the four corners of the
 * image, and pushed OFF an edge to minimise it: the main image is then completely clear and a small tab stays on that edge;
 * tapping the tab slides the window back to its corner.
 *
 * While dragging the window follows the pointer and may leave the image entirely (the container clips it). When at least
 * DOCK_OUT_FRACTION of it is outside one edge, releasing minimises it to that edge; otherwise the nearest corner is chosen and
 * the window glides into it. A press that barely moves is still a tap, which swaps the two views (the caller's onClick).
 *
 * The animations are FLIPs driven by CSS variables on the container (`.pip-follow`, see index.css), so the window and its
 * transparent tap/drag catcher move together without re-rendering per pointer move.
 */
export type PipCorner = 'tl' | 'tr' | 'bl' | 'br'
export type PipSide = 'left' | 'right' | 'top' | 'bottom'
/** Where a release would put the window right now: a corner, or minimised to an edge. */
export type PipTarget = PipCorner | `dock-${PipSide}`
/** Minimised state: which edge the tab is on and where along that edge (0..1). */
export interface PipDock {
  side: PipSide
  pos: number
}

/** Position classes per corner. The top corners sit below the readout / buttons drawn in the main image's top strip. */
export const PIP_CORNER_CLASS: Record<PipCorner, string> = {
  tl: 'left-2 top-16',
  tr: 'right-2 top-16',
  bl: 'left-2 bottom-2',
  br: 'right-2 bottom-2',
}
export const PIP_CORNERS = Object.keys(PIP_CORNER_CLASS) as PipCorner[]

const CORNER_KEY = 'cathsim.pipCorner'
const DOCK_KEY = 'cathsim.pipDock'
/** Movement (px) before a press becomes a drag; below it the press is a tap that swaps the views. */
const DRAG_SLOP_PX = 6
/** Fraction of the window that must be outside an edge for a release to minimise it. */
const DOCK_OUT_FRACTION = 0.4
const SLIDE_MS = 230

function loadCorner(): PipCorner {
  try {
    const v = localStorage.getItem(CORNER_KEY)
    if (v && (PIP_CORNERS as string[]).includes(v)) return v as PipCorner
  } catch {
    /* storage unavailable */
  }
  return 'br'
}

function loadDock(): PipDock | null {
  try {
    const d = JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null') as Partial<PipDock> | null
    if (d && ['left', 'right', 'top', 'bottom'].includes(d.side as string) && typeof d.pos === 'number') {
      return { side: d.side as PipSide, pos: Math.min(0.9, Math.max(0.1, d.pos)) }
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return null
}

const remember = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* the choice just does not persist */
  }
}

const cornerAt = (right: boolean, bottom: boolean): PipCorner => (bottom ? (right ? 'br' : 'bl') : right ? 'tr' : 'tl')
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Translation that puts a window of box `rect` completely outside `box` on `side`. */
function slideOut(side: PipSide, rect: DOMRect, box: DOMRect): [number, number] {
  return side === 'left'
    ? [box.left - rect.right, 0]
    : side === 'right'
      ? [box.right - rect.left, 0]
      : side === 'top'
        ? [0, box.top - rect.bottom]
        : [0, box.bottom - rect.top]
}

export function usePipDrag(containerRef: RefObject<HTMLDivElement | null>) {
  const [corner, setCornerState] = useState<PipCorner>(loadCorner)
  const [dock, setDock] = useState<PipDock | null>(loadDock)
  /** Non-null while dragging: what a release would do right now. */
  const [hover, setHover] = useState<PipTarget | null>(null)
  /** Bumped when a keyboard action minimises the window, so the caller can move focus to the new tab. */
  const [focusTabRequest, setFocusTabRequest] = useState(0)
  const g = useRef({
    id: -1,
    sx: 0,
    sy: 0,
    dx: 0,
    dy: 0,
    moved: false,
    rect: null as DOMRect | null,
    target: 'br' as PipTarget,
    suppressClickUntil: 0,
  })

  const vars = (dx: number, dy: number, scale = 1) => {
    const c = containerRef.current
    if (!c) return
    c.style.setProperty('--pip-dx', `${dx}px`)
    c.style.setProperty('--pip-dy', `${dy}px`)
    c.style.setProperty('--pip-scale', String(scale))
  }

  const setCorner = (c: PipCorner) => {
    setCornerState(c)
    remember(CORNER_KEY, c)
  }
  const setDockPersist = (d: PipDock | null) => {
    setDock(d)
    remember(DOCK_KEY, d ? JSON.stringify(d) : null)
  }

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    g.current = { ...g.current, id: e.pointerId, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, rect: e.currentTarget.getBoundingClientRect(), target: corner }
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const s = g.current
    const c = containerRef.current
    if (e.pointerId !== s.id || !s.rect || !c) return
    let dx = e.clientX - s.sx
    let dy = e.clientY - s.sy
    if (!s.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return
      s.moved = true
      c.dataset.pipDragging = 'true'
      setHover(s.target)
    }
    const box = c.getBoundingClientRect()
    const r = s.rect
    // the window may leave the image completely (the container clips it)
    dx = clamp(dx, box.left - r.right, box.right - r.left)
    dy = clamp(dy, box.top - r.bottom, box.bottom - r.top)
    s.dx = dx
    s.dy = dy
    vars(dx, dy, 1.05)
    const out: [PipSide, number][] = [
      ['left', (box.left - (r.left + dx)) / r.width],
      ['right', (r.right + dx - box.right) / r.width],
      ['top', (box.top - (r.top + dy)) / r.height],
      ['bottom', (r.bottom + dy - box.bottom) / r.height],
    ]
    const [side, frac] = out.reduce((a, b) => (b[1] > a[1] ? b : a))
    const next: PipTarget =
      frac >= DOCK_OUT_FRACTION
        ? `dock-${side}`
        : cornerAt(r.left + r.width / 2 + dx > box.left + box.width / 2, r.top + r.height / 2 + dy > box.top + box.height / 2)
    if (next !== s.target) {
      s.target = next
      setHover(next)
    }
  }

  const end = (e: PointerEvent<HTMLElement>) => {
    const s = g.current
    const c = containerRef.current
    if (e.pointerId !== s.id) return
    s.id = -1
    if (!s.moved || !c || !s.rect) return
    s.moved = false
    s.suppressClickUntil = performance.now() + 350 // the click that follows a drag must not swap the views
    const el = e.currentTarget
    const target = s.target
    const box = c.getBoundingClientRect()
    const r = s.rect
    const nearest = cornerAt(r.left + r.width / 2 + s.dx > box.left + box.width / 2, r.top + r.height / 2 + s.dy > box.top + box.height / 2)

    if (target.startsWith('dock-')) {
      // Minimise: carry on sliding off the edge, then swap the window for a tab (restoring later returns it to the nearest corner).
      const side = target.slice(5) as PipSide
      const pos = clamp(side === 'left' || side === 'right' ? (r.top + r.height / 2 + s.dy - box.top) / box.height : (r.left + r.width / 2 + s.dx - box.left) / box.width, 0.1, 0.9)
      const [ox, oy] = slideOut(side, r, box)
      setHover(null)
      delete c.dataset.pipDragging // transitions on again
      vars(side === 'left' || side === 'right' ? ox : s.dx, side === 'top' || side === 'bottom' ? oy : s.dy)
      window.setTimeout(() => {
        c.dataset.pipDragging = 'true'
        vars(0, 0) // reset while it is invisible
        flushSync(() => {
          setCorner(nearest)
          setDockPersist({ side, pos })
        })
        delete c.dataset.pipDragging
      }, SLIDE_MS)
      return
    }

    const dropped = el.getBoundingClientRect()
    vars(0, 0)
    flushSync(() => {
      setCorner(target as PipCorner)
      setHover(null)
    })
    const home = el.getBoundingClientRect()
    vars(dropped.left - home.left, dropped.top - home.top, 1.05) // back where the finger left it (no transition while data-pip-dragging)
    void c.offsetWidth // commit that frame
    delete c.dataset.pipDragging // transitions on again
    requestAnimationFrame(() => vars(0, 0)) // glide into the corner
  }

  /** Arrow keys move the window between corners; an arrow towards the nearest edge minimises it there. */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const right = corner === 'tr' || corner === 'br'
    const bottom = corner === 'bl' || corner === 'br'
    const towards: Record<string, PipSide | undefined> = {
      ArrowLeft: right ? undefined : 'left',
      ArrowRight: right ? 'right' : undefined,
      ArrowUp: bottom ? undefined : 'top',
      ArrowDown: bottom ? 'bottom' : undefined,
    }
    const edge = towards[e.key]
    if (edge) {
      e.preventDefault()
      setDockPersist({ side: edge, pos: edge === 'left' || edge === 'right' ? (bottom ? 0.75 : 0.25) : right ? 0.75 : 0.25 })
      setFocusTabRequest((n) => n + 1)
      return
    }
    const next =
      e.key === 'ArrowLeft' ? cornerAt(false, bottom) : e.key === 'ArrowRight' ? cornerAt(true, bottom) : e.key === 'ArrowUp' ? cornerAt(right, false) : e.key === 'ArrowDown' ? cornerAt(right, true) : null
    if (!next) return
    e.preventDefault()
    setCorner(next)
  }

  /** Bring a minimised window back: it slides in from the edge its tab was on and settles in its corner. */
  const restore = (focusWindow = false) => {
    const c = containerRef.current
    if (!c || !dock) return
    const side = dock.side
    c.dataset.pipDragging = 'true'
    vars(0, 0)
    flushSync(() => setDockPersist(null))
    const el = c.querySelector<HTMLElement>('[data-pip-catcher]')
    if (el) {
      const [ox, oy] = slideOut(side, el.getBoundingClientRect(), c.getBoundingClientRect())
      vars(ox, oy)
      void c.offsetWidth
      if (focusWindow) el.focus()
    }
    delete c.dataset.pipDragging
    requestAnimationFrame(() => vars(0, 0))
  }

  /** Call from the button's onClick: true when this click is the tail of a drag and should be ignored. */
  const clickWasDrag = () => performance.now() < g.current.suppressClickUntil

  return {
    corner,
    dock,
    /** What a release would do right now, while dragging; null otherwise. */
    hover,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onKeyDown },
    clickWasDrag,
    restore,
    focusTabRequest,
  }
}
