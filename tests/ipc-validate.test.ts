import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoteText,
  assertString,
  assertOptionalString,
  assertCliToken,
  assertCliName,
  assertMcpTransport,
  assertOptionalStringArray,
  assertOptionalStringRecord,
  ENV_KEY_RE,
  HEADER_NAME_RE,
} from "../electron/main/ipc/validate";
import { NOTE_MAX_CHARS } from "../shared/types";

/**
 * These validators run on renderer-supplied values at the IPC boundary, so they
 * are load-bearing security checks rather than ergonomics. They had no tests.
 *
 * The threats they exist to stop, per the module's own comments:
 *
 *   Option injection  args reach the CLI as discrete argv, so a shell cannot be
 *                     involved, but a value starting with '-' is read by grok as
 *                     a FLAG. `--config=/somewhere` as a "plugin name" is the
 *                     attack, not `; rm -rf`.
 *   Control chars     a newline smuggled into an MCP header or env value splits
 *                     one config entry into two.
 *   Prototype keys    an object arriving over IPC is JSON, but the record
 *                     validator still has to refuse a non-plain prototype.
 *   Unbounded input   length caps on every string that reaches a config file.
 *
 * Each test states the consequence, so a future relaxation has to argue with the
 * reason rather than just the assertion.
 */

const throws = (fn: () => unknown, why: string) =>
  assert.throws(fn, Error, why);

/**
 * Build a string containing one control character, by code point.
 *
 * Written this way rather than as a source escape because these bytes are
 * invisible in an editor and a literal one can be silently eaten by a
 * reformat, leaving a test that reads as if it still covers NUL while
 * asserting on the harmless string "ab".
 */
const withControlChar = (code: number): string =>
  `a${String.fromCharCode(code)}b`;

/** Named for readability at the call sites below. */
const NUL = 0;
const UNIT_SEPARATOR = 0x1f;
const DEL = 0x7f;

test("assertString rejects everything that is not a non-empty string", () => {
  assert.equal(assertString("ok", "name"), "ok");
  // Whitespace-only is empty for this purpose: it would become a blank argv entry.
  for (const bad of [
    "",
    "   ",
    "\t\n",
    undefined,
    null,
    0,
    1,
    false,
    true,
    [],
    {},
    Symbol("x"),
  ]) {
    throws(() => assertString(bad, "name"), `accepted ${String(bad)}`);
  }
  // Preserved verbatim, not trimmed: callers rely on the exact value.
  assert.equal(assertString("  padded  ", "name"), "  padded  ");
});

test("assertOptionalString treats empty and nullish as absent, not as an error", () => {
  for (const absent of [undefined, null, ""]) {
    assert.equal(assertOptionalString(absent, "name"), undefined);
  }
  assert.equal(assertOptionalString("value", "name"), "value");
  for (const bad of [0, 1, false, true, [], {}]) {
    throws(() => assertOptionalString(bad, "name"), `accepted ${String(bad)}`);
  }
});

test("assertCliToken refuses anything grok would read as a flag", () => {
  assert.equal(assertCliToken("plugin-name", "name"), "plugin-name");
  // The whole point of the validator. Each of these would be consumed by grok
  // as its own option rather than as the value the user typed.
  for (const flag of [
    "-s",
    "--config",
    "--config=/etc/passwd",
    "-",
    "--",
    "-rf",
  ]) {
    throws(() => assertCliToken(flag, "name"), `accepted flag-like ${flag}`);
  }
  // A dash anywhere but the front is ordinary.
  assert.equal(assertCliToken("my-plugin", "name"), "my-plugin");
});

test("assertCliToken refuses control characters", () => {
  // A newline here becomes a second line in a config file or a second header.
  const bad = [
    withControlChar(0x0a), // newline
    withControlChar(0x0d), // carriage return
    withControlChar(0x09), // tab
    withControlChar(NUL),
    withControlChar(UNIT_SEPARATOR),
    withControlChar(DEL),
  ];
  for (const value of bad) {
    throws(
      () => assertCliToken(value, "name"),
      `accepted control char in ${JSON.stringify(value)}`,
    );
  }
  // The guard only means something if the same string WITHOUT the control
  // character is accepted, so a pass above cannot be down to 'ab' being invalid.
  assert.equal(assertCliToken("ab", "name"), "ab");
});

test("assertCliToken caps length at 1024", () => {
  assert.equal(assertCliToken("a".repeat(1024), "name").length, 1024);
  throws(
    () => assertCliToken("a".repeat(1025), "name"),
    "accepted an over-long token",
  );
});

