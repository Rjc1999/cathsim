"""Mask → closed, outward-wound triangle meshes in patient LPS mm, with Taubin smoothing and quadric decimation.

Handedness: scikit-image's marching cubes works on array axes (k=z, j=y, i=x) and returns vertices in that order, while LPS is
(x, y, z). Reordering the axes is an odd permutation, which turns the triangle winding inside out; the signed volume is
checked and the winding flipped when needed. No coordinate is ever negated, so no mirror image can be produced.
"""
from __future__ import annotations

import numpy as np
import scipy.ndimage as ndi
import scipy.sparse as sp
from skimage.measure import marching_cubes

from .io_lps import Grid


def signed_volume(v: np.ndarray, f: np.ndarray) -> float:
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def mask_to_mesh(mask: np.ndarray, grid: Grid, sigma_vox: float = 0.6, level: float = 0.5, pad: int = 2) -> tuple[np.ndarray, np.ndarray]:
    """Marching cubes on the Gaussian-softened mask (sub-voxel surface, no staircasing) → LPS vertices, outward faces."""
    if not mask.any():
        raise ValueError("empty mask")
    idx = np.argwhere(mask)
    lo = np.maximum(idx.min(0) - pad - int(3 * sigma_vox), 0)
    hi = np.minimum(idx.max(0) + pad + int(3 * sigma_vox) + 1, mask.shape)
    sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    field = np.pad(ndi.gaussian_filter(mask[sl].astype(np.float32), sigma_vox), 1)
    verts, faces, _, _ = marching_cubes(field, level=level, spacing=(grid.spacing,) * 3)
    verts = verts / grid.spacing - 1 + lo  # → voxel (z, y, x) of the full grid
    lps = grid.zyx_to_lps(verts)
    faces = faces.astype(np.int64)
    if signed_volume(lps, faces) < 0:
        faces = faces[:, ::-1].copy()
    return lps, faces


def _laplacian(n: int, faces: np.ndarray) -> sp.csr_matrix:
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    a = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    a.data[:] = 1.0  # unique neighbours
    deg = np.asarray(a.sum(axis=1)).ravel()
    deg[deg == 0] = 1
    return sp.diags(1.0 / deg) @ a


def taubin_smooth(v: np.ndarray, f: np.ndarray, iterations: int = 30, lam: float = 0.5, mu: float = -0.53) -> np.ndarray:
    """Taubin λ|μ smoothing: a shrinking Laplacian step (λ > 0) followed by an inflating one (μ < -λ). The pass band keeps
    low-frequency shape, so vessel caliber is preserved while voxel-scale ripple is removed."""
    L = _laplacian(len(v), f)
    v = v.copy()
    for _ in range(iterations):
        v += lam * (L @ v - v)
        v += mu * (L @ v - v)
    return v


def decimate(v: np.ndarray, f: np.ndarray, target_tris: int, feature_angle: float | None = None) -> tuple[np.ndarray, np.ndarray]:
    """VTK quadric-error decimation to about `target_tris` triangles (topology-preserving)."""
    import vtk
    from vtk.util import numpy_support as ns

    if len(f) <= target_tris:
        return v, f
    pd = vtk.vtkPolyData()
    pts = vtk.vtkPoints()
    pts.SetData(ns.numpy_to_vtk(np.ascontiguousarray(v, dtype=np.float64), deep=True))
    pd.SetPoints(pts)
    cells = np.hstack([np.full((len(f), 1), 3, dtype=np.int64), f]).ravel()
    ca = vtk.vtkCellArray()
    ca.SetCells(len(f), ns.numpy_to_vtkIdTypeArray(cells, deep=True))
    pd.SetPolys(ca)
    dec = vtk.vtkQuadricDecimation()
    dec.SetInputData(pd)
    dec.SetTargetReduction(1.0 - target_tris / len(f))
    dec.VolumePreservationOn()
    dec.Update()
    out = dec.GetOutput()
    ov = ns.vtk_to_numpy(out.GetPoints().GetData()).astype(np.float64)
    of = ns.vtk_to_numpy(out.GetPolys().GetConnectivityArray()).reshape(-1, 3).astype(np.int64)
    return ov, of


def vertex_normals(v: np.ndarray, f: np.ndarray) -> np.ndarray:
    n = np.zeros_like(v)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])  # area-weighted
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1
    return n / ln


def boundary_edge_count(f: np.ndarray) -> int:
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    return int((counts == 1).sum())


def compact(v: np.ndarray, f: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    used = np.unique(f)
    remap = np.full(len(v), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return v[used], remap[f]


def balls_union_mesh(centres: np.ndarray, radii: np.ndarray, spacing: float = 0.35, margin: float = 0.8) -> tuple[np.ndarray, np.ndarray]:
    """Closed surface of the union of balls (a swept tube along a centerline with a varying calibre, branches included).

    Field value = max_i (r_i - |x - c_i|), evaluated with the 12 nearest centres, zero level = surface. The union of
    overlapping balls has no bumps larger than ~spacing^2 / (8 r), and it cannot collapse thin vessels: radius is data."""
    from scipy.spatial import cKDTree

    lo = centres.min(0) - radii.max() - margin
    hi = centres.max(0) + radii.max() + margin
    shape = np.ceil((hi - lo) / spacing).astype(int)  # (nx, ny, nz)
    # candidate voxels = within (r_max + margin) of a centre, found with a binary dilation of the centre voxels
    cidx = np.floor((centres - lo) / spacing).astype(int)
    occ = np.zeros(tuple(shape[::-1]), dtype=bool)
    occ[cidx[:, 2], cidx[:, 1], cidx[:, 0]] = True
    reach = ndi.distance_transform_edt(~occ, sampling=spacing) <= radii.max() + margin
    zyx = np.argwhere(reach)
    xyz = lo + (zyx[:, ::-1] + 0.5) * spacing
    tree = cKDTree(centres)
    k = min(12, len(centres))
    d, ix = tree.query(xyz, k=k)
    val = (radii[ix] - d).max(axis=1)
    field = np.full(tuple(shape[::-1]), -1.0, dtype=np.float32)
    field[tuple(zyx.T)] = np.maximum(val, -1.0)
    verts, faces, _, _ = marching_cubes(np.pad(field, 1, constant_values=-1.0), level=0.0, spacing=(spacing,) * 3)
    zyx_v = verts / spacing - 1 + 0.5  # voxel-centre convention used above
    lps = lo + zyx_v[:, ::-1] * spacing
    faces = faces.astype(np.int64)
    if signed_volume(lps, faces) < 0:
        faces = faces[:, ::-1].copy()
    return lps, faces
