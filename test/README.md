# test

browser tests, playwright. do not run the js files by hand unless you know the env.

```
# from the repo root
./scripts/test.sh
./scripts/test.sh https://1.2.3.4
./scripts/test.sh --all
HEADED=1 ./scripts/test.sh
```

needs node and google chrome. a fake camera is used. stream names are fixed, so one person at a time per server.

the default suite is listed in `scripts/test.sh`: e2e, dup, chat, auth, groups, follows, dms, notifications, preview, errors, pip, live-pip, screen, vtuber, presence, calendar, about, socials, prefetch. a local docker stack also runs regress and monitor. `--all` adds redeploy and dummy.

`fixtures/` holds puppet models used by the vtuber tests.
