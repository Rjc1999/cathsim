"""QC figures for the cohort pipeline (matplotlib, Agg). Every figure carries LPS millimetre axes."""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import scipy.ndimage as ndi  # noqa: E402

from .io_lps import Grid  # noqa: E402


def masked_volume(ct: np.ndarray, pools: np.ndarray, asc: np.ndarray, myo: np.ndarray, grid: Grid) -> np.ndarray:
    """CT with blood pools (+1.3 mm), the ascending aorta and the myocardium toned down, so that epicardial vessels, veins
    and bone stand out against dark fat in a projection."""
    pools_d = ndi.distance_transform_edt(~pools, sampling=grid.spacing) <= 1.3
    vol = np.where(pools_d | ndi.binary_dilation(asc, iterations=2), -200, ct).astype(np.float32)
    vol[myo] = np.minimum(vol[myo], 100)
    return vol


def projection_overlay(path: Path, vol: np.ndarray, layers: list[tuple[np.ndarray, tuple]], grid: Grid, title: str, y_slab=(-48, 3), post_slab=(3, 45)) -> None:
    """Anterior slab MIP, posterior slab MIP and a lateral MIP with coloured mask layers [(mask, rgba), ...]."""
    x, y, z = grid.axis(0), grid.axis(1), grid.axis(2)
    fig, ax = plt.subplots(1, 3, figsize=(36, 13))
    specs = [("ANTERIOR slab y%s" % (y_slab,), np.searchsorted(y, y_slab[0]), np.searchsorted(y, y_slab[1])), ("POSTERIOR slab y%s" % (post_slab,), np.searchsorted(y, post_slab[0]), np.searchsorted(y, post_slab[1]))]
    for a, (t, ya, yb) in zip(ax[:2], specs):
        ext = [x[0], x[-1], z[0], z[-1]]
        a.imshow(np.clip(vol[:, ya:yb, :].max(axis=1)[::-1], -100, 500), cmap="gray", extent=ext, aspect="equal")
        for m, col in layers:
            mm = m[:, ya:yb, :].any(axis=1)[::-1]
            rgba = np.zeros(mm.shape + (4,))
            rgba[mm] = col
            a.imshow(rgba, extent=ext, aspect="equal")
        a.set_title(f"{title}: {t} (x: patient-left to the right, z: cranial up)")
        a.grid(color="yellow", alpha=0.25, linewidth=0.5)
    ext = [y[0], y[-1], z[0], z[-1]]
    ax[2].imshow(np.clip(vol.max(axis=2)[::-1], -100, 500), cmap="gray", extent=ext, aspect="equal")
    for m, col in layers:
        mm = m.any(axis=2)[::-1]
        rgba = np.zeros(mm.shape + (4,))
        rgba[mm] = col
        ax[2].imshow(rgba, extent=ext, aspect="equal")
    ax[2].set_title("LATERAL (y: posterior to the right)")
    ax[2].grid(color="yellow", alpha=0.25, linewidth=0.5)
    plt.tight_layout()
    plt.savefig(path, dpi=42)
    plt.close(fig)


def axial_overlay(path: Path, ct: np.ndarray, layers: list[tuple[np.ndarray, str]], grid: Grid, zs, extent=(-50, 85, -50, 55)) -> None:
    x0, x1, y0, y1 = extent
    sp = grid.spacing
    fig, axs = plt.subplots(2, (len(zs) + 1) // 2, figsize=(10 * ((len(zs) + 1) // 2), 17))
    for a, z in zip(np.atleast_1d(axs).ravel(), zs):
        k = int(round((z - grid.origin[2]) / sp))
        i0, i1 = int((x0 - grid.origin[0]) / sp), int((x1 - grid.origin[0]) / sp)
        j0, j1 = int((y0 - grid.origin[1]) / sp), int((y1 - grid.origin[1]) / sp)
        a.imshow(np.clip(ct[k, j0:j1, i0:i1], -150, 550), cmap="gray", extent=[x0, x1, y1, y0], interpolation="bilinear")
        for m, col in layers:
            sl = m[max(k - 1, 0) : k + 2, j0:j1, i0:i1].any(axis=0)
            a.contour(np.linspace(x0, x1, sl.shape[1]), np.linspace(y0, y1, sl.shape[0]), sl.astype(float), levels=[0.5], colors=col, linewidths=1.1)
        a.set_title(f"axial z={z:.0f} mm (x: patient-left to the right, y: posterior down)", fontsize=10)
        a.set_xticks(range(x0, x1 + 1, 10))
        a.set_yticks(range(y0, y1 + 1, 10))
        a.grid(color="yellow", alpha=0.18, linewidth=0.5)
        a.tick_params(labelsize=8)
    plt.tight_layout()
    plt.savefig(path, dpi=52)
    plt.close(fig)


def tree_overlay(path: Path, vol: np.ndarray, trees: dict, kept: dict, grid: Grid, min_label_len: float = 9.0) -> None:
    """Segment ids drawn at segment mid-points over anterior / posterior slab MIPs and a lateral MIP.
    `trees`: {'LCA': Tree, 'RCA': Tree}; `kept`: {'LCA': set(ids), ...}. Ids are the ones the labelling config refers to."""
    x, y, z = grid.axis(0), grid.axis(1), grid.axis(2)
    fig, ax = plt.subplots(1, 3, figsize=(42, 15))
    cols = {"LCA": "red", "RCA": "cyan"}
    specs = [("ANTERIOR slab y[-48,3]", np.searchsorted(y, -48), np.searchsorted(y, 3), 0, 2, [x[0], x[-1], z[0], z[-1]]), ("POSTERIOR slab y[3,45]", np.searchsorted(y, 3), np.searchsorted(y, 45), 0, 2, [x[0], x[-1], z[0], z[-1]]), ("LATERAL", 0, vol.shape[1], 1, 2, [y[0], y[-1], z[0], z[-1]])]
    for a, (title, ya, yb, hx, hy, ext) in zip(ax, specs):
        proj = vol[:, ya:yb, :].max(axis=1) if hx == 0 else vol.max(axis=2)
        a.imshow(np.clip(proj[::-1], -100, 500), cmap="gray", extent=ext, aspect="equal")
        for name, tree in trees.items():
            for sid in kept[name]:
                s = tree.segments[sid]
                a.plot(s.pts[:, hx], s.pts[:, hy], color=cols[name], linewidth=1.6)
                if s.length >= min_label_len:
                    m = s.pts[len(s.pts) // 2]
                    a.text(m[hx], m[hy], f"{name[0]}{sid}", color="yellow" if name == "LCA" else "lime", fontsize=9, weight="bold")
        a.set_title(f"{title} (x: patient-left to the right)" if hx == 0 else title)
        a.grid(color="yellow", alpha=0.2, linewidth=0.5)
    plt.tight_layout()
    plt.savefig(path, dpi=48)
    plt.close(fig)
