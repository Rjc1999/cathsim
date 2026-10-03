import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { APERTURE_INSET_PCT } from '../components/CollimatedFrame'
import { mmPerAperturePx } from '../lib/projection'
import { useGantryStore } from '../store/useGantryStore'

/** Degrees of gantry motion per screen pixel; Shift is ~4x finer. */
const DEG_PER_PX = 0.3
const DEG_PER_PX_PRECISION = 0.075
/** A press shorter than this and moving less than TAP_SLOP_PX counts as a tap. */
const TAP_MAX_MS = 300
const TAP_SLOP_PX = 8
const DOUBLE_TAP_MS = 320
/** Wheel zoom: ln(zoom) per wheel unit (px). A trackpad pinch arrives as ctrl+wheel with much smaller deltas, so it gets a bigger factor. */
const WHEEL_ZOOM_PER_PX = 0.0015
const PINCH_WHEEL_ZOOM_PER_PX = 0.01
const WHEEL_LINE_PX = 16
/** Keyboard zoom step (multiplicative). */
const KEY_ZOOM_STEP = 1.15
/** Two fingers closer than this (px) give no usable pinch ratio. */
const MIN_PINCH_PX = 12

interface Options {
  /** Called for a single tap (not for the second tap of a double-tap, which resets the view). */
  onTap?: (clientX: number, clientY: number, element: HTMLElement) => void
  /**
   * Fluoro viewport only: wheel / pinch zoom and table pan (middle / right drag, two-finger drag). Without it a second finger
   * just suppresses the rotation, and the element's wheel and context menu are left alone.
   * The element must be the square collimator frame (the aperture is inset by APERTURE_INSET_PCT inside it).
   */
  zoomPan?: boolean
}

type Pt = { x: number; y: number }

/** Centre and width (px) of the circular aperture inside the square element, for turning pointer pixels into iso-plane mm. */
function apertureOf(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width * (1 - (2 * APERTURE_INSET_PCT) / 100) }
}

/**
 * Direct pointer control shared by every viewport that can drive the C-arm. Deltas are read in un-mirrored screen space, so attach
 * the handlers to an element outside any CSS flip.
 *   left-drag / one finger → rotate the gantry. Scheme 'gantry' (default): drag right = LAO, up = CRA. Scheme 'natural': reversed
 *     (right = RAO, up = CAU), i.e. a standard 3D orbit. Shift = ~4x finer.
 *   wheel / pinch → zoom 1.0x to 2.5x about the cursor / the pinch midpoint        (zoomPan)
 *   middle- or right-drag / two-finger drag → table pan, the image follows the pointer   (zoomPan)
 *   double-click / double-tap → reset to AP 0°/0°, 1.0x, centred
 *   arrow keys → 1° steps (Shift = 5°, same direction rule as the drag), + / - → zoom   (zoom keys: zoomPan)
 * While the view is locked the rotation is inert (the store ignores it) but zoom, pan and taps still work.
 */
