"""Minimal glTF 2.0 binary (GLB) writer for the CathSim model contract.

Per mesh node: POSITION (float32 vec3), NORMAL (normalised int8 vec3, padded to 4 bytes), optional COLOR_0 (float vec3), optional
_RADIUS (float scalar) and _AXIS (normalised int8 vec3), uint32 indices, and `extras` on the node. Everything is already in
patient LPS millimetres with the isocenter at the origin, so there are no node transforms. The result is optionally
meshopt-compressed by scripts/compress-glb.mjs.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

_FLOAT, _UINT, _BYTE = 5126, 5125, 5120
_ARRAY, _ELEMENT = 34962, 34963


class GlbBuilder:
    def __init__(self, scene_extras: dict):
        self.blob = bytearray()
        self.views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.nodes: list[dict] = []
        self.scene_extras = scene_extras

    def _view(self, data: bytes, target: int, stride: int | None = None) -> int:
        while len(self.blob) % 4:
            self.blob.append(0)
        v = {"buffer": 0, "byteOffset": len(self.blob), "byteLength": len(data), "target": target}
        if stride:
            v["byteStride"] = stride
        self.blob += data
        self.views.append(v)
        return len(self.views) - 1

    def _acc(self, view: int, comp: int, count: int, typ: str, normalized: bool = False, minmax: tuple | None = None) -> int:
        a = {"bufferView": view, "componentType": comp, "count": count, "type": typ}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"], a["max"] = [float(x) for x in minmax[0]], [float(x) for x in minmax[1]]
        self.accessors.append(a)
        return len(self.accessors) - 1

    def _unit_int8(self, v: np.ndarray) -> int:
        q = np.zeros((len(v), 4), dtype=np.int8)
        q[:, :3] = np.clip(np.round(v * 127), -127, 127).astype(np.int8)
        return self._acc(self._view(q.tobytes(), _ARRAY, 4), _BYTE, len(v), "VEC3", normalized=True)

    def add_mesh(self, name: str, verts: np.ndarray, faces: np.ndarray, normals: np.ndarray, extras: dict, colors=None, radius=None, axis=None) -> None:
        v = np.ascontiguousarray(verts, dtype=np.float32)
        attrs = {
            "POSITION": self._acc(self._view(v.tobytes(), _ARRAY), _FLOAT, len(v), "VEC3", minmax=(v.min(0), v.max(0))),
            "NORMAL": self._unit_int8(normals),
        }
        if colors is not None:
            attrs["COLOR_0"] = self._acc(self._view(np.ascontiguousarray(colors, dtype=np.float32).tobytes(), _ARRAY), _FLOAT, len(v), "VEC3")
        if radius is not None:
            attrs["_RADIUS"] = self._acc(self._view(np.ascontiguousarray(radius, dtype=np.float32).tobytes(), _ARRAY), _FLOAT, len(v), "SCALAR")
        if axis is not None:
            attrs["_AXIS"] = self._unit_int8(axis)
        idx = np.ascontiguousarray(faces.ravel(), dtype=np.uint32)
        idx_acc = self._acc(self._view(idx.tobytes(), _ELEMENT), _UINT, len(idx), "SCALAR")
        self.meshes.append({"name": name, "primitives": [{"attributes": attrs, "indices": idx_acc, "mode": 4}]})
        self.nodes.append({"name": name, "mesh": len(self.meshes) - 1, "extras": extras})

    def write(self, path: str | Path) -> int:
        gltf = {
            "asset": {"version": "2.0", "generator": "CathSim process_cohort_case.py"},
            "scene": 0,
            "scenes": [{"name": "CathSimCase", "nodes": list(range(len(self.nodes))), "extras": self.scene_extras}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.views,
            "buffers": [{"byteLength": len(self.blob)}],
        }
        js = json.dumps(gltf, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        bin_ = bytes(self.blob) + b"\0" * (-len(self.blob) % 4)
        total = 12 + 8 + len(js) + 8 + len(bin_)
        with open(path, "wb") as f:
            f.write(struct.pack("<4sII", b"glTF", 2, total))
            f.write(struct.pack("<I4s", len(js), b"JSON") + js)
            f.write(struct.pack("<I4s", len(bin_), b"BIN\0") + bin_)
        return total
