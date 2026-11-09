// Tests of the browser side of the tiddlygit plugin: the TiddlyWiki syncer of
// the browser must never replace what is being typed by the version of the
// server.
//
// The browser syncer saves a tiddler at most once per second. When the server
// version of a tiddler changes (file changed on disk, git synchronization,
// another tab...), the syncer loads it, even if the browser has changes not
// sent yet: what was typed during the last second disappears.
//
// The syncer runs in node here, with a fake server (see browser-helpers.mjs).
//
// Run with: node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { useTiddlyWiki, FakeServer, startSyncer as start, stopSyncer, typeIn, eventually, sleep } from "./browser-helpers.mjs";

const tw = useTiddlyWiki();
const startSyncer = (server) => start(tw(), server);
const type = (wiki, text) => typeIn(tw(), wiki, text);

test("a tiddler changed on the server does not replace what is being typed", async () => {
  const server = new FakeServer();
  server.set({ title: "Form", text: "a", other: "1" });
  const { wiki, syncer } = startSyncer(server);
  try {
    await eventually(() => wiki.getTiddlerText("Form") === "a", "the tiddler was not loaded");

    type(wiki, "ab");
    await eventually(() => server.text("Form") === "ab", "the typed text was not saved");
    // Typed less than one second after the last save: not sent yet
    type(wiki, "abc");
    server.set({ title: "Form", text: "ab", other: "2" });
    syncer.syncFromServer();
    await sleep(200);

    assert.equal(wiki.getTiddlerText("Form"), "abc");
    await eventually(() => server.text("Form") === "abc", "the typed text was not saved", 3000);
    await sleep(200);
    assert.equal(wiki.getTiddlerText("Form"), "abc");
  } finally {
    stopSyncer(syncer);
  }
});

test("a tiddler kept because of local changes is not loaded again and again", async () => {
  const server = new FakeServer();
  server.set({ title: "Form", text: "a" });
  const { wiki, syncer } = startSyncer(server);
  try {
    await eventually(() => wiki.getTiddlerText("Form") === "a", "the tiddler was not loaded");
    type(wiki, "ab");
    await eventually(() => server.text("Form") === "ab", "the typed text was not saved");
    type(wiki, "abc");
    server.set({ title: "Form", text: "from the server" });
    syncer.syncFromServer();
    await sleep(100);
    const loads = server.loads;
    syncer.syncFromServer();
    await sleep(100);
    syncer.syncFromServer();
    await sleep(100);
    assert.equal(server.loads, loads);
  } finally {
    stopSyncer(syncer);
  }
});

test("a tiddler changed on the server is loaded when nothing is being typed", async () => {
  const server = new FakeServer();
  server.set({ title: "Form", text: "a" });
  const { wiki, syncer } = startSyncer(server);
  try {
    await eventually(() => wiki.getTiddlerText("Form") === "a", "the tiddler was not loaded");
    type(wiki, "ab");
    await eventually(() => server.text("Form") === "ab", "the typed text was not saved");
    await sleep(1200);

    server.set({ title: "Form", text: "from the server" });
    syncer.syncFromServer();
    await eventually(() => wiki.getTiddlerText("Form") === "from the server", "the server version was not loaded");
  } finally {
    stopSyncer(syncer);
  }
});
