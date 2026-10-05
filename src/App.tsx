import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Bug, Download, Move } from 'lucide-react'
import { AnatomyTwin } from './components/AnatomyTwin'
import { ApButton } from './components/ApButton'
import { CaseSelector } from './components/CaseSelector'
import { ControlSchemeToggle } from './components/ControlSchemeToggle'
import { FluoroViewport } from './components/FluoroViewport'
import { GameHUD } from './components/GameHUD'
import { HUD } from './components/HUD'
import { TargetHUD } from './components/TargetHUD'
import { ModeBanner, ModeToggle } from './components/ModeToggle'
import { useInstallPrompt } from './hooks/useInstallPrompt'
import { useMediaQuery } from './hooks/useMediaQuery'
import { PIP_CORNER_CLASS, PIP_CORNERS, usePipDrag } from './hooks/usePipDrag'
import { PipDropEdge, PipTab } from './components/PipDock'
import { loadCaseIndex, loadManifest, setActiveCase } from './lib/heartIndex'
import { useGameStore } from './store/useGameStore'
import { useGantryStore } from './store/useGantryStore'

/**
 * Space = pedal. Target Views: lock & grade, then resume. Lesion game: freeze & diagnose, then back to live (next case once the
 * round is over). Explore has no pedal (Space keeps its normal page behaviour). Ignored while a button or field has focus so it
 * never double-fires.
 */
function usePedalShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const mode = useGantryStore.getState().mode
      const game = useGameStore.getState()
      if (mode === 'game') {
        // While diagnosing: Enter locks in the diagnosis, Escape unfreezes to keep searching.
        if (e.code === 'Enter' && game.phase === 'diagnosing') {
          e.preventDefault()
          game.lockIn()
          return
        }
        if (e.code === 'Escape' && game.phase === 'diagnosing') {
          e.preventDefault()
          game.unfreeze()
          return
        }
      }
      if (e.code !== 'Space' || mode === 'explore') return
      e.preventDefault()
      if (mode === 'game') {
        if (game.phase === 'hunt') game.freeze()
        else if (game.phase === 'diagnosing') game.unfreeze()
        else game.newRound()
        return
      }
      const s = useGantryStore.getState()
      if (s.phase === 'live') s.lock()
      else s.resume()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Layout:
 *  - lg+ : fluoro | 3D twin | HUD in three columns (side-by-side split screen).
 *  - md  : fluoro | 3D twin on top, HUD below.
 *  - phone portrait: one square slot. The fluoro view is the main image and the twin is a picture-in-picture
 *    thumbnail in its corner; tapping the thumbnail swaps them. Both viewports stay mounted and are only
 *    re-positioned with CSS, so no WebGL context is torn down by a swap.
 */
/** Loads the case manifest and the first case's branch index (centerlines, label anchors) before anything that needs them renders. */
function HeartGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    let cancelled = false
    loadManifest()
      .then(async (m) => {
        // ?case=<id> opens a specific manifest case (handy for sharing and testing); otherwise the manifest default.
        const wanted = new URLSearchParams(window.location.search).get('case')
        const first = m.cases.find((c) => c.id === wanted)?.id ?? m.default
        await loadCaseIndex(first)
        setActiveCase(first)
        useGantryStore.getState().initCases(m.cases, first)
      })
      .then(
        () => !cancelled && setState('ready'),
        (e) => {
          console.error(e)
          if (!cancelled) setState('error')
        },
      )
    return () => {
      cancelled = true
    }
  }, [])
  if (state === 'ready') return <>{children}</>
  return (
    <div className="grid min-h-full place-items-center p-6 text-center text-sm text-zinc-400" role="status">
      {state === 'loading' ? 'Loading anatomy…' : 'The anatomical model could not be loaded. Check your connection and reload.'}
    </div>
  )
}

export default function App() {
  return (
    <HeartGate>
      <Trainer />
    </HeartGate>
  )
}

