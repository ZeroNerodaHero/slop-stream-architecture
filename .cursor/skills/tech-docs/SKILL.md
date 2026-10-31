---
name: tech-docs
description: Write and update the human docs in docs/tech-docs, short caveman-voice html pages with css animations, served at http://localhost:42069/tech-docs while `npm run dev` runs with SHOW_DOCS=1 in .env. Reads the last 100 commits (scripts/context.sh) to find what moved since the docs last looked, rewrites the pages that cover it, and keeps the "what moved lately" page. Use when the user asks to update, refresh, catch up, or write the tech docs, human docs, caveman docs, simple docs, or the /tech-docs pages, or after a run of commits.
---

# Tech docs

The long docs (`docs/*.md`) are for a person or an llm building this. The tech docs are for a person who wants to know what it does, in five minutes, with nothing to install. Short sentences, small words, a moving picture where the long doc has a paragraph. Every fact in them is a fact in the long docs or the code; the voice is the only thing that is simpler.

## Where

| Path | What |
|---|---|
| `docs/tech-docs/*.html` | one page per topic, plain html, no build. `index.html` is the map |
| `docs/tech-docs/style.css` | the look (the site's palette, 1px strokes, no radius, no shadow) and every animation. pages use its classes and add no css of their own |
| `docs/tech-docs/built-from` | the short sha of the commit the docs last looked at. `context.sh` reads it, you write it last |
| `frontend/vite.config.mts` (`techDocs`) | serves the folder at `/tech-docs` when `SHOW_DOCS=1` in the repo's `.env`. a saved page reloads the tabs on that page |
| `.cursor/skills/tech-docs/template.html` | copy it for a new page |

The reader opens `http://localhost:42069/tech-docs/`. Links between pages are `name.html`, relative, so the folder works from anywhere.

## Context: the last 100 commits, no further

```bash
sh .cursor/skills/tech-docs/scripts/context.sh
```

It prints, in order: where the docs stand (`built-from`, `HEAD`, how many commits between); the window, the last 100 commits one line each; the range (since `built-from`, or the whole window the first time, or when `built-from` fell out of it), per commit, with the long docs and the code it touched; the files that moved most; the `.env.example` and `docker-compose.yml` diff (new knobs, new boxes); the words added to `docs/*.md`. Commit subjects in this repo are often one word, so the files are the signal and the long docs are the meaning.

Then, for each topic the range touched: read the current `docs/<topic>.md` for the part that moved (it is the truth, and it is long: find the section, do not read the file top to bottom), and the current code only where the doc is silent. `--patch <pathspec>` gives the range's code diff for one path when the stats are not enough.

Do not look past the window. Not `git log` beyond 100, not an old sha's `git show`, not the reflog. What is older than 100 commits is documented by reading the current files, not by digging. Uncommitted work is not in the range and not in the docs; say so if asked. A range of zero commits means the docs are current: say that and stop.

## Voice

Caveman. Not a joke, a constraint: a reader with no time and no jargon.

- Ten words or fewer a sentence. One idea a sentence. A full stop, then the next.
- Words a child knows. box, not container. talk, not communicate. remember, not persist. forget, not expire. copy, not relay. keep, not store.
- A real name is said once, in `<code>`, then explained in small words, then the small words are used. `<code>redis</code>. a fast memory box. it forgets when it restarts.` Then: "the memory box".
- Verbs in their plain form, articles dropped where the sentence still reads. `api save bio. video copy stream. one upload in, many copies out.` Keep the article when dropping it reads wrong.
- `you` is the reader. `streamer` and `watcher` are the two roles. No "me", no "ugh", no grunting.
- Every number from the long doc survives: 500 lines, one line a second, 30 things, a week. A number is a fact, not jargon.
- Lowercase, like the long docs. No emoji. No exclamation marks.
- What is a plan and not built says so first: `not built yet. plan only.` in an `<aside class="plan">`.

| The long doc says | The page says |
|---|---|
| the password is hashed on the server (argon2id) and never stored | password go to server. server scramble it. <code>argon2id</code> is the scrambler. only the scramble is kept. real password is never kept. |
| `XADD chat:<name> MAXLEN ~ 500 *` appends and trims, `XREVRANGE … COUNT 200` is the history | every line go into the memory box. box keep last 500. older lines fall off. new watcher gets last 200. |
| the gateway fans each fact out to the sockets that watch the name | one wire per browser. browser says which names it watches. a fact about that name comes down the wire. no asking, no polling. |

## Pages

| Page | Retells |
|---|---|
| `index.html` | the map. one animated picture of the whole thing, one line per page, the date it last looked |
| `start.html` | what this is, how to run it, how to work on it (`overview.md`) |
| `boxes.html` | every container and what talks to what (`docker-compose.yml`, `overview.md`, `architecture-picture.md`) |
| `stream.html` | a stream's life: go live, video, watchers, the picture, viewers, sources and layers, the calendar (`status.md`, `viewers.md`, `screen.md`, `calendar.md`) |
| `chat.html` | the three chats and their limits (`chat.md`, `chats.md`) |
| `people.html` | accounts, presence, names and ids, follows, friends, dms, the inbox (`accounts.md`, `status.md`, `ids.md`, `follows.md`, `dms.md`, `notifications.md`) |
| `groups.html` | groups as servers: badges, roles, owners, rooms (`groups.md`) |
| `pages.html` | the screens: home, go live, watch and its tabs, the side column, the user modal (`overview.md`, `about.md`, `socials.md`) |
| `ops.html` | deploy, update, the `.env` knobs, health, errors, the look-inside tools (`overview.md`, `debugging.md`, `.env.example`) |
| `plans.html` | what is a plan, not a build (`docs/README.md`) |
| `new.html` | what moved lately: the range, grouped by topic, in the voice, dated |

A new topic gets a new page only when no page above owns it and the long docs gave it a file of its own. Copy `template.html`, name the file after the topic, add one line to `index.html`. Otherwise it is a section on the page that owns it. A page under 40 lines is a section, not a page.

Every page: `<title>`, the `<nav>` link back, one `<h1>`, a `<p class="lead">` saying what the page is in one line, `<section>`s with an `<h2>` each, a `<footer>` naming the long doc. Nothing else in `<head>`: no script, no font, no second stylesheet.

## Animation

Css only, in `style.css`, reached by class. A page is words and boxes. No `<img>`, `<video>`, `<audio>`, `<svg>`, `<canvas>`, `<iframe>`, no `url()`, no script, nothing fetched. No box shadow (`.cursor/rules/no-box-shadow.mdc`). No border radius. Every animation shows a fact; a thing that only decorates is cut.

| Class | Shows | Use it for |
|---|---|---|
| `.pic` + `.box` + `.flow` | boxes with a line between, dots travelling along it. `data-say` labels the line. `.flow.back` reverses, `.flow.both` goes both ways, a second `<i>` is a second packet | data moving: a stream in and copies out, a fact on the wire, a write into a store |
| `.pic.stack` | the same, top to bottom | a sequence in time, or a tall picture on a narrow screen |
| `.box.hot` `.box.store` `.box.ghost` | blue stroke: the box the section is about. dashed: it remembers things. dotted and grey: optional or not built | telling the boxes apart without colour alone |
| `.sq.on` `.sq.stream` `.sq.dnd` `.sq.off` | the presence square: green, blue, red, grey. `.sq.live` blinks | presence, live |
| `.pulse` | the stroke breathes blue | a box doing work right now |
| `.type` with `--n` | the words appear as if typed, a cursor blinking at the end | a line being written: a chat line, a command |
| `.steps` | list items appear one after another | a sequence: what happens when you click go live |
| `.bar` with `--t` | a bar fills over `--t` seconds, then empties, then again | a limit filling: 500 lines, one line a second, a week |
| `.count` with `--to` | a number counts up to `--to` | how many: watchers, followers, 30 things in the inbox |
| `.shake` | a box shakes once on hover or focus | a refusal: too long, too fast, not yours |

The only `style=` a page carries is one custom property for one of these: `style="--n: 21"`, `style="--t: 5s"`, `style="--to: 30"`. Anything else is a class in `style.css`.

Everything stops under `prefers-reduced-motion: reduce`, and the end state must still read: the dots gone, the bar full, the words there. A new animation goes into `style.css` next to its kind with a two-line comment saying what fact it shows, and into this table.

## Write

1. `context.sh`. Note the range, the topics, the knobs.
2. For each topic touched: open its page and the long doc's section. Rewrite the sentences that are no longer true, add the ones for what is new, in the voice. Keep the numbers. Move a thing from a `plan` aside into the page when the long doc or `docs/README.md` now says built.
3. `new.html`: a section for this range, newest at the top, dated with the range's last commit date. Group the commits by topic, not one line per commit: a reader wants "chat can now be searched", not twelve "added" lines. Link each group to its page. Keep the five latest sections; drop the oldest past that.
4. `index.html`: a new page gets its line; the date in the footer is the range's last commit date.
5. `built-from`: the short sha of `HEAD`, nothing else in the file.
6. Check.

Write pages whole with the Write tool when more than half of one changes; otherwise edit in place. Do not touch `style.css` for a one-page need; reach for the classes above first.

## Check

```bash
sh .cursor/skills/tech-docs/scripts/check.sh
```

No media tag, no `url()`, no script, no remote stylesheet, no box shadow; every link resolves inside the folder; every page has its title, main, nav link and stylesheet and is on the index; `style.css` keeps its reduced-motion block; `built-from` is a real commit. When the dev server is up with `SHOW_DOCS=1` it GETs every page through `http://localhost:42069/tech-docs/` too. Exit 0 or fix what it printed.

Then read one changed page back as a reader would: ten words a sentence, small words, a number kept, the picture showing the fact.

## Report

End with three lists and nothing softer:

- **Updated.** Page, and the one-line fact that changed on it.
- **New.** Page, and why it earned a page and not a section.
- **Left.** A topic the range touched that no page tells, and why (the long doc is silent, the change is inside the code and changes nothing a reader sees, the work is uncommitted).

If the range was empty, say so in one line, with `built-from` and `HEAD`.
