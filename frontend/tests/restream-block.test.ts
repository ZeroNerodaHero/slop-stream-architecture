import assert from "node:assert/strict";
import { test } from "node:test";

import { restreamBlock } from "../src/infra/restream-block.ts";

test("the relay set up means destinations can be sent to anywhere", () => {
  assert.equal(restreamBlock(true, false, false, false), null);
  assert.equal(restreamBlock(true, true, true, false), null);
});

test("without the relay only the desktop app with direct on can send", () => {
  assert.equal(restreamBlock(false, true, true, true), null);
  assert.match(
    restreamBlock(false, true, true, false) ?? "",
    /off in this app/,
  );
  assert.match(restreamBlock(false, true, false, true) ?? "", /desktop app/);
});

test("nothing set up says only slop gets the stream", () => {
  assert.match(
    restreamBlock(false, false, true, true) ?? "",
    /only slop gets your stream/,
  );
  assert.match(
    restreamBlock(false, false, false, false) ?? "",
    /only slop gets your stream/,
  );
});
