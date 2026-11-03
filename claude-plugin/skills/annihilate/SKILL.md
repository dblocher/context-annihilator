---
name: annihilate
description: Hand the current task to a fresh background Claude Code session seeded with a reduced context. Runs entirely in a hook.
argument-hint: "[next instruction for the new session]"
disable-model-invocation: true
---

The Context Annihilator hook normally blocks this command before it reaches the model. If you are reading this, the hook did not run.

Do not take any other action. Reply with exactly this sentence and stop:

Context Annihilator hook is not active, so no handoff was made.
