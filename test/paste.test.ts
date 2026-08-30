/*
  Terminal input decoding. Pasting is the case that actually broke: a paste
  arrives as one bulk chunk, not as individual keypresses, and an input loop
  that only accepts single characters silently drops it.
*/

import { describe, expect, test } from "bun:test";
import { decode, sanitizePaste } from "../src/ui.ts";

describe("paste arrives as a bulk chunk", () => {
  test("a right-click paste of an access key is accepted whole", () => {
    const k = decode("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(k.name).toBe("paste");
    expect(k.text).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
  });

  test("bracketed paste markers are stripped, not treated as arrow keys", () => {
    const k = decode("\x1b[200~my-secret-token\x1b[201~");
    expect(k.name).toBe("paste");
    expect(k.text).toBe("my-secret-token");
  });

  test("a lone closing marker is ignored rather than typed", () => {
    expect(decode("\x1b[201~").name).toBe("noop");
  });

  test("a multi-line paste keeps only the first line", () => {
    expect(sanitizePaste("first-line\r\nsecond-line")).toBe("first-line");
  });

  test("control characters never reach the input value", () => {
    expect(sanitizePaste("tok\x07en\x1b")).toBe("token");
  });

  test("Ctrl+V is reported so the clipboard can be read directly", () => {
    expect(decode("\x16").name).toBe("ctrl-v");
  });
});

describe("ordinary keys still work", () => {
  test("arrow keys are not mistaken for pasted text", () => {
    expect(decode("\x1b[A").name).toBe("up");
    expect(decode("\x1b[B").name).toBe("down");
  });

  test("single printable characters pass through", () => {
    expect(decode("k").name).toBe("k");
    expect(decode(" ").name).toBe("space");
  });

  test("Cyrillic input is a single character, not a paste", () => {
    expect(decode("ж").name).toBe("ж");
  });

  test("enter, escape and backspace keep their meaning", () => {
    expect(decode("\r").name).toBe("enter");
    expect(decode("\x1b").name).toBe("escape");
    expect(decode("\x7f").name).toBe("backspace");
    expect(decode("\x03").name).toBe("ctrl-c");
  });
});
