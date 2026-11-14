---
name: no-native-select
description: Keeps every option picker on the site the site's own. A list to pick one option from is the `Select` in frontend/src/shared-components/Select.tsx, a box and a list drawn by the page, the same in Safari, Chrome and Firefox, never the browser's `<select>`, `<option>`, `<optgroup>` or `<datalist>`, which a hook refuses at the edit and frontend/scripts/no-native-select.sh fails in `npm run lint` and `npm run build`. Says how to use `Select`, which control a choice wants, how to replace a native picker, and how to check the picker in all three engines with a Playwright probe. Use when adding or changing a dropdown, select, selector, picker, combobox or listbox, or any control that picks one option from a list; when an edit is refused for a native select; when a picker looks like the operating system's or differs between browsers; when changing Select.tsx; or when the user asks to hunt for native selects, native pickers or inbuilt browser ui.
---

# No native selects

The browser draws its own `<select>`: a round glossy box on a mac, and an open list that belongs to the operating system, different in every browser, that no css reaches. On a site of square 1px boxes it is the one thing that is not the site's. So there are none. A list to pick one option from is `Select`, which the page draws: the same box in Safari, Chrome and Firefox, on a phone and with the keys.

## Refused

`<select>`, `<option>`, `<optgroup>`, `<datalist>`, and `createElement` of any of them, in `frontend/src` and `frontend/index.html`:

- at the edit, by `.cursor/hooks/no-native-select.sh` (a `preToolUse` hook in `.cursor/hooks.json`). It names the lines.
- at `npm run lint` and `npm run build`, by `frontend/scripts/no-native-select.sh`, so it fails the docker build too.

Do not go round it. Not a select restyled with `appearance-none` (the box takes css, the open list never does), not one written through `dangerouslySetInnerHTML` or a string of html, not a select out of a package. Prose and comments name the tag without its bracket ("the browser's select"), since the check reads lines, not syntax.

## Use `Select`

```tsx
import { Select } from '@/shared-components/Select';

<div className="flex min-w-0 items-center gap-1.5 text-xs text-textSecondary">
  <span className="shrink-0">reads</span>
  <Select
    id="face-camera"
    label="the camera that reads your face"
    value={camera}
    options={[{ value: '', label: "the browser's camera" }, ...cameras.map((c) => ({ value: c.id, label: c.label }))]}
    onChange={(id) => void setFaceCamera(id)}
    className="min-w-0 flex-1"
  />
</div>
```

| Prop | What |
|---|---|
| `id` | the box's id. The open list is `#<id>-list`; an option in it wears `data-value`, the box wears the `data-value` that is on |
| `label` | its name for a screen reader (`aria-label`). Always: the box is a `div`, and a `<label htmlFor>` cannot name a div. A word beside it on the page stays a `span` |
| `value`, `options`, `onChange` | strings. `options` is `{ value, label, disabled? }[]`. `onChange` gets the value picked, not an event, and only when it is another than the one that is on |
| `placeholder` | what the box says while `value` is none of the options |
| `disabled` | dim, takes no focus |
| `className` | the box's width (`w-full`, `min-w-0 flex-1`) and, for a bigger one, its padding (`px-3 py-2`). It wears the type size of what it sits in, and so does its list |

What it already does, so no caller adds it: opens under the box (over it at the window's foot), stays in the window, is as wide as its longest option, scrolls past 240px, follows its box through a scroll, draws into the modal `<dialog>` it is in; arrows, home, end, page keys, enter, space, escape (the list's alone: a dialog stays open), tab, letters typed; the focus never leaves the box. `Select.tsx`'s own comment has the why of each.

In a test: `page.click('#face-camera')`, then `page.click('#face-camera-list [data-value="…"]')`; what is on is `#face-camera`'s `data-value`. There is no `selectOption`.

## Is it a `Select` at all

| The choice | The control |
|---|---|
| one of a list that is long, or as long as the data makes it (the cameras a face can be read from) | `Select` |
| one of a few fixed things, each worth seeing | all of them on show: `OptionCard`, a radio as a card (`user-modal/parts.tsx`), or words pressed (`aria-pressed`, the role editor's cooldown) |
| something to do, off a list (give a role, add a source) | a menu, `role="menu"`: `HoverMenu` in `ServerRoom.tsx`, `AddMenu` in `Sources.tsx` |
| words typed, finished from a list | `comboProps` and `SearchSuggestions` in `ChatSearch.tsx`. That is what a datalist would have been |

## Replace one

`sh frontend/scripts/no-native-select.sh` prints every one in the source, and exits 1 when there is any. One a package drew is not in the source: `document.querySelectorAll('select, datalist')` on the running page finds it, and what draws it goes.

| It was | It is |
|---|---|
| `<select id value onChange={(e) => f(e.target.value)}>` | `<Select id label value options onChange={f}>` |
| `<option value="a">words</option>` | `{ value: 'a', label: 'words' }` |
| a first `<option value="">pick one</option>` that is a hint, not a choice | `placeholder="pick one"` |
| a `<label htmlFor>` around it | a `div` with the word in a `span`, and `label=` on the `Select` |
| `<optgroup>` | `Select` has none. A list long enough to want headings wants another control: ask |

Change nothing else in the same pass. The id stays, so the docs and the tests that name it stay true; a test that used `selectOption` changes as above.

Not findings, leave them: `type="color"` (the colour wells still open the browser's colour picker; the site has none of its own yet), `type="file"` (always hidden behind a site button; the file dialog is the operating system's and there is no other), `type="range"` (a slider has no list, and takes the site's colours). A date or a time box would open a browser picker too; the site has none: ask before adding one.

## Check

```bash
cd frontend && sh scripts/no-native-select.sh && npx tsc --noEmit
```

After any change to `Select.tsx` itself, the probe:

```bash
node .cursor/skills/no-native-select/scripts/probe.mjs            # chromium, webkit, firefox
node .cursor/skills/no-native-select/scripts/probe.mjs safari     # one engine (webkit; `chrome` is chromium)
SHOTS=/tmp/select-shots node .cursor/skills/no-native-select/scripts/probe.mjs   # and a picture of the open list from each
```

It mounts `Select` alone (`scripts/harness.tsx`) and walks it in Chromium (Chrome, Edge), WebKit (Safari) and Firefox: where the list opens, the pointer, every key, a pane that scrolls, a modal dialog, a long list, the window's foot and edge, then a 360px window with a finger. It starts a vite of its own with its own cache, so `npm run dev` neither has to be up nor is disturbed, and asks no backend for anything. Playwright comes from `test/node_modules`; the engines once: `cd test && npx playwright install chromium webkit firefox`. An engine that is missing fails the run. Exit 0, or fix what it printed.

A new behaviour gets a step in the probe and, where it needs one, a fixture in the harness. Break the behaviour once to see the step fail: a step that cannot fail checks nothing.

What the probe cannot see: Safari itself (WebKit is its engine, not its chrome), a screen reader, and Firefox where scrollbars take room (on a mac its bars float; `place` in `Select.tsx` says what is done for the others).

## Report

End with two lists and nothing softer:

- **Replaced.** File, the id, and what it was.
- **Left.** Anything on the "not findings" list that was asked about, and anything that wanted an `<optgroup>` or was not a `Select` at all, with the control it should be.

If there was nothing to replace, say so in one line, with the check that said so.
