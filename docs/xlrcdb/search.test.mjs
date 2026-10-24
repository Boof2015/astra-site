import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchIndex, highlightRanges, search, searchKey } from "./search.js";

// A slice of the real database (aliases as aliases.json stores them).
const index = buildSearchIndex({
  artists: [
    { id: "a1", name: "K/DA", aliases: ["k/da"], trackCount: 2 },
    { id: "a2", name: "かめりあ", aliases: ["camellia", "かめりあ"], trackCount: 1 },
    { id: "a3", name: "Jane Remover", aliases: ["jane remover", "973badvibezgirl", "venturing", "leroy"], trackCount: 1 },
    { id: "a4", name: "for Revenge", aliases: ["for revenge"], trackCount: 1 },
    { id: "a5", name: "Kai Angel", aliases: ["kai angel"], trackCount: 1 },
    { id: "a6", name: "星街すいせい", aliases: ["hoshimachi suisei", "星街すいせい"], trackCount: 1 }
  ],
  tracks: [
    { artistId: "a1", artistName: "K/DA", id: "t1", title: "FIRESTARTER", length: 187 },
    { artistId: "a1", artistName: "K/DA", id: "t2", title: "The Baddest", length: 162 },
    { artistId: "a2", artistName: "かめりあ", id: "t3", title: "流星群", length: 273 },
    { artistId: "a4", artistName: "for Revenge", id: "t4", title: "Sadrah", length: 200 },
    { artistId: "a6", artistName: "星街すいせい", id: "t5", title: "ビビデバ", length: 180 }
  ]
});

const artistNames = (q) => search(index, q).artists.map((r) => r.artist.name);
const trackTitles = (q) => search(index, q).tracks.map((r) => r.track.title);

test("keys fold case, accents, punctuation and katakana", () => {
  assert.equal(searchKey("For - Revenge"), "for revenge");
  assert.equal(searchKey("Beyoncé"), "beyonce");
  assert.equal(searchKey("ビビデバ"), searchKey("びびでば"));
  assert.equal(searchKey("ＫＤＡ"), "kda");
});

test("'kd' suggests K/DA", () => {
  assert.equal(artistNames("kd")[0], "K/DA");
  assert.equal(artistNames("KDA")[0], "K/DA");
});

test("aliases, initials and punctuation-insensitive matches", () => {
  assert.equal(artistNames("camellia")[0], "かめりあ");
  assert.equal(artistNames("jr")[0], "Jane Remover");
  assert.equal(artistNames("forrev")[0], "for Revenge");
  assert.equal(artistNames("For - Revenge")[0], "for Revenge");
  assert.equal(artistNames("venturing")[0], "Jane Remover");
  assert.equal(search(index, "venturing").artists[0].alias, "venturing");
});

test("small typos still match", () => {
  assert.equal(artistNames("camelia")[0], "かめりあ");
  assert.equal(artistNames("hoshimati")[0], "星街すいせい");
  assert.deepEqual(artistNames("zzzz"), []);
});

test("track titles, and queries that span artist and title", () => {
  assert.equal(trackTitles("fire")[0], "FIRESTARTER");
  assert.equal(trackTitles("kda firestarter")[0], "FIRESTARTER");
  assert.equal(trackTitles("firestarter kda")[0], "FIRESTARTER");
  assert.equal(trackTitles("びびでば")[0], "ビビデバ");
});

test("an artist query lists that artist's tracks after title matches", () => {
  const { tracks } = search(index, "kda");
  assert.deepEqual(tracks.map((r) => r.track.title).sort(), ["FIRESTARTER", "The Baddest"]);
  assert.ok(tracks.every((r) => r.viaArtist));
});

test("highlights skip punctuation", () => {
  assert.deepEqual(highlightRanges("K/DA", "kd"), [[0, 3]]);
  assert.deepEqual(highlightRanges("FIRESTARTER", "fire"), [[0, 4]]);
  assert.deepEqual(highlightRanges("Jane Remover", "rem"), [[5, 8]]);
  assert.deepEqual(highlightRanges("for Revenge", "xyz"), []);
});
