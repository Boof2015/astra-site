import test from "node:test";
import assert from "node:assert/strict";
import { parseXLRC } from "../xlrc/assets/xlrc.js";
import {
  patchHeader,
  readHeaders,
  validateLanguageMetadata
} from "./editor-validation.js";

test("missing language headers are required", () => {
  const source = "[ti:Example]\n[ar:Artist]\n[length:00:10]\n\n[00:00.00]Lyrics\n";

  assert.deepEqual(validate(source), [
    { message: "Missing non-empty [lang:] header", line: 0 },
    { message: "Missing non-empty [langs:] header", line: 0 }
  ]);
});

test("empty language headers point to their source lines", () => {
  const source = trackSource({ lang: "", langs: "" });

  assert.deepEqual(validate(source), [
    { message: "Missing non-empty [lang:] header", line: 4 },
    { message: "Missing non-empty [langs:] header", line: 5 }
  ]);
});

test("langs covers the primary and every inline translation language", () => {
  const source = trackSource({
    lang: "ja",
    langs: "fr",
    body: "[00:00.00]例\n[>en]Example"
  });

  assert.deepEqual(validate(source), [{
    message: "[langs:] must include [lang:] and every inline translation language; missing: ja, en",
    line: 5
  }]);
});

test("language coverage is case-insensitive and permits extra declarations", () => {
  const source = trackSource({
    lang: "JA",
    langs: "fr,ja,EN",
    body: "[00:00.00]例\n[>en]Example"
  });

  assert.deepEqual(validate(source), []);
});

test("managed language headers can be read, inserted, and replaced without changing lyrics", () => {
  const original = "[ti:Example]\n[ar:Artist]\n[length:00:10]\n\n[00:00.00]Lyrics\n";
  const withLang = patchHeader(original, "lang", "ja");
  const withLangs = patchHeader(withLang, "langs", "ja,en");
  const updated = patchHeader(withLangs, "lang", "JA");

  assert.deepEqual(readHeaders(updated), {
    ar: "Artist",
    ti: "Example",
    length: "00:10",
    lang: "JA",
    langs: "ja,en"
  });
  assert.match(updated, /\n\n\[00:00\.00\]Lyrics\n$/u);
});

function validate(source) {
  return validateLanguageMetadata(parseXLRC(source), source);
}

function trackSource({ lang = "en", langs = "en", body = "[00:00.00]Lyrics" } = {}) {
  return [
    "[ti:Example]",
    "[ar:Artist]",
    "[length:00:10]",
    `[lang:${lang}]`,
    `[langs:${langs}]`,
    "",
    body,
    ""
  ].join("\n");
}
