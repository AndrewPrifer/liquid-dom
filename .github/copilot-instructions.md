# GitHub Copilot System Prompts for Liquid DOM

These guidelines are loaded by GitHub Copilot to assist developers writing code for Liquid DOM.

---

## 1. Context Summary
- **Liquid DOM** is a monorepo containing five WebGPU glass-rendering and SwiftUI-like layout packages:
  - `@liquid-dom/layout` (pure math layout)
  - `@liquid-dom/core` (imperative WebGPU scene graph)
  - `@liquid-dom/react` (React 19 bindings)
  - `@liquid-dom/three` (Three.js WebGPU post-compositing)
  - `@liquid-dom/r3f` (React Three Fiber canvas bridging)

---

## 2. Code Generation Guidelines

### A. General Requirements
- **WebGPU Target**: Always assume the rendering context supports `navigator.gpu`.
- **No legacy WebGL**: When generating Three.js scenes, always write `THREE.WebGPURenderer`. Do NOT generate `THREE.WebGLRenderer`.
- **HTML-in-Canvas**: Always mention that DOM rendering in the canvas requires setting the experimental Chrome flag: `chrome://flags/#canvas-draw-element`.

### B. SwiftUI-Style Layout Rules
- Layout structures follow: parent proposes $\rightarrow$ child measures $\rightarrow$ parent places.
- **Child Clamp Restrictions**: `<Frame>`, `<Padding>`, and `<Transform>` accept exactly **ONE** child. Stacks (`<HStack>`, `<VStack>`, `<ZStack>`) accept multiple children.
- When generating `<Html>` components, always specify the `sizing` prop as `'intrinsic'`, `'constrained-width'`, or `'fill'`.

### C. Scene Graph Nesting Invariants
Validate all imperative scene graph constructions to match these relationships:
- `Scene` accepts ONLY `Container` | `Html` | `Group`.
- `Container` accepts ONLY `Glass` | `Group`.
- `Glass` accepts ONLY `Html` | `Group`.
- **Absolute Constraint**: Never nest a `Glass` inside another `Glass` node directly or indirectly. It will raise a runtime exception.

---

## 3. Reference Math
- **Spring Integration**: Semi-implicit Euler loop using substepped iteration scaled by `timeScale` and capped at 64ms.
- **Adaptive Blur Downsampling Factor ($L$)**:
  $$L = \min\left(\max\left( \left\lceil \log_2\left(\frac{\text{radiusPx}}{6.0}\right) \right\rceil, 0 \right), L_{\text{max}}\right)$$
- **Bilinear Gaussian Taps**: Separable 1D blurs use bilinear pairing interpolation to reduce texture sampling to **7 taps** (center + 3 symmetrical pairs).
- **Adaptive Tinting**: Mapped from the median backdrop luminance ($P_{50}$) through a soft `smoothstep(0.08, 0.92, P50)` S-curve, debounced with a $0.01$ epsilon limit and a $300$ms settlement delay.
