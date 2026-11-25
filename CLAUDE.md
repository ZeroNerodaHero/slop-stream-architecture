# Agent rules

Read and follow every file in `.cursor/rules/`. Most important: never write code comments (`.cursor/rules/no-comments.mdc`).

Every floating or draggable window registers with the shared window stack (`useStackedWindow`) and comes to the front on pointerdown; never hardcode a z-index for a window (`.cursor/rules/window-stacking.mdc`).