test("assertCliName narrows to a safe character set on top of the token rules", () => {
  for (const ok of [
    "name",
    "a.b",
    "a_b",
    "a@b",
    "a/b",
    "a-b",
    "A9",
    "xai-org/skills",
  ]) {
    assert.equal(assertCliName(ok, "name"), ok);
  }
  // Spaces, quotes, path traversal and shell metacharacters all fail the set.
  for (const bad of [
    "a b",
    "a;b",
    "a&b",
    "a|b",
    "a$b",
    "a`b",
    "a'b",
    'a"b',
    "..\\x",
    "a\\b",
    "a*b",
  ]) {
    throws(() => assertCliName(bad, "name"), `accepted ${bad}`);
  }
  // '..' passes the character set, so traversal is not stopped HERE. It is the
  // filesystem jail's job, and this test records that division rather than
  // implying a protection this function does not provide.
  assert.equal(assertCliName("..", "name"), "..");
  assert.equal(assertCliName("../x", "name"), "../x");
});

test("assertCliName caps length at 200, tighter than a raw token", () => {
  assert.equal(assertCliName("a".repeat(200), "name").length, 200);
  throws(
    () => assertCliName("a".repeat(201), "name"),
    "accepted an over-long name",
  );
});

test("assertMcpTransport accepts only the three known transports", () => {
  for (const ok of ["stdio", "http", "sse"])
    assert.equal(assertMcpTransport(ok), ok);
  for (const bad of [
    "STDIO",
    "ws",
    "file",
    "",
    undefined,
    null,
    0,
    {},
    ["stdio"],
  ]) {
    throws(() => assertMcpTransport(bad), `accepted ${String(bad)}`);
  }
});

test("assertOptionalStringArray allows leading dashes, because those are the server flags", () => {
  // Deliberately unlike assertCliToken: plugins.ts places these after `--`, so
  // grok cannot claim them. If that separator ever goes away, this becomes an
  // option-injection hole and this comment is the trail back to why.
  assert.deepEqual(assertOptionalStringArray(["--port", "8080"], "args"), [
    "--port",
    "8080",
  ]);
  assert.equal(assertOptionalStringArray(undefined, "args"), undefined);
  assert.equal(assertOptionalStringArray(null, "args"), undefined);
  // An empty array is absent, not an empty argv.
  assert.equal(assertOptionalStringArray([], "args"), undefined);
});

test("assertOptionalStringArray enforces its limits", () => {
  throws(() => assertOptionalStringArray("nope", "args"), "accepted a string");
  throws(
    () => assertOptionalStringArray({ 0: "a" }, "args"),
    "accepted an array-like",
  );
  throws(
    () => assertOptionalStringArray(new Array(65).fill("a"), "args"),
    "accepted 65 entries",
  );
  assert.equal(
    assertOptionalStringArray(new Array(64).fill("a"), "args")?.length,
    64,
  );
  throws(
    () => assertOptionalStringArray(["ok", ""], "args"),
    "accepted an empty entry",
  );
  throws(
    () => assertOptionalStringArray(["ok", "a\nb"], "args"),
    "accepted a newline",
  );
  throws(
    () => assertOptionalStringArray(["a".repeat(2049)], "args"),
    "accepted an over-long entry",
  );
  throws(() => assertOptionalStringArray([1], "args"), "accepted a number");
});

test("assertOptionalStringRecord refuses a non-plain prototype", () => {
  const plain = assertOptionalStringRecord({ FOO: "bar" }, "env", ENV_KEY_RE);
  assert.deepEqual(plain, { FOO: "bar" });

  // Object.create(null) is plain enough: it carries no inherited surprises.
  const bare = Object.create(null) as Record<string, string>;
  bare.FOO = "bar";
  assert.deepEqual(assertOptionalStringRecord(bare, "env", ENV_KEY_RE), {
    FOO: "bar",
  });

  class Sneaky {
    FOO = "bar";
  }
  throws(
    () => assertOptionalStringRecord(new Sneaky(), "env", ENV_KEY_RE),
    "accepted a class instance",
  );
  throws(
    () => assertOptionalStringRecord([], "env", ENV_KEY_RE),
    "accepted an array",
  );
  throws(
    () => assertOptionalStringRecord("x", "env", ENV_KEY_RE),
    "accepted a string",
  );
});

