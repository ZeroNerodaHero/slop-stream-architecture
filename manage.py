#!/usr/bin/env python3
"""
the screen behind ./scripts/manage.sh: the stack's postgres and redis, in a terminal, read-only.
see that file's header for how to run it. this file is not run on its own: manage.sh
checks docker, python and the containers and hands over with MANAGE_* in the environment.

every question goes through `docker compose exec -T <container> <psql|redis-cli> ...`,
here or over ssh (MANAGE_TO), so nothing has to be installed where the stack runs and no
port has to be open. psql answers in csv (nulls as ∅), redis-cli in json. the screen is
curses from python's standard library: a list of things, a thing, scroll, page, filter.

keys, everywhere: ↑↓ jk move, pgup pgdn (or ctrl-u ctrl-d) page, g G top and bottom,
←→ hl scroll the columns, enter opens, q or esc goes back, r asks again, ? says this.
"""

import csv
import curses
import io
import json
import os
import shlex
import subprocess

MODE = os.environ.get("MANAGE_MODE", "db")
DB = os.environ.get("MANAGE_DB", "stream")
TO = os.environ.get("MANAGE_TO", "")
DIR = os.environ.get("MANAGE_DIR", "slop-stream-architecture")

PAGE = 200          # rows a table view asks for at a time
MAX_COL = 40        # a cell wider than this is cut with …
NULL = "∅"          # what psql prints for null (-P null)


class ManageError(Exception):
    pass


# ---- reaching the containers -----------------------------------------------------------------


class Runner:
    """`docker compose exec -T <service> <args>`, here or on the box. One call, one answer."""

    def __init__(self, to, directory):
        self.to = to
        self.dir = directory

    def run(self, service, args, stdin=None):
        local = ["docker", "compose", "exec", "-T", service, *args]
        if self.to:
            inner = "cd " + shlex.quote(self.dir) + " && " + " ".join(shlex.quote(a) for a in local)
            if self.to.startswith("gcloud:"):
                cmd = ["gcloud", "compute", "ssh", self.to[len("gcloud:"):], "--quiet", "--command", inner]
            else:
                cmd = ["ssh", self.to, inner]
        else:
            cmd = local
        try:
            p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            raise ManageError("no answer in 60s") from None
        except FileNotFoundError as e:
            raise ManageError(f"{e.filename} is not installed here") from None
        if p.returncode != 0:
            raise ManageError(reason(p.stderr or p.stdout) or f"exit {p.returncode}")
        return p.stdout


