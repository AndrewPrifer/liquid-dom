# AI Agent Integration Guide for Developers & Vibecoders

To make building premium glass user interfaces with `liquid-dom` incredibly fast and error-free, this repository includes a dedicated, deep-context **AI Agent Integration Layer**. 

Whether you are using **Cursor**, **Claude Code**, **GitHub Copilot**, **Antigravity**, or building custom agentic workflows, this guide explains how to leverage these resources to supercharge your developer velocity.

---

## 1. Map of the AI Resource Files

We have pre-baked context files in standard locations that AI tools look for automatically:

```txt
liquid-dom/
├── llms.txt                  # Concise project summary, constraints & packages (discovery)
├── llms-full.txt             # Deep technical specification, exact API signatures & math formulas
├── agents.md                 # Math constants, strict nesting validations & agent task guidelines
├── AI_AGENT_GUIDE.md         # This user manual
├── .cursor/
│   └── rules/
│       ├── core-architecture.mdc  # Package hierarchies, WebGPU, and scene graphs validation
│       ├── react-components.mdc   # Layout parameters, stacks, sizing modes, and R3F
│       ├── animation-system.mdc   # Physical spring steps, bezier curves, and custom update loops
│       └── adaptive-tint-blur.mdc # Decimation Gaussian math and backdrop luminance state rules
├── .github/
│   └── copilot-instructions.md    # GitHub Copilot VS Code workspace context rules
└── .clack/
    └── instructions.md            # Claude Code/Clack-specific memory injection guidelines
```

---

## 2. Setting Up Your AI Environments

### A. Cursor IDE
Cursor automatically parses and indexes files inside `.cursor/rules/` that end in `.mdc`.
- **Automatic Loading**: When you edit files under `packages/core` or `packages/react`, Cursor automatically applies the matching MDC file bounds behind the scenes.
- **Explicit Mentioning**: In Cursor Chat (Ctrl+L) or Cursor Composer (Ctrl+I), type `@` followed by the rule name (e.g. `@core-architecture` or `@react-components`) to instantly inject the detailed WebGPU and layout invariants into the conversation context.

### B. Claude Code / Clack (Console Agent)
Claude Code and other console-based CLI agents are designed to perform deep research and task execution.
- **Memory Injection**: When initiating a refactoring task, instruct the agent:
  > *"Analyze the layout and rendering boundaries defined in [instructions.md](file:///.clack/instructions.md) and [agents.md](file:///agents.md) before refactoring packages."*
- This forces the agent to read the workspace rules and run validation builds (`pnpm -r build`) and package tests after making changes.

### C. GitHub Copilot
GitHub Copilot reads instructions placed inside `.github/copilot-instructions.md` within VS Code.
- No manual setup is required. VS Code automatically loads these rules as workspace guidelines. Copilot will now automatically prefer `WebGPURenderer` over standard WebGL when you ask it to generate Three.js scripts in this workspace.

### D. Custom AI Workflows & RAG Systems
If you are running custom developer agents (such as Antigravity):
- Point your agent's retriever or context injection module directly to `llms-full.txt` and `agents.md`.
- These contain all mathematical formulas (Euler integration splits, 7-tap bilinear Gaussian pairing constants, and backdrop S-curves) written out as pure text, preventing the agent from fabricating values or hallucinating math.

---

## 3. Recommended Prompts for Vibecoding

Try these prompts to see the power of the AI Integration Layer:

### *Prompt 1: "Make a premium translucent glass card in React"*
> **Vibecoder Prompt**: *“Generate a React 19 glass card component using `@liquid-dom/react` that scales when hovered and opens a text description panel. Reference `@react-components` and `@animation-system` for rules.”*
>
> **Why it works**: The agent will automatically reference the SwiftUI-style stack layout container bounds, ensure the hover spring has proper stiffness and damping values, select an intrinsic/fill HTML sizing mode, and bypass standard React renders using `transition` props or `useAnimate` to guarantee a smooth 60fps frame rate.

### *Prompt 2: "Mount glass UI in a React Three Fiber scene"*
> **Vibecoder Prompt**: *“Set up a Three.js Canvas with React Three Fiber, configure it for WebGPU, and overlay a glass title card using `@liquid-dom/r3f`. Reference `@core-architecture`.”*
>
> **Why it works**: The agent will refuse to generate standard WebGL code, create a `THREE.WebGPURenderer` context, apply the correct scene hierarchy (Root -> Scene -> GlassContainer -> Glass), and configure a `<LiquidGlassR3F.Render>` component with a positive rendering priority.
