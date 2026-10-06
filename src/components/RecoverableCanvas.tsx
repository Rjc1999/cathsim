import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { Canvas, useThree } from '@react-three/fiber'

/** How long a lost context may stay lost after the page is visible again before the canvas is rebuilt from scratch. */
const REBUILD_AFTER_MS = 1500

/**
 * Mobile browsers reclaim GPU memory when the tab or PWA is backgrounded and kill the WebGL context. Without
 * handling, the canvas stays blank until a reload. Here: preventDefault on `webglcontextlost` lets the browser
 * restore it, three.js re-uploads geometry and recompiles shaders itself, and with frameloop 'demand' nothing
 * would redraw, so we invalidate on restore and on return to the page. If the context is still lost shortly after
 * the page is visible, `onDead` remounts the canvas (a fresh context).
 */
function GlRecovery({ onDead }: { onDead: () => void }) {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    const canvas = gl.domElement
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const check = () => {
      clearTimer()
      if (document.visibilityState !== 'visible') return
      if (gl.getContext().isContextLost()) timer = setTimeout(() => gl.getContext().isContextLost() && onDead(), REBUILD_AFTER_MS)
      else invalidate()
    }
    const onLost = (e: Event) => {
      e.preventDefault()
      check()
    }
    const onRestored = () => {
      clearTimer()
      invalidate()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', check)
    return () => {
      clearTimer()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', check)
    }
  }, [gl, invalidate, onDead])

  return null
}

/** r3f Canvas that survives WebGL context loss (see GlRecovery). Drop-in replacement for Canvas. */
export function RecoverableCanvas({ children, ...props }: ComponentProps<typeof Canvas>) {
  const [generation, setGeneration] = useState(0)
  const rebuild = useCallback(() => setGeneration((g) => g + 1), [])
  return (
    <Canvas key={generation} {...props}>
      <GlRecovery onDead={rebuild} />
      {children}
    </Canvas>
  )
}