def reason(text):
    """The line that says what went wrong: psql's `ERROR:` line, else the first one with anything on it."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if line.startswith("ERROR") or line.startswith("psql:") or line.startswith("ssh:"):
            return line
    return lines[0] if lines else ""


def sql_string(text):
    """A string literal. For the names the screen itself read out of the catalog."""
    return "'" + text.replace("'", "''") + "'"


def sql_ident(name):
    return '"' + name.replace('"', '""') + '"'


class Postgres:
    def __init__(self, runner, db):
        self.runner = runner
        self.db = db

    def query(self, sql):
        """Headers and rows. Inside a read-only transaction that is rolled back: nothing typed here can write."""
        out = self.runner.run(
            "database",
            ["psql", "-U", "stream", "-d", self.db, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-P", f"null={NULL}",
             "-c", "BEGIN READ ONLY", "-c", sql, "-c", "ROLLBACK"],
        )
        rows = list(csv.reader(io.StringIO(out)))
        if not rows:
            return [], []
        return rows[0], rows[1:]

    def databases(self):
        _, rows = self.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")
        return [r[0] for r in rows]

    def tables(self):
        return self.query(
            'SELECT relname AS "table", n_live_tup AS "rows (about)", pg_size_pretty(pg_total_relation_size(relid)) AS "size",'
            ' (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = \'public\' AND c.table_name = relname) AS "columns"'
            " FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname"
        )

    def columns(self, table):
        return self.query(
            'SELECT column_name AS "column", data_type AS "type", is_nullable AS "nullable", column_default AS "default"'
            f" FROM information_schema.columns WHERE table_schema = 'public' AND table_name = {sql_string(table)} ORDER BY ordinal_position"
        )

    def indexes(self, table):
        return self.query(f'SELECT indexname AS "index", indexdef AS "definition" FROM pg_indexes WHERE schemaname = \'public\' AND tablename = {sql_string(table)} ORDER BY indexname')

    def count(self, table, where):
        _, rows = self.query(f"SELECT count(*) FROM {sql_ident(table)}" + (f" WHERE {where}" if where else ""))
        return int(rows[0][0]) if rows else 0

    def rows(self, table, where, offset):
        base = f"SELECT * FROM {sql_ident(table)}" + (f" WHERE {where}" if where else "")
        tail = f" LIMIT {PAGE} OFFSET {offset}"
        # by the first column when it can be; a type that cannot be sorted gets the table's own order
        try:
            return self.query(base + " ORDER BY 1" + tail)
        except ManageError:
            return self.query(base + tail)


class Redis:
    def __init__(self, runner):
        self.runner = runner

    def cli(self, args, stdin=None):
        return self.runner.run("redis", ["redis-cli", *args], stdin=stdin)

    def keys(self, pattern):
        out = self.cli(["--scan", "--pattern", pattern or "*"])
        return sorted(k for k in out.splitlines() if k)

    def describe(self, keys):
        """type and ttl of every key, one round trip: a script of commands on stdin, one reply per line."""
        if not keys:
            return []
        script = "".join(f"TYPE {shlex.quote(k)}\nTTL {shlex.quote(k)}\n" for k in keys)
        lines = self.cli([], stdin=script).splitlines()
        out = []
        for i, key in enumerate(keys):
            kind = lines[2 * i] if 2 * i < len(lines) else "?"
            ttl = lines[2 * i + 1] if 2 * i + 1 < len(lines) else "?"
            out.append((key, kind, ttl))
        return out

    def value(self, key, kind):
        """What is in the key, as lines. RESP3 json so a hash is an object and a zset is pairs."""
        cmd = {
            "string": ["GET", key],
            "hash": ["HGETALL", key],
            "list": ["LRANGE", key, "0", "-1"],
            "set": ["SMEMBERS", key],
            "zset": ["ZRANGE", key, "0", "-1", "WITHSCORES"],
            "stream": ["XREVRANGE", key, "+", "-", "COUNT", "500"],
        }.get(kind)
        if cmd is None:
            return [f"a {kind}: nothing here knows how to show it. redis-cli TYPE {key}"]
        raw = self.cli(["-3", "--json", *cmd])
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return raw.splitlines()
        return format_value(kind, data)


def format_value(kind, data):
    if kind == "string":
        text = data if isinstance(data, str) else json.dumps(data)
        return text.splitlines() or [""]
    if kind == "hash" and isinstance(data, dict):
        return [f"{k}: {v}" for k, v in data.items()] or ["(empty)"]
    if kind == "zset" and isinstance(data, list):
        lines = []
        for item in data:
            if isinstance(item, list) and len(item) == 2:
                member, score = item
                lines.append(f"{score:>16}  {member}")
            else:
                lines.append(str(item))
        return lines or ["(empty)"]
    if kind == "stream" and isinstance(data, list):
        lines = []
        for entry in data:
            if isinstance(entry, list) and len(entry) == 2 and isinstance(entry[1], list):
                sid, flat = entry
                fields = " ".join(f"{flat[i]}={flat[i + 1]}" for i in range(0, len(flat) - 1, 2))
                lines.append(f"{sid}  {fields}")
            else:
                lines.append(json.dumps(entry))
        return lines or ["(empty)"]
    if isinstance(data, list):
        return [x if isinstance(x, str) else json.dumps(x) for x in data] or ["(empty)"]
    return json.dumps(data, indent=2).splitlines()


# ---- the screen ------------------------------------------------------------------------------


def cell(text, width):
    """One cell: one line, cut to width with an ellipsis. Newlines show as ⏎ so a row stays a row."""
    text = str(text).replace("\r", "").replace("\n", "⏎")
    if len(text) > width:
        return text[: max(width - 1, 1)] + "…"
    return text


def widths(headers, rows):
    w = [min(MAX_COL, max(1, len(h))) for h in headers]
    for row in rows:
        for i, v in enumerate(row[: len(w)]):
            w[i] = min(MAX_COL, max(w[i], len(str(v).replace("\n", "⏎"))))
    return w


class Screen:
    """A list of rows with a cursor. Subclasses say what the rows are and what enter does."""

    title = ""
    help = "↑↓ move  pgup pgdn page  ←→ columns  enter open  / filter  r again  q back  ? keys"

    def __init__(self, app):
        self.app = app
        self.headers = []
        self.rows = []
        self.cursor = 0
        self.top = 0
        self.left = 0          # first column shown
        self.filter = ""
        self.error = ""
        self.note = ""

    # what to show
    def load(self):
        raise NotImplementedError

    def shown(self):
        if not self.filter:
            return self.rows
        f = self.filter.lower()
        return [r for r in self.rows if any(f in str(v).lower() for v in r)]

    def open(self, row):
        pass

    def key(self, k):
        """A key this screen handles itself. True when it did."""
        return False

    # drawing
    def draw(self, win):
        win.erase()
        h, w = win.getmaxyx()
        rows = self.shown()
        self.cursor = max(0, min(self.cursor, len(rows) - 1))
        body = h - 3  # title, header, status
        if self.cursor < self.top:
            self.top = self.cursor
        if self.cursor >= self.top + body:
            self.top = self.cursor - body + 1
        title = self.title
        if self.filter:
            title += f"   filter: {self.filter}"
        title += f"   {len(rows)}" + (f" of {len(self.rows)}" if self.filter else "")
        self.app.line(win, 0, cell(title, w - 1), curses.A_BOLD)
        ws = widths(self.headers, rows[self.top : self.top + body])
        self.left = max(0, min(self.left, max(0, len(self.headers) - 1)))
        self.app.line(win, 1, self.join(self.headers, ws, w), curses.A_REVERSE)
        for i, row in enumerate(rows[self.top : self.top + body]):
            attr = curses.A_REVERSE if self.top + i == self.cursor else curses.A_NORMAL
            self.app.line(win, 2 + i, self.join(row, ws, w), attr)
        status = self.error or self.note or self.help
        attr = curses.color_pair(1) if self.error and curses.has_colors() else curses.A_DIM
        self.app.line(win, h - 1, cell(status, w - 1), attr)

    def join(self, row, ws, w):
        parts = []
        for i in range(self.left, len(ws)):
            v = row[i] if i < len(row) else ""
            parts.append(cell(v, ws[i]).ljust(ws[i]))
        return cell("  ".join(parts), w - 1)

    # moving
    def move(self, k, h):
        rows = self.shown()
        n = len(rows)
        page = max(1, h - 3)
        if k in (curses.KEY_DOWN, ord("j")):
            self.cursor = min(n - 1, self.cursor + 1)
        elif k in (curses.KEY_UP, ord("k")):
            self.cursor = max(0, self.cursor - 1)
        elif k in (curses.KEY_NPAGE, 4):          # ctrl-d
            self.cursor = min(n - 1, self.cursor + page)
        elif k in (curses.KEY_PPAGE, 21):         # ctrl-u
            self.cursor = max(0, self.cursor - page)
        elif k in (curses.KEY_HOME, ord("g")):
            self.cursor = 0
        elif k in (curses.KEY_END, ord("G")):
            self.cursor = max(0, n - 1)
        elif k in (curses.KEY_RIGHT, ord("l")):
            self.left += 1
        elif k in (curses.KEY_LEFT, ord("h")):
            self.left = max(0, self.left - 1)
        else:
            return False
        return True


class App:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.stack = []

    def line(self, win, y, text, attr=curses.A_NORMAL):
        h, w = win.getmaxyx()
        if y >= h:
            return
        try:
            win.addnstr(y, 0, text.ljust(w - 1), w - 1, attr)
        except curses.error:
            pass

    def prompt(self, label, initial=""):
        """One line of typing at the bottom. Enter keeps it, esc (or ctrl-c) leaves it as it was."""
        h, w = self.stdscr.getmaxyx()
        text = initial
        while True:
            self.line(self.stdscr, h - 1, cell(f"{label}{text}", w - 1), curses.A_BOLD)
            self.stdscr.move(h - 1, min(len(label) + len(text), w - 2))
            self.stdscr.refresh()
            k = self.stdscr.get_wch()
            if k in ("\n", "\r"):
                return text
            if k in ("\x1b", "\x03"):
                return None
            if k in (curses.KEY_BACKSPACE, "\x7f", "\b"):
                text = text[:-1]
            elif k == "\x15":  # ctrl-u: clear
                text = ""
            elif isinstance(k, str) and k.isprintable():
                text += k

    def push(self, screen):
        self.stack.append(screen)
        self.reload(screen)

    def reload(self, screen):
        screen.error = ""
        try:
            screen.load()
        except ManageError as e:
            screen.error = f"error: {e}"

    def run(self):
        curses.curs_set(0)
        if curses.has_colors():
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_RED, -1)
        while self.stack:
            screen = self.stack[-1]
            screen.draw(self.stdscr)
            self.stdscr.refresh()
            k = self.stdscr.getch()
            h, _ = self.stdscr.getmaxyx()
            if k == curses.KEY_RESIZE:
                continue
            if k in (ord("q"), 27):
                self.stack.pop()
                continue
            if k == ord("?"):
                screen.note = screen.help
                continue
            if screen.key(k):
                continue
            if screen.move(k, h):
                screen.note = ""
                continue
            if k == ord("/"):
                text = self.prompt("filter: ", screen.filter)
                if text is not None:
                    screen.filter = text
                    screen.cursor = 0
                continue
            if k == ord("r"):
                self.reload(screen)
                screen.note = "asked again"
                continue
            if k in (curses.KEY_ENTER, 10, 13):
                rows = screen.shown()
                if rows:
                    screen.open(rows[screen.cursor])


# ---- postgres screens ------------------------------------------------------------------------


class Tables(Screen):
    help = "enter: the table  d: another database  s: a query  / filter  r again  q quit  ? keys"

    def __init__(self, app, pg):
        super().__init__(app)
        self.pg = pg

    def load(self):
        self.title = f"postgres · {self.pg.db} · tables"
        self.headers, self.rows = self.pg.tables()

    def open(self, row):
        self.app.push(Table(self.app, self.pg, row[0]))

    def key(self, k):
        if k == ord("d"):
            try:
                names = self.pg.databases()
            except ManageError as e:
                self.error = f"error: {e}"
                return True
            i = names.index(self.pg.db) if self.pg.db in names else -1
            self.pg.db = names[(i + 1) % len(names)]
            self.cursor = 0
            self.app.reload(self)
            return True
        if k == ord("s"):
            sql = self.app.prompt("sql> ")
            if sql:
                self.app.push(Query(self.app, self.pg, sql))
            return True
        return False


class Table(Screen):
    help = "c: columns and indexes  n p: next, previous page  w: a where clause  s: a query  ←→ columns  q back"

    def __init__(self, app, pg, table):
        super().__init__(app)
        self.pg = pg
        self.table = table
        self.mode = "rows"
        self.where = ""
        self.offset = 0
        self.total = 0

    def load(self):
        if self.mode == "columns":
            self.title = f"{self.pg.db} · {self.table} · columns, then indexes"
            headers, cols = self.pg.columns(self.table)
            _, idx = self.pg.indexes(self.table)
            self.headers = headers
            self.rows = cols + ([["", "", "", ""]] if idx else []) + [[name, "index", "", definition] for name, definition in idx]
            return
        self.total = self.pg.count(self.table, self.where)
        self.headers, self.rows = self.pg.rows(self.table, self.where, self.offset)
        first = self.offset + 1 if self.rows else 0
        last = self.offset + len(self.rows)
        self.title = f"{self.pg.db} · {self.table} · rows {first}-{last} of {self.total}"
        if self.where:
            self.title += f"   where {self.where}"

    def key(self, k):
        if k == ord("c"):
            self.mode = "columns" if self.mode == "rows" else "rows"
            self.cursor = 0
            self.left = 0
            self.app.reload(self)
            return True
        if k == ord("n") and self.mode == "rows":
            if self.offset + PAGE < self.total:
                self.offset += PAGE
                self.cursor = 0
                self.app.reload(self)
            else:
                self.note = "the last page"
            return True
        if k == ord("p") and self.mode == "rows":
            if self.offset > 0:
                self.offset = max(0, self.offset - PAGE)
                self.cursor = 0
                self.app.reload(self)
            else:
                self.note = "the first page"
            return True
        if k == ord("w") and self.mode == "rows":
            text = self.app.prompt("where ", self.where)
            if text is not None:
                self.where = text.strip()
                self.offset = 0
                self.cursor = 0
                self.app.reload(self)
            return True
        if k == ord("s"):
            sql = self.app.prompt("sql> ", f"SELECT * FROM {sql_ident(self.table)} ")
            if sql:
                self.app.push(Query(self.app, self.pg, sql))
            return True
        return False


class Query(Screen):
    help = "a query, read-only (it runs in a transaction that is rolled back)  ←→ columns  r again  q back"

    def __init__(self, app, pg, sql):
        super().__init__(app)
        self.pg = pg
        self.sql = sql

    def load(self):
        self.headers, self.rows = self.pg.query(self.sql)
        self.title = f"{self.pg.db} · {cell(self.sql, 80)} · {len(self.rows)} row(s)"
        if not self.headers:
            self.headers = ["(no rows)"]


# ---- redis screens ---------------------------------------------------------------------------


class Keys(Screen):
    help = "enter: what is in the key  / pattern (scan)  r again  q quit  ? keys"

    def __init__(self, app, redis):
        super().__init__(app)
        self.redis = redis
        self.pattern = "*"

    def load(self):
        keys = self.redis.keys(self.pattern)
        self.headers = ["key", "type", "ttl"]
        self.rows = [[k, kind, "∞" if ttl == "-1" else ttl] for k, kind, ttl in self.redis.describe(keys)]
        self.title = f"redis · keys matching {self.pattern}"

    def open(self, row):
        self.app.push(Key(self.app, self.redis, row[0], row[1]))

    def key(self, k):
        if k == ord("/"):
            text = self.app.prompt("pattern: ", self.pattern)
            if text is not None:
                self.pattern = text.strip() or "*"
                self.cursor = 0
                self.app.reload(self)
            return True
        return False


class Key(Screen):
    help = "↑↓ scroll  r again  q back"

    def __init__(self, app, redis, key, kind):
        super().__init__(app)
        self.redis = redis
        self.k = key
        self.kind = kind

    def load(self):
        _, _, ttl = self.redis.describe([self.k])[0]
        self.title = f"redis · {self.k} · {self.kind} · ttl {'∞' if ttl == '-1' else ttl}"
        self.headers = [self.kind]
        self.rows = [[line] for line in self.redis.value(self.k, self.kind)]


# ---- main ------------------------------------------------------------------------------------


def main(stdscr):
    runner = Runner(TO, DIR)
    app = App(stdscr)
    if MODE == "redis":
        app.push(Keys(app, Redis(runner)))
    else:
        app.push(Tables(app, Postgres(runner, DB)))
    app.run()


if __name__ == "__main__":
    try:
        curses.wrapper(main)
    except KeyboardInterrupt:
        pass