/** Pre-filled GitHub issue (title prefix and a short template for description, expected behaviour and device / browser). */
const FEEDBACK_URL =
  'https://github.com/Rjc1999/cathsim/issues/new?title=%5BFeedback%2FBug%5D+&body=%2A%2ADescription%2A%2A%3A%0A%0A%2A%2AExpected+Behavior%2A%2A%3A%0A%0A%2A%2ADevice%2FBrowser%2A%2A%3A'

/** Opt-in install: sits beside the feedback link, appears only when the app is installable, never prompts on its own. */
function InstallAppButton() {
  const { state, install } = useInstallPrompt()
  const [iosHint, setIosHint] = useState(false)
  if (state === 'hidden') return null
  return (
    <>
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1.5 px-3 text-[11px] text-zinc-600 transition-colors hover:text-zinc-300 focus-visible:text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
        onClick={() => (state === 'prompt' ? void install() : setIosHint((v) => !v))}
      >
        <Download size={12} aria-hidden />
        {state === 'prompt' ? 'Install App' : 'Add to Home Screen'}
      </button>
      {state === 'ios' && iosHint && (
        <span className="block px-3 pb-1 text-[11px] text-zinc-500" role="status">
          Tap the Share button, then “Add to Home Screen”.
        </span>
      )}
    </>
  )
}

