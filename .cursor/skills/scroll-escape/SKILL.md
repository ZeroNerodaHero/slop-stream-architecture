---
name: scroll-escape
description: Hunt the frontend for absolutely positioned boxes (sr-only inputs and labels above all) whose containing block is outside their scroll container, and for controls whose focus scrolls an overflow-hidden ancestor. A static search of the tsx, then a Playwright probe against the dev server that checks every absolute box, every overflow-hidden box, and focuses every control. Use when a dialog, panel, card, or pane goes blank, jumps, or scrolls on a click, a tab, or a label; when adding an sr-only control or an absolute child; or when the user asks to hunt for scroll escape, sr-only, overflow-hidden, or containing-block bugs.
---

# Scroll escape

Find every `absolute` box that lives outside its scroller, and every control whose focus can scroll a box that cannot be scrolled back. Fix each with `relative` on the wrapper (`.cursor/rules/relative-parent.mdc`). Do not restyle anything else in the same pass.

## The shape

`absolute` places a box in its nearest positioned ancestor. When no ancestor between the box and its scroll container is positioned, the box escapes: it sits at its unscrolled place, it does not move with the pane, and it hangs out of whatever holds the scroller, which gives that element scrollable overflow. `overflow-hidden` does not save it: the browser scrolls a hidden-overflow box when something inside is focused or scrolled into view, and no bar or wheel brings it back.

The user modal went blank this way: `OptionCard`'s `sr-only` radio had the pane wrapper as its containing block, a card low in the chat tab put it 1800px under the `<dialog>`, the label click focused it, and the dialog scrolled its rail and pane out of sight. The three signs, in the probe's words:

| Kind | What it is | What to do |
|---|---|---|
| `escaped` | An `absolute` box whose containing block is outside its nearest scroller. `srOnly` and `focusable` say how bad: a focusable one blanks or jumps a pane; a label or word only adds phantom overflow | Fix. `relative` on `parent` |
| `focus` | Focusing the control moved an `overflow-hidden` ancestor by `by` pixels. The proof, with the amount | Fix the `escaped` box it points at. Re-run until none |
| `overflow` | An `overflow-hidden` box with scrollable overflow and a focusable inside, and the five things sticking out the farthest | A culprit list. With a matching `escaped` or `focus`, fix those. With neither, it is a clip by design: say so, leave it |

## Search

First the tree, by hand. Every `sr-only` and every `absolute`, and the element that wraps each:

```bash
cd frontend && rg -n -B3 'sr-only' src --glob '*.tsx'
rg -n -B3 '\babsolute\b' src --glob '*.tsx'
```

For each hit, read the wrapping element's `className`. It passes when it has `relative`, `absolute`, `fixed`, or `sticky`, directly or through a constant (`SQUARE` in FriendChat.tsx is `relative block shrink-0`). It fails when it is `static`: nothing positioned until some ancestor far above. A component that renders an `absolute` box (`PresenceSquare`, the unread counts, the × on a face) is fine when every caller wraps it in `relative`; check the callers, not the component.

`absolute` children of the `<dialog>`, of a `fixed` panel, or of `body` are fine: the containing block is the scroller or outside every scroller.

## Probe

Then the running page. The dev server is `npm run dev` in `frontend` on `http://localhost:42069`; the probe uses Playwright from `test/node_modules` (`cd test && npm install` once).

```bash
node .cursor/skills/scroll-escape/scripts/probe.cjs [url] [step ...]
```

A step is a css selector to click (a js click, so a control hidden until hover works), `goto:<path>`, or `wait:<ms>`. The page is audited at the start and after every step. Exit 1 when anything `escaped` or `focus` came up.

The surfaces of this site, logged out:

```bash
node .cursor/skills/scroll-escape/scripts/probe.cjs \
  '#settings' '#tab-profile' '#tab-groups' '#tab-security' '#tab-notifications' \
  '#tab-appearance' '#tab-chat' '#tab-sidebar' '#tab-advanced' '#user-modal-close' \
  '#notifications' 'goto:/groups' 'goto:/live' 'goto:/watch/a' 'goto:/login'
```

Logged in (`LOGIN=name:password` goes through `/login` first; make the account with `POST /api/signup` the way `test/*.js` does, or use one you have): add `'#chats-open'` for the friend chat window, `'#notifications'` for the inbox, and the group pages under `goto:/groups/<server>`.

Known clips, by design, not findings: the corner panel (`div.absolute.top-0.flex` in UserPanel.tsx) reports `overflow` of ~137px in x. It is the collapsed sidebar clipping its full width until hover or focus widens it; no `focus` finding goes with it.

## Fix

`relative` on the element that wraps the `absolute` box: the `<label>`, the card, the row. One class. Then the probe again: the `escaped` line is gone, the `overflow-hidden` box's `scrollHeight` equals its `clientHeight`, and no `focus` line names it.

Not a fix, do not take it: `tabIndex={-1}`, `focus({ preventScroll: true })`, `overflow-clip` on the dialog, a `scrollTop = 0` after the click. Each hides one symptom of a box that is still in the wrong place.

## Report

End with two lists and nothing softer:

- **Fixed.** File, the wrapper that got `relative`, and the probe line (`escaped` or `focus`) that is gone.
- **Left.** Every `overflow` with no `escaped` or `focus` beside it, with the one-line reason it is a clip by design.

If the sweep was clean, say so in one line, with the surfaces it covered.
