# AI Agent Task Strategy & Behavior Guidelines

This document establishes the official persona, task decomposition guidelines, and design/math reference standards for AI agents (such as Cursor, Copilot, Claude Code, Antigravity, and Codex) contributing to or using the `liquid-dom` codebase.

---

## 1. Agent Persona & Design Orientation

When acting as an assistant or code generator within this repository, agents MUST prioritize **visual excellence, performance, and math-driven correctness**:

1. **Rich & Curated Aesthetics**: 
   - Never write CSS containing generic, plain primary colors (`red`, `blue`, `green`, `#fff`).
   - Use premium, curated palettes (e.g., custom HSL tokens, glassmorphism overlays, and dark modes).
   - Integrate smooth transition gradients and subtle micro-animations to make interfaces feel reactive and alive.
2. **Performance First**:
   - Guard against main-thread bottlenecks. Core layout calculations and spring/easing animations are off-react by design, ticked via RequestAnimationFrame (RAF). Maintain this separation.
   - Minimize texture redraws and layout recalculations.
3. **Scientific Precision**:
   - Rely strictly on physical constants and proven calculations (spring Euler integration, Cubic Bezier, Gaussian downsample mapping, $P_{50}$ backdrop metrics). Do not guess or approximate formulas.
4. **Humility & Code Integrity**:
   - Retain all unrelated comments and docstrings when refactoring.
   - Provide humble, evidence-based descriptions of updates (no superlatives like "flawless", "perfect", or "100% correct").

---

## 2. Agent Task Decomposition Protocol

When an agent receives a request to modify or add code, it must follow this execution cycle:

```txt
┌──────────────────────────────────────────────┐
│  Phase 1: Research, Checks & Invariant Audit  │
│  - Verify WebGPU and Chrome Flag contexts.   │
│  - Audit constraints (e.g., nesting rules).  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  Phase 2: Mathematical Layout & SDF Design   │
│  - Plan SwiftUI-style stack hierarchy.        │
│  - Design spring/easing transition dynamics. │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  Phase 3: Core/React Component Generation    │
│  - Draft off-react code & reactive bindings.  │
│  - Enforce single-child rules on decorators.  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  Phase 4: Multi-Package Sync & Verify        │
│  - Rebuild dependency workspace packages.     │
│  - Run tests on layout/core, build output.   │
└──────────────────────────────────────────────┘
```

1. **Research & Environmental Audit**:
   - Check if the code impacts layout logic, rendering passes, or integration layers.
   - Verify that any WebGPU resource allocations are properly disposed of to avoid memory leaks.
2. **Mathematical Analysis**:
   - When introducing animations, verify parameters ($k$, $c$, $m$) fit within the substepped Euler integrator to avoid simulation instability.
3. **Verification**:
   - Compile changes recursively across package bounds using `pnpm -r build` before declaring a task complete.

---

## 3. Core Engine Invariants (Reference Card)

AI agents must enforce these constraints at all times. If a user request asks for code violating these rules, the agent should refuse and propose a correct alternative.

### A. Scene Graph Parenting Hierarchy
- `Scene` $\rightarrow$ Accepts `Container`, `Html`, and `Group`.
- `Container` $\rightarrow$ Accepts `Glass` and `Group`.
- `Glass` $\rightarrow$ Accepts `Html` and `Group`.
- **Absolute Limit**: Never stack or nest `Glass` under another `Glass` node directly or indirectly. Stacking must be achieved as sibling nodes inside a `ZStack` layout.

### B. SwiftUI-Style Layout Child Limits
- **Single-Child Blocks**: `<Frame>`, `<Padding>`, and `<Transform>` accept EXACTLY one layout child node.
- **Multi-Child Blocks**: `<HStack>`, `<VStack>`, and `<ZStack>` accept multiple children.

### C. HTML Sizing Prop Keys
When utilizing `<Html>`, the `sizing` prop must be exactly one of:
- `'intrinsic'`: Sized by DOM content size.
- `'constrained-width'`: Width proposal clamped by parent; height computed by wrapping.
- `'fill'`: Clamped to parent dimensions in both directions.

### D. Physics Integration Math
Spring ticks must run on a substepped integrator:
$$dt_{\text{spring}} = \min(0.064, dt \times \text{timeScale})$$
$$\text{stepCount} = \max\left(1, \left\lceil \frac{dt_{\text{spring}}}{1/60} \right\rceil\right)$$
$$a = \frac{-k \cdot (x - x_{\text{target}}) - c \cdot v}{m}$$
$$v_{\text{next}} = v + a \cdot \text{stepSeconds}$$
$$x_{\text{next}} = x + v_{\text{next}} \cdot \text{stepSeconds}$$

### E. Adaptive Blur Level Selection ($L$)
$$L = \min\left(\max\left( \left\lceil \log_2\left(\frac{\text{radiusPx}}{6.0}\right) \right\rceil, 0 \right), L_{\text{max}}\right)$$

### F. Adaptive Tint Easing
$$\text{current} = \text{current} + (\text{target} - \text{current}) \times \left(1 - e^{-dt / 0.5}\right)$$
States are stored inside a `WeakMap<Container, State>()` to isolate overlays and prevent memory leaks.
