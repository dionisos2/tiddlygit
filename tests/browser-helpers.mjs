// Helpers to run the browser syncer of TiddlyWiki in node, against a fake
// server playing the TiddlyWeb adaptor.

import { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function eventually(check, message, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(message);
}

// Boots TiddlyWiki (as global $tw) for the tests of the calling file, and
// returns a function giving it.
export function useTiddlyWiki() {
  let $tw;
  let emptyWiki;
  before(async () => {
    $tw = require(path.join(repoRoot, "node_modules/tiddlywiki/boot/boot.js")).TiddlyWiki();
    emptyWiki = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-syncer-"));
    $tw.boot.argv = [emptyWiki];
    await new Promise((resolve) => $tw.boot.boot(resolve));
    globalThis.$tw = $tw;
  });
  after(() => {
    fs.rmSync(emptyWiki, { recursive: true, force: true });
  });
  return () => $tw;
}

export function pluginModule(name) {
  return require(path.join(repoRoot, "tiddlygit-plugin", name));
}

// The server, as seen through the TiddlyWeb adaptor
export class FakeServer {
  constructor() {
    this.tiddlers = new Map();
    this.revision = 0;
    this.loads = 0;
    // Saves not answered while true, like an unreachable server
    this.unreachable = false;
    this.heldSaves = [];
    // Changes refused while true, like during a synchronization
    this.locked = false;
  }

  reachable() {
    this.unreachable = false;
    this.heldSaves.splice(0).forEach((save) => save());
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
        if (!this.tiddlers.has(title)) {
          reply(callback, "XMLHttpRequest error code: 404");
          return;
        }
        const { fields, revision } = this.tiddlers.get(title);
        reply(callback, null, { ...fields, revision });
      },
      saveTiddler: (tiddler, callback) => {
        if (this.unreachable) {
          this.heldSaves.push(() => this.adaptor().saveTiddler(tiddler, callback));
          return;
        }
        if (this.locked) {
          reply(callback, "XMLHttpRequest error code: 503");
          return;
        }
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

// A browser wiki and its syncer, with the tiddlygit protections
export function startSyncer($tw, server) {
  const wiki = new $tw.Wiki();
  wiki.addTiddler({ title: "$:/config/SyncFilter", text: "[is[tiddler]] -[prefix[$:/config/]] -[prefix[$:/temp/]]" });
  const syncer = new $tw.Syncer({ wiki, syncadaptor: server.adaptor(), logging: false, disableUI: true, pollTimerInterval: 600000, errorRetryInterval: 100 });
  pluginModule("keep-local-changes.js").keepLocalChanges(syncer);
  pluginModule("synchronize.js").ignoreRefusedChanges(syncer);
  return { wiki, syncer };
}

export function stopSyncer(syncer) {
  syncer.processTaskQueue = () => {};
  clearTimeout(syncer.taskTimerId);
}

// Types text in the "Form" tiddler, like an edit-text widget
export function typeIn($tw, wiki, text) {
  wiki.addTiddler(new $tw.Tiddler(wiki.getTiddler("Form"), { text }));
}
