# Third-party material and licensing

## Heart model

The heart anatomy used by CathSim is derived from:

- **"Anatomical heart - codominance"** by **E-learning UMCG** (@eLearningUMCG)
- Source: <https://sketchfab.com/3d-models/anatomical-heart-codominance-42d07ac1517748ea82bb05b0a362b298>
- Licence: [Creative Commons Attribution-NonCommercial-ShareAlike 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) (CC BY-NC-SA)

Per its Sketchfab description, that model "builds upon the Bodyparts3D model" (BodyParts3D, The Database Center for
Life Science, licensed CC Attribution-Share Alike), enhanced by E-learning UMCG for greater detail and precision.
Metadata checked against the Sketchfab record on 2026-10-03.

**Changes made:** the original FBX was converted to glTF (`.glb`), compressed, re-centred on the isocenter in
patient (LPS) coordinates, split into labelled coronary branches and a filled soft-tissue envelope, and
supplemented with generated centerline data. The author has not endorsed these changes or this project.

### Which files this licence covers

CC BY-NC-SA 4.0 applies to the model and everything derived from it:

- `anatomical-heart-codominance/source/rechts dominant versie 1.fbx` (original, unmodified)
- `public/models/heart.glb`, `public/models/heart.index.json`, `public/models/cases_manifest.json` (adapted)

Reuse of these files must keep the attribution above, must stay **non-commercial**, and any further
adaptation must be shared under the same licence.

## Source code

The application source (`src/`, `scripts/`, configuration) is copyright 2026 Rodante and licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) (see `LICENSE`):
free for personal, educational, research and other non-commercial use; commercial use is not permitted.
The model files listed above remain under CC BY-NC-SA 4.0.

## Intended use

CathSim is an educational tool for cath lab learners. It is **not** a clinical or diagnostic device, the
anatomy is a single reference model, and it is not validated for clinical decision-making.
