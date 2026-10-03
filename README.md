# CathSim

A free, mobile-first educational simulator for learning coronary angiography C-arm projections. Drive a virtual
C-arm (LAO/RAO, CRA/CAU), see a simulated fluoroscopy image of the coronary tree next to a 3D anatomical twin,
match textbook views, and play "Where's This Lesion?" to practise attributing a stenosis to the right vessel.

Built with Vite, React, TypeScript, Tailwind, Three.js (`@react-three/fiber`) and Zustand.

> Educational use only. Not a medical device and not for clinical decision-making.

## Run it

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production bundle
```

## Licence and credits

- **Code:** copyright 2026 Rodante, [PolyForm Noncommercial 1.0.0](LICENSE). Free for education, research and other
  non-commercial use; no commercial use.
- **Heart model:** "Anatomical heart - codominance" by
  [E-learning UMCG](https://sketchfab.com/3d-models/anatomical-heart-codominance-42d07ac1517748ea82bb05b0a362b298),
  used under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); the model and its derived files
  are non-commercial too. See [NOTICE.md](NOTICE.md) for which files are covered.
