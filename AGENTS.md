<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Model use

Always follow this section when orchestrating work or delegating to subagents. The pattern is: **write the code with the cheap model, then debug and review it with the expensive ones.**

Scores are 1–10, higher is better. Cost is value for money (higher = cheaper), intelligence is capability.

| Model                  | Cost | Intelligence | Use for                                                                                                                                              |
| ---------------------- | ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gpt-5.6-sol` (high)   | 1    | 9            | Last resort. Hard debugging, subtle correctness or security problems, and tasks the other models have already failed at.                             |
| Claude Opus 5 (high)   | 2    | 8            | Orchestration, task breakdown, planning, and architecture. Reviews the finished work and owns changes touching auth, permissions, or the data model. |
| `gpt-5.6-sol` (medium) | 4    | 7            | First escalation. Reviewing and debugging luna's output, and bug fixes luna could not land.                                                          |
| `gpt-5.6-luna` (max)   | 7    | 5            | **Default workhorse.** All delegated implementation: features, refactors, tests, boilerplate, Danish text, docs.                                     |

Rules:

- Delegate implementation to luna by default. Only write the code yourself or with a stronger model when luna has already failed at it, or when it touches auth, permissions, or the data model.
- Every delegated change gets a review pass from a stronger model afterwards. This is the normal flow, not an exception — cheap generation is only safe because review follows it.
- Escalate one step at a time on failure: luna → terra → Opus 5 → sol. Escalate on an actual failure, not in anticipation of one.
- Orchestration, task decomposition, and the final review stay with Opus 5 even though the implementation runs on luna.
- Never delegate a task that the orchestrator has not fully specified. luna does exactly what it is told, so the quality of the output is the quality of the task definition.
- Run independent subtasks in parallel instead of chaining them through one expensive model.
- State the chosen model and the reason when delegating, so the choice can be corrected.

## Breaking down tasks before delegating

Before sending anything to a subagent, split the work into tasks that are independently verifiable, and write each one out with:

1. **Goal** — what must be true when the task is done.
2. **Scope** — the files or modules to change, and what is explicitly out of scope.
3. **Context** — the relevant rules from this file (Danish UI text, organization scoping, server-side permission checks, shadcn/ui, Convex guidelines) and any existing pattern to copy.
4. **Constraints** — APIs, contracts, or schemas that must not change.
5. **Verification** — the command, test, or observable behaviour that proves it works.

If a task cannot be described this way, it is not ready to delegate: investigate it first, or split it further.

## Cursor Cloud specific instructions

Darkroom is a single-product Electron + Next.js 16 (static-export, webpack) desktop photo library. Standard commands live in `package.json`/`README.md`: `npm run lint`, `npm run build`, and `npm run electron:dev` (dev). No databases, secrets, or external services are needed.

Non-obvious caveats:

- **Run the GUI on the desktop display**: launch with `DISPLAY=:1 ELECTRON_DISABLE_SANDBOX=1 npm run electron:dev`. The container has no Electron sandbox, so it must be disabled, and the D-Bus / GPU-process errors printed to the log are benign. The Electron window (and a detached DevTools window) appear on `DISPLAY=:1`, viewable via computer use.
- **Auto-load photos without the native dialog**: the `Import` button opens a native OS folder dialog and is disabled outside Electron, so it is hard to drive programmatically. On launch the app auto-restores the last folder from `~/.config/darkroom/settings.json` — seed it with `{"lastFolderPath": "/workspace/public/demo"}` to load the 7 bundled demo photos (`public/demo`).
- `npm run dev` alone only serves the UI in a browser; native file access / IPC (`window.darkroom`) requires the full Electron app.
- Renderer console logs (`[darkroom:fs]`, `[Darkroom]`) go to the Electron DevTools console, not the `electron:dev` stdout/log.
- `scripts/capture-screenshots.mjs` mocks `window.showDirectoryPicker`, which the current import flow no longer uses (it uses Electron IPC), so that script is stale for driving imports.
- `npm run lint` currently reports pre-existing errors in the repo's existing code.
