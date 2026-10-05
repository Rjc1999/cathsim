import { useSyncExternalStore } from 'react'

/** The (non-standard) event Chromium fires when the app is installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// The event can fire before React mounts, so it is captured at module load and shared through a tiny external store.
let deferred: BeforeInstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress the browser's own banner: the install is only ever offered by the footer button.
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installed = true
    emit()
  })
}

/** Running as an installed app (display-mode standalone, or iOS home-screen launch). */
function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iOS Safari never fires beforeinstallprompt: installation is Share > Add to Home Screen. */
function isIosBrowser(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

export type InstallState = 'hidden' | 'prompt' | 'ios'

function getState(): InstallState {
  if (installed || isStandalone()) return 'hidden'
  if (deferred) return 'prompt'
  return isIosBrowser() ? 'ios' : 'hidden'
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  const mq = window.matchMedia('(display-mode: standalone)')
  mq.addEventListener('change', notify)
  return () => {
    listeners.delete(notify)
    mq.removeEventListener('change', notify)
  }
}

/** `hidden`: nothing to offer. `prompt`: call `install()` from a user gesture. `ios`: show the manual Add to Home Screen hint. */
export function useInstallPrompt() {
  const state = useSyncExternalStore(subscribe, getState, () => 'hidden' as InstallState)

  async function install() {
    const evt = deferred
    if (!evt) return
    await evt.prompt()
    await evt.userChoice
    // A prompt event can be used once; a dismissed install is re-offered by the browser with a fresh event.
    deferred = null
    emit()
  }

  return { state, install }
}