export function useGantryDrag({ onTap, zoomPan = false }: Options = {}) {
  const onTapRef = useRef(onTap)
  useEffect(() => {
    onTapRef.current = onTap
  })

  const elRef = useRef<HTMLDivElement>(null)

  const gesture = useRef({
    pointers: new Map<number, Pt>(),
    primary: -1,
    /** 'rotate' = left button / touch, 'pan' = middle or right mouse button. */
    kind: 'rotate' as 'rotate' | 'pan',
    downAt: 0,
    travel: 0,
    /** A second finger touched down at some point in this gesture: no rotation and no tap until every pointer is up. */
    multi: false,
    lastTapAt: 0,
    prevDist: 0,
    prevMid: { x: 0, y: 0 },
  })

  // React attaches wheel listeners as passive, so preventDefault (stopping the page from scrolling) needs a native one.
  useEffect(() => {
    const el = elRef.current
    if (!zoomPan || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY
      const s = useGantryStore.getState()
      const next = s.zoom * Math.exp(-px * (e.ctrlKey ? PINCH_WHEEL_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX))
      const ap = apertureOf(el)
      const mm = mmPerAperturePx(ap.w, s.zoom)
      s.zoomAbout(next, (e.clientX - ap.cx) * mm, -(e.clientY - ap.cy) * mm)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomPan])

  const handlers = useMemo(() => {
    const g = gesture.current

    /** Re-baseline the two-finger measurements (call whenever the set of fingers changes, so nothing jumps). */
    const resetPinch = () => {
      const [a, b] = [...g.pointers.values()]
      if (!a || !b) return
      g.prevDist = Math.hypot(b.x - a.x, b.y - a.y)
      g.prevMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }

    /** The image follows the pointer: dragging right moves the view centre left (towards screen-left), dragging down moves it up. */
    const panBy = (dxPx: number, dyPx: number, aperturePx: number) => {
      const s = useGantryStore.getState()
      const mm = mmPerAperturePx(aperturePx, s.zoom)
      s.setPanOffset([s.panOffset[0] - dxPx * mm, s.panOffset[1] + dyPx * mm])
    }

    const onPointerDown = (e: PointerEvent<HTMLElement>) => {
      // Left button, touch and pen drive the gantry; middle / right mouse buttons pan the table (fluoro only).
      const pan = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)
      if (e.button !== 0 && !(pan && zoomPan)) return
      if (g.pointers.size === 0) {
        g.primary = e.pointerId
        g.kind = pan ? 'pan' : 'rotate'
        g.downAt = performance.now()
        g.travel = 0
        g.multi = false
      } else {
        g.multi = true
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (g.pointers.size === 2) resetPinch()
    }

    const onPointerMove = (e: PointerEvent<HTMLElement>) => {
      const prev = g.pointers.get(e.pointerId)
      if (!prev) return
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const store = useGantryStore.getState()

      if (g.pointers.size >= 2) {
        // Two fingers: pinch = zoom about the midpoint, midpoint drag = table pan. The gantry stays put.
        if (!zoomPan) return
        const [a, b] = [...g.pointers.values()]
        const dist = Math.hypot(b.x - a.x, b.y - a.y)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const ap = apertureOf(e.currentTarget)
        if (g.prevDist > MIN_PINCH_PX && dist > MIN_PINCH_PX) {
          const mm = mmPerAperturePx(ap.w, store.zoom)
          store.zoomAbout(store.zoom * (dist / g.prevDist), (g.prevMid.x - ap.cx) * mm, -(g.prevMid.y - ap.cy) * mm)
        }
        panBy(mid.x - g.prevMid.x, mid.y - g.prevMid.y, ap.w)
        g.prevDist = dist
        g.prevMid = mid
        return
      }

      if (e.pointerId !== g.primary || g.multi) return // a finger left a pinch: the other one must not start rotating
      g.travel += Math.abs(dx) + Math.abs(dy)
      if (g.kind === 'pan') {
        panBy(dx, dy, apertureOf(e.currentTarget).w)
        return
      }
      const k = e.shiftKey ? DEG_PER_PX_PRECISION : DEG_PER_PX
      // 'gantry': right = +α (LAO), up = +β (CRA). 'natural': both reversed.
      const dir = store.controlScheme === 'natural' ? -1 : 1
      store.nudge(dx * k * dir, -dy * k * dir)
    }

    const endPointer = (e: PointerEvent<HTMLElement>, cancelled = false) => {
      if (!g.pointers.delete(e.pointerId)) return
      if (g.pointers.size > 0) return
      const now = performance.now()
      const isTap = !cancelled && g.kind === 'rotate' && !g.multi && g.travel < TAP_SLOP_PX && now - g.downAt < TAP_MAX_MS
      if (!isTap) return
      if (now - g.lastTapAt < DOUBLE_TAP_MS) {
        useGantryStore.getState().resetView()
        g.lastTapAt = 0
      } else {
        g.lastTapAt = now
        onTapRef.current?.(e.clientX, e.clientY, e.currentTarget)
      }
    }

    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
      const step = e.shiftKey ? 5 : 1
      const { nudge, controlScheme } = useGantryStore.getState()
      const dir = controlScheme === 'natural' ? -1 : 1
      switch (e.key) {
        case 'ArrowRight':
          nudge(step * dir, 0)
          break
        case 'ArrowLeft':
          nudge(-step * dir, 0)
          break
        case 'ArrowUp':
          nudge(0, step * dir)
          break
        case 'ArrowDown':
          nudge(0, -step * dir)
          break
        case '+':
        case '=':
        case '-':
        case '_': {
          if (!zoomPan) return
          const { zoom, setZoom } = useGantryStore.getState()
          setZoom(e.key === '+' || e.key === '=' ? zoom * KEY_ZOOM_STEP : zoom / KEY_ZOOM_STEP)
          break
        }
        default:
          return
      }
      e.preventDefault()
    }

    // Middle button would start the browser's autoscroll and the right button would open the context menu: both are pan gestures here.
    const onMouseDown = (e: MouseEvent<HTMLElement>) => {
      if (zoomPan && e.button === 1) e.preventDefault()
    }
    const onAuxClick = (e: MouseEvent<HTMLElement>) => {
      if (zoomPan) e.preventDefault()
    }
    const onContextMenu = (e: MouseEvent<HTMLElement>) => {
      if (zoomPan) e.preventDefault()
    }

    return {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: PointerEvent<HTMLElement>) => endPointer(e),
      onPointerCancel: (e: PointerEvent<HTMLElement>) => endPointer(e, true),
      onKeyDown,
      onMouseDown,
      onAuxClick,
      onContextMenu,
    }
  }, [zoomPan])

  return { ref: elRef, ...handlers }
}
