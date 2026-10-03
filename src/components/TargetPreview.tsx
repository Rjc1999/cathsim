import type { TargetPreset } from '../data/targets'
import { CollimatedFrame } from './CollimatedFrame'
import { FluoroCanvas } from './FluoroCanvas'

/**
 * Static reference frame for the current challenge: the same renderer and mirroring as the live viewport, posed at
 * the target angles, so the learner matches an image rather than a number. Angles are not shown here.
 */
export function TargetPreview({ target }: { target: TargetPreset }) {
  return (
    <figure className="m-0 w-full">
      <CollimatedFrame>
        <FluoroCanvas vessel={target.vessel} alpha={target.alpha} beta={target.beta} />
      </CollimatedFrame>
      <figcaption className="mt-1.5 text-center text-xs font-medium tracking-wide text-zinc-400">
        Target · {target.name}
      </figcaption>
    </figure>
  )
}