test("assertOptionalStringRecord enforces the key pattern it is given", () => {
  assert.deepEqual(
    assertOptionalStringRecord({ PATH_1: "x" }, "env", ENV_KEY_RE),
    { PATH_1: "x" },
  );
  // Env keys cannot start with a digit or contain a dash.
  for (const bad of [
    { "1FOO": "x" },
    { "A-B": "x" },
    { "A B": "x" },
    { "": "x" },
  ]) {
    throws(
      () => assertOptionalStringRecord(bad, "env", ENV_KEY_RE),
      `accepted key ${Object.keys(bad)[0]}`,
    );
  }
  // Header names allow a different, wider set.
  assert.deepEqual(
    assertOptionalStringRecord({ "X-Api-Key": "v" }, "headers", HEADER_NAME_RE),
    {
      "X-Api-Key": "v",
    },
  );
  throws(
    () =>
      assertOptionalStringRecord(
        { "X Api Key": "v" },
        "headers",
        HEADER_NAME_RE,
      ),
    "accepted a space in a header name",
  );
});

test("assertOptionalStringRecord refuses control characters in values", () => {
  // The reason this matters: a newline in a header value splits it into two
  // headers, and in an env value it forges a second variable.
  throws(
    () =>
      assertOptionalStringRecord(
        { A: "v\nX-Evil: 1" },
        "headers",
        HEADER_NAME_RE,
      ),
    "accepted a newline in a value",
  );
  throws(
    () =>
      assertOptionalStringRecord(
        { A: `v${String.fromCharCode(NUL)}` },
        "env",
        ENV_KEY_RE,
      ),
    "accepted a NUL",
  );
});

test("assertOptionalStringRecord never echoes a secret value in its error", () => {
  const secret = "sk-live-000-DO-NOT-LEAK";
  try {
    assertOptionalStringRecord({ TOKEN: `${secret}\n` }, "env", ENV_KEY_RE);
    assert.fail("should have thrown");
  } catch (err) {
    const message = (err as Error).message;
    // These values are API keys. The key name is fine to report; the value is not.
    assert.ok(!message.includes(secret), `error leaked the value: ${message}`);
    assert.ok(
      message.includes("TOKEN"),
      "error should still identify which key failed",
    );
  }
});

test("assertOptionalStringRecord enforces size limits", () => {
  const tooMany: Record<string, string> = {};
  for (let i = 0; i < 51; i++) tooMany[`K${i}`] = "v";
  throws(
    () => assertOptionalStringRecord(tooMany, "env", ENV_KEY_RE),
    "accepted 51 entries",
  );

  throws(
    () =>
      assertOptionalStringRecord({ A: "v".repeat(4097) }, "env", ENV_KEY_RE),
    "accepted an over-long value",
  );
  assert.deepEqual(
    assertOptionalStringRecord({ A: "v".repeat(4096) }, "env", ENV_KEY_RE),
    {
      A: "v".repeat(4096),
    },
  );
  // Absent rather than an empty object.
  assert.equal(assertOptionalStringRecord({}, "env", ENV_KEY_RE), undefined);
  assert.equal(
    assertOptionalStringRecord(undefined, "env", ENV_KEY_RE),
    undefined,
  );
});

test("assertNoteText accepts an empty note, because empty means forget it", () => {
  // Every other validator here rejects empty. This one must not: clearing a
  // project's scratchpad is how the entry is deleted from the store.
  assert.equal(assertNoteText("", "note"), "");
  assert.equal(assertNoteText("   ", "note"), "   ");
});

test("assertNoteText leaves the user's own prose exactly as written", () => {
  // Newlines and tabs are the point of a scratchpad, and the CLI validators'
  // control-character rule would reject every multi-line note. Nothing here
  // rewrites the value: this is the user's own text, not an argv element or a
  // path, and it reaches a <textarea> value and a JSON string and nothing else.
  const note = ["line one", "", "\tindented", "- bullet"].join("\n");
  assert.equal(assertNoteText(note, "note"), note);
});

test("assertNoteText refuses a non-string rather than coercing one", () => {
  for (const bad of [undefined, null, 42, {}, [], { toString: () => "x" }]) {
    throws(() => assertNoteText(bad, "note"), `accepted ${JSON.stringify(bad)}`);
  }
});

test("assertNoteText caps length, and refuses rather than truncating", () => {
  const atLimit = "x".repeat(NOTE_MAX_CHARS);
  assert.equal(assertNoteText(atLimit, "note"), atLimit);
  // Truncating would silently eat the tail of what somebody wrote, which is the
  // corruption FIX-R1 exists to prevent. The store never sees an over-long note.
  throws(() => assertNoteText(atLimit + "x", "note"), "accepted an over-long note");
});
