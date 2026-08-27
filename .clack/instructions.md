# Claude Code & Clack Agent Guidelines for Liquid DOM

This file provides system instructions for console-based coding agents (like Claude Code) operating in the Liquid DOM monorepo.

---

## 1. Environment & Monorepo Operations

The codebase is built using `pnpm` monorepo workspaces. Always run packages builds and tests using the filters:

- **Install Workspace**: `pnpm install`
- **Build All**: `pnpm -r build`
- **Layout Tests**: `pnpm --filter @liquid-dom/layout test`
- **Core Tests**: `pnpm --filter @liquid-dom/core test`
- **React Tests**: `pnpm --filter @liquid-dom/react test`

When building, executing scripts, or resolving typescript compilation issues, make sure to compile dependencies (`@liquid-dom/layout` and `@liquid-dom/core` first) before testing higher-level packages (`@liquid-dom/react`, `@liquid-dom/three`, `@liquid-dom/r3f`).

---

## 2. Code Refactoring & Contribution Rules

When editing files in `packages/`:

### A. Core Physics & Layout Calculations
- Do NOT rewrite or simplify the spring Euler substepping code in `@liquid-dom/react` or `@liquid-dom/core` unless requested. The substepping ($dt_{\text{spring}}$ split into 60Hz slices) is critical to prevent numerical integration explosion.
- Do NOT alter the bilinear tap-pairing coordinates `[1.4584295, 3.4039848, 5.3518057]` or weights `[0.23933733, 0.1394403, 0.052710965]`. These are mathematically tuned to match a standard Gaussian distribution ($\sigma = 3$) at 7 taps.

### B. Interface Separations
- **Layout engine (`@liquid-dom/layout`)**: Maintain zero DOM references, zero CSS references, and zero WebGPU resources.
- **Core rendering (`@liquid-dom/core`)**: Maintain strict hierarchy validations inside scene node additions (`Scene.add`, `Container.add`, `Glass.add`). Do NOT allow `Glass` components to accept other `Glass` children.
- **Three adapter (`@liquid-dom/three`)**: Require and assert the presence of `WebGPURenderer`. Guard with features checkers.

---

## 3. Pull Request & Verification Standards
- Before completing a task, run the TypeScript compiler `tsc` or package bundlers to verify that type signatures match across dependencies.
- Ensure all tests pass.
- Maintain existing docstrings and comments. Do not delete them.
