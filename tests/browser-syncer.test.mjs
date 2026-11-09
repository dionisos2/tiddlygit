// Tests of the browser side of the tiddlygit plugin: the TiddlyWiki syncer of
// the browser must never replace what is being typed by the version of the
// server.
//
// The browser syncer saves a tiddler at most once per second. When the server
// version of a tiddler changes (file changed on disk, git synchronization,
// another tab...), the syncer loads it, even if the browser has changes not
// sent yet: what was typed during the last second disappears.
//
// The syncer runs in node here, with a fake server playing the TiddlyWeb
// adaptor.
//
// Run with: node --test tests/

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, message, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(message);
}

let $tw;
let emptyWiki;
let keepLocalChanges;

before(async () => {
  $tw = require(path.join(repoRoot, "node_modules/tiddlywiki/boot/boot.js")).TiddlyWiki();
  emptyWiki = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-syncer-"));
  $tw.boot.argv = [emptyWiki];
  await new Promise((resolve) => $tw.boot.boot(resolve));
  globalThis.$tw = $tw;
  ({ keepLocalChanges } = require(path.join(repoRoot, "tiddlygit-plugin/keep-local-changes.js")));
});

after(() => {
  fs.rmSync(emptyWiki, { recursive: true, force: true });
});

// The server, as seen through the TiddlyWeb adaptor
class FakeServer {
  constructor() {
    this.tiddlers = new Map();
    this.revision = 0;
    this.loads = 0;
  }

  // A change made on the server (file changed on disk, git, another tab...)
  set(fields) {
    this.tiddlers.set(fields.title, { fields: { ...fields }, revision: String(++this.revision) });
  }

  text(title) {
    return this.tiddlers.get(title)?.fields.text;
  }

  adaptor() {
    const reply = (callback, ...args) => setTimeout(() => callback(...args), 5);
    return {
      name: "fake",
      isReady: () => true,
      getTiddlerInfo: () => ({}),
      getSkinnyTiddlers: (callback) => {
        reply(callback, null, [...this.tiddlers.values()].map(({ fields, revision }) => ({ title: fields.title, revision })));
      },
      loadTiddler: (title, callback) => {
        this.loads++;
        const { fields, revision } = this.tiddlers.get(title);
        reply(callback, null, { ...fields, revision });
      },
      saveTiddler: (tiddler, callback) => {
        const fields = { ...tiddler.fields };
        delete fields.revision;
        this.set(fields);
        reply(callback, null, {}, String(this.revision));
      },
      deleteTiddler: (title, callback) => {
        this.tiddlers.delete(title);
        reply(callback, null);
      },
    };
  }
}

function startSyncer(server) {
  const wiki = new $tw.Wiki();
  wiki.addTiddler({ title: "$:/config/SyncFilter", text: "[is[tiddler]] -[prefix[$:/config/]]" });
  const syncer = new $tw.Syncer({ wiki, syncadaptor: server.adaptor(), logging: false, disableUI: true, pollTimerInterval: 600000 });
  keepLocalChanges(syncer);
  return { wiki, syncer };
}

function stopSyncer(syncer) {
  syncer.processTaskQueue = () => {};
  clearTimeout(syncer.taskTimerId);
}

const type = (wiki, text) => wiki.addTiddler(new $tw.Tiddler(wiki.getTiddler("Form"), { text }));

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