function Trainer() {
  usePedalShortcut()
  const wide = useMediaQuery('(min-width: 768px)')
  const [twinMain, setTwinMain] = useState(false)
  const mode = useGantryStore((s) => s.mode)
  const squareRef = useRef<HTMLDivElement>(null)
  const pipDrag = usePipDrag(squareRef)
  const tabRef = useRef<HTMLButtonElement>(null)
  // Pushed off an edge: the window is minimised to a tab and the main image is completely clear.
  const docked = !wide && pipDrag.dock !== null
  const dropSide = pipDrag.hover?.startsWith('dock-') ? (pipDrag.hover.slice(5) as 'left' | 'right' | 'top' | 'bottom') : null

  // Keyboard users who minimise the window land on its tab.
  useEffect(() => {
    if (pipDrag.focusTabRequest > 0) tabRef.current?.focus()
  }, [pipDrag.focusTabRequest])

  // Slot classes: on phones each viewport is absolutely positioned in the shared square; from md up they flow in the grid.
  // The small window sits in whichever corner the player dragged it to (pip-follow = it moves with the drag, see index.css).
  const main = 'absolute inset-0 md:static'
  const pip = `absolute z-20 ${PIP_CORNER_CLASS[pipDrag.corner]} pip-follow ${docked ? 'invisible pointer-events-none' : ''} w-[36%] overflow-hidden rounded-xl shadow-xl ring-2 ring-zinc-600 md:static md:w-full md:overflow-visible md:rounded-none md:shadow-none md:ring-0`
  const fluoroIsPip = !wide && twinMain
  const twinIsPip = !wide && !twinMain

  return (
    <div className="mx-auto min-h-full w-full max-w-[1500px] p-3 pb-6 lg:p-6">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1">
        <h1 className="text-lg font-bold tracking-tight text-zinc-100">
          Cath<span className="text-sky-400">Sim</span>
        </h1>
        <ModeToggle className="order-last w-full sm:order-none sm:w-auto" />
        {/* One case today; the picker (and its AP shortcut) is Trainer-only so the game header stays uncluttered. */}
        {mode === 'game' ? (
          <div className="flex items-center gap-2">
            <ApButton />
            <ControlSchemeToggle />
          </div>
        ) : (
          <CaseSelector />
        )}
      </header>
      <ModeBanner />

      <div className="grid items-start gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_21rem]">
        <div ref={squareRef} className="relative aspect-square w-full overflow-hidden md:contents md:overflow-visible">
          <div className={fluoroIsPip ? pip : main}>
            <FluoroViewport compact={fluoroIsPip} paused={fluoroIsPip && docked} />
          </div>
          <div className={twinIsPip ? pip : main}>
            <AnatomyTwin compact={twinIsPip} paused={twinIsPip && docked} />
          </div>
          {/* Phone only: while dragging, ghost outlines show the four corners it can snap to (the nearest one lights up), and
              an edge glows when letting go there would minimise the window. */}
          {!wide &&
            pipDrag.hover &&
            PIP_CORNERS.map((c) => (
              <span
                key={c}
                aria-hidden
                className={`pointer-events-none absolute z-10 aspect-square w-[36%] rounded-xl border-2 border-dashed transition-colors ${PIP_CORNER_CLASS[c]} ${
                  c === pipDrag.hover ? 'border-sky-400 bg-sky-400/15' : dropSide ? 'border-white/10' : 'border-white/25'
                }`}
              />
            ))}
          {!wide && dropSide && <PipDropEdge side={dropSide} />}
          {/* Phone only: the minimised window, as a tab on the edge it was pushed off. */}
          {docked && pipDrag.dock && (
            <PipTab ref={tabRef} dock={pipDrag.dock} kind={twinMain ? 'fluoro' : 'twin'} onRestore={pipDrag.restore} />
          )}
          {/* Phone only: transparent catcher over the window. A tap swaps the two views; a drag moves the window to a corner. */}
          {!wide && !docked && (
            <button
              type="button"
              data-pip-catcher
              aria-label={`${twinMain ? 'Show fluoro as the main image' : 'Show the 3D heart as the main image'}. Drag, or use the arrow keys, to move this window to another corner; push it off an edge to minimise it.`}
              onClick={() => {
                if (!pipDrag.clickWasDrag()) setTwinMain((v) => !v)
              }}
              {...pipDrag.handlers}
              className={`absolute z-30 flex aspect-square w-[36%] cursor-grab touch-none select-none items-start justify-between rounded-xl p-1.5 active:cursor-grabbing pip-follow ${PIP_CORNER_CLASS[pipDrag.corner]}`}
            >
              <span className="rounded-md bg-black/70 p-1 text-zinc-300">
                <Move size={12} aria-hidden />
              </span>
              <span className="rounded-md bg-black/70 p-1 text-zinc-200">
                <ArrowLeftRight size={12} aria-hidden />
              </span>
            </button>
          )}
        </div>

        <aside className="w-full md:col-span-2 lg:col-span-1">
          {mode === 'game' ? <GameHUD /> : mode === 'target' ? <TargetHUD /> : <HUD />}
        </aside>
      </div>

      <p className="mt-4 px-1 text-center text-xs text-zinc-500">
        Drag = move the C-arm (Gantry: right = LAO, up = cranial; Natural reverses it) · Shift = fine · scroll or pinch = zoom ·
        right-drag or two-finger drag = pan the table · double-click / double-tap = reset · tap a vessel or label to highlight ·
        arrows = 1°{mode !== 'explore' && ' · Space = pedal'}
      </p>
      <p className="mt-2 px-1 text-center text-[11px] text-zinc-600">
        Heart model: "Anatomical heart - codominance" by{' '}
        <a
          className="underline hover:text-zinc-400"
          href="https://sketchfab.com/3d-models/anatomical-heart-codominance-42d07ac1517748ea82bb05b0a362b298"
          target="_blank"
          rel="noreferrer"
        >
          E-learning UMCG
        </a>
        , adapted, licensed{' '}
        <a
          className="underline hover:text-zinc-400"
          href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
          target="_blank"
          rel="noreferrer"
        >
          CC BY-NC-SA
        </a>
        . Not for clinical use or commercial use.
      </p>
      {/* Feedback link: in the page flow under the attribution (never fixed), so it cannot cover the viewports, the PiP window or the HUD. */}
      <p className="text-center">
        <a
          className="inline-flex min-h-9 items-center gap-1.5 px-3 text-[11px] text-zinc-600 transition-colors hover:text-zinc-300 focus-visible:text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          href={FEEDBACK_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Bug size={12} aria-hidden />
          Feedback / Report Issue
        </a>
        <InstallAppButton />
      </p>
    </div>
  )
}
