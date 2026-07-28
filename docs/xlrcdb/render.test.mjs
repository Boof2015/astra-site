import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHighlight,
  formatPlaybackTime,
  mapScrollOffset
} from "./render.js";

test("formats playback timestamps with truncated centiseconds", () => {
  assert.equal(formatPlaybackTime(0), "00:00.00");
  assert.equal(formatPlaybackTime(1.239), "00:01.23");
  assert.equal(formatPlaybackTime(59.999), "00:59.99");
  assert.equal(formatPlaybackTime(60), "01:00.00");
  assert.equal(formatPlaybackTime(65.678), "01:05.67");
  assert.equal(formatPlaybackTime(3600.009), "60:00.00");
});

test("normalizes invalid playback timestamps to zero", () => {
  assert.equal(formatPlaybackTime(-1), "00:00.00");
  assert.equal(formatPlaybackTime(Number.NaN), "00:00.00");
  assert.equal(formatPlaybackTime(Number.POSITIVE_INFINITY), "00:00.00");
  assert.equal(formatPlaybackTime("bad"), "00:00.00");
});

test("maps scroll offsets proportionally between unequal scroll ranges", () => {
  assert.equal(mapScrollOffset(0, 1000, 200, 1200, 200), 0);
  assert.equal(mapScrollOffset(400, 1000, 200, 1200, 200), 500);
  assert.equal(mapScrollOffset(800, 1000, 200, 1200, 200), 1000);
  assert.equal(mapScrollOffset(900, 1000, 200, 1200, 200), 1000);
  assert.equal(mapScrollOffset(50, 200, 200, 1200, 200), 0);
});

test("builds exactly one highlight element for every source row", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const highlight = fakeElement("pre");
  buildHighlight(
    highlight,
    "plain\r\n[00:01.23]timed\r\n",
    new Set([2])
  );

  assert.equal(highlight.children.length, 3);
  assert.equal(highlight.childNodes.length, 3);
  assert.deepEqual(
    highlight.children.map((row) => row.className),
    ["hl-line", "hl-line err", "hl-line"]
  );
  assert.deepEqual(
    highlight.children.map((row) => row.textContent),
    ["plain", "[00:01.23]timed", ""]
  );

  const longSource = Array.from(
    { length: 501 },
    (_, index) => `line ${index + 1}`
  ).join("\n");
  buildHighlight(highlight, longSource, new Set());

  assert.equal(highlight.childNodes.length, 501);
  assert.equal(highlight.children[207].textContent, "line 208");
  assert.equal(highlight.children[500].textContent, "line 501");
});

function fakeDocument() {
  return {
    createDocumentFragment: () => fakeNode(11),
    createElement: (tagName) => fakeElement(tagName),
    createTextNode: (value) => fakeText(value)
  };
}

function fakeElement(tagName) {
  const node = fakeNode(1);
  node.tagName = tagName.toUpperCase();
  node.className = "";
  return node;
}

function fakeText(value) {
  const node = fakeNode(3);
  node.data = String(value);
  return node;
}

function fakeNode(nodeType) {
  const node = {
    nodeType,
    childNodes: [],
    appendChild(child) {
      if (child.nodeType === 11) this.childNodes.push(...child.childNodes);
      else this.childNodes.push(child);
      return child;
    }
  };
  Object.defineProperties(node, {
    children: {
      get() {
        return this.childNodes.filter((child) => child.nodeType === 1);
      }
    },
    textContent: {
      get() {
        if (this.nodeType === 3) return this.data;
        return this.childNodes.map((child) => child.textContent).join("");
      },
      set(value) {
        if (this.nodeType === 3) {
          this.data = String(value);
          return;
        }
        this.childNodes = value === "" ? [] : [fakeText(value)];
      }
    }
  });
  return node;
}
