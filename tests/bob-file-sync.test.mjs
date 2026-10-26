// Regression tests for tiddlers being deleted/corrupted while typing in a form
// whose fields belong to the tiddler itself (e.g. PlanningDionisos + TemplatePlanning).
//
// Root cause under investigation: Bob caches the .tid file info of a tiddler and
// never switches to .json, but .tid cannot hold field values with leading or
// trailing whitespace. Bob's own file watcher then re-reads the file, sees a
// different tiddler, unlinks and rewrites it, and that unlink can be reported as
// a deletion (without going through the trashbin).
//
// These tests start a real Bob server on a temporary wiki and talk to it over
// the websocket protocol, exactly like the browser does.
//
// Run with: node --test tests/
// Env vars:
//   BOB_PATH      Bob plugin folder (default: plugins_repositories/TW5-Bob)
//   TYPING_ROUNDS Number of times the typing simulation is repeated (default: 3).
//                 The deletion is a race; one round was enough to trigger it in
//                 6 runs out of 6, a few rounds make it near certain.

import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bobPath = path.resolve(process.env.BOB_PATH || path.join(repoRoot, "plugins_repositories/TW5-Bob"));
const tiddlywikiJs = path.join(repoRoot, "node_modules/tiddlywiki/tiddlywiki.js");
const typingRounds = Number(process.env.TYPING_ROUNDS || 3);

const TITLE = "PlanningDionisos";
const WIKI = "RootWiki";
const SESSION_ID = WIKI + "000001";
const TYPED_TEXT = "Acheter du pain frais ";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Current time in TiddlyWiki's YYYYMMDDHHMMSSmmm format.
const now = () => new Date().toISOString().replace(/\D/g, "").slice(0, 17);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function baseFields(extra = {}) {
  return {
    title: TITLE,
    "current-user": "Dionisos",
    "date-start": "23/10/2026",
    "date-start-temp": "23/10/2026",
    "days-count": "3",
    "days-count-temp": "4",
    "nouvelle-tache": "",
    "show-day-record": "yes",
    tags: "Bookmark Racine",
    type: "text/vnd.tiddlywiki",
    text: "{{||TemplatePlanning}}",
    ...extra,
  };
}

function createWiki(dir, port) {
  fs.mkdirSync(path.join(dir, "tiddlers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "settings"), { recursive: true });
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tiddlywiki.info"), JSON.stringify({
    plugins: ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem"],
    themes: ["tiddlywiki/vanilla", "tiddlywiki/snowwhite"],
  }));
  fs.writeFileSync(path.join(dir, "settings/settings.json"), JSON.stringify({
    suppressBrowser: "true",
    disableBrowserAlerts: "yes",
    "ws-server": { port, host: "127.0.0.1", autoIncrementPort: false },
    backups: { enable: "no" },
  }));
  fs.cpSync(bobPath, path.join(dir, "plugins/TW5-Bob"), {
    recursive: true,
    filter: (src) => !/[\\/](\.git|node_modules)$/.test(src),
  });
  const fields = baseFields({ created: "20220525015743800", modified: "20261026112222850" });
  const { text, ...header } = fields;
  const tid = Object.keys(header).sort().map((k) => `${k}: ${header[k]}`).join("\n") + "\n\n" + text;
  fs.writeFileSync(path.join(dir, "tiddlers", TITLE + ".tid"), tid);
}

class BobServer {
  constructor(wikiDir, port) {
    this.wikiDir = wikiDir;
    this.port = port;
    this.output = "";
  }

  async start() {
    this.process = spawn(process.execPath, [tiddlywikiJs, this.wikiDir, "--wsserver"], {
      cwd: this.wikiDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (data) => { this.output += data.toString(); };
    this.process.stdout.on("data", collect);
    this.process.stderr.on("data", collect);
    for (let i = 0; i < 100; i++) {
      if (this.process.exitCode !== null) break;
      try {
        await fetch(`http://127.0.0.1:${this.port}/`);
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error("Bob server did not start:\n" + this.output);
  }

  async stop() {
    if (this.process && this.process.exitCode === null) {
      const exited = new Promise((resolve) => this.process.once("exit", resolve));
      this.process.kill();
      await exited;
    }
  }
}

// Minimal websocket client speaking Bob's browser protocol.
class FakeBrowser {
  constructor(port) {
    this.port = port;
    this.received = [];
    this.nextId = 1;
  }

  async connect() {
    this.socket = new WebSocket(`ws://127.0.0.1:${this.port}/?${SESSION_ID}`);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      this.received.push(message);
      // Acknowledge, otherwise the server keeps resending.
      if (message.id) this.send({ type: "ack", id: message.id });
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve);
      this.socket.addEventListener("error", reject);
    });
    // The server registers the connection asynchronously after the handshake.
    await sleep(500);
  }

  send(message) {
    this.socket.send(JSON.stringify({ ...message, wiki: WIKI, sessionId: SESSION_ID }));
  }

  saveTiddler(fields) {
    this.send({ type: "saveTiddler", id: "test-" + this.nextId++, tiddler: { fields } });
  }

  deletions(title) {
    return this.received.filter((m) => m.type === "deleteTiddler" && m.tiddler?.fields?.title === title);
  }

  close() {
    this.socket?.close();
  }
}

// A bare TiddlyWiki instance (no wiki folder, no Bob) used to parse tiddler files.
let bareTw;
let emptyWiki;
async function bareTiddlyWiki() {
  if (!bareTw) {
    const bootJs = path.join(repoRoot, "node_modules/tiddlywiki/boot/boot.js");
    const $tw = createRequire(import.meta.url)(bootJs).TiddlyWiki();
    emptyWiki = fs.mkdtempSync(path.join(os.tmpdir(), "bob-file-sync-reader-"));
    // Boot without any command, we only need the deserializers.
    $tw.boot.argv = [emptyWiki];
    await new Promise((resolve) => $tw.boot.boot(resolve));
    bareTw = $tw;
  }
  return bareTw;
}

// Reads TITLE from the tiddlers folder the way TiddlyWiki does when it boots.
async function tiddlerOnDisk(wikiDir) {
  const $tw = await bareTiddlyWiki();
  const files = $tw.loadTiddlersFromPath(path.join(wikiDir, "tiddlers"));
  const tiddlers = files.flatMap((file) => file.tiddlers);
  return tiddlers.find((fields) => fields.title === TITLE);
}

let wikiDir;
let server;
let browser;

// Each test gets its own wiki and server, because a failing test can leave Bob
// looping on the file and pollute the following tests.
beforeEach(async () => {
  assert.ok(fs.existsSync(path.join(bobPath, "plugin.info")), `Bob plugin not found in ${bobPath}`);
  wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), "bob-file-sync-"));
  const port = await freePort();
  createWiki(wikiDir, port);
  server = new BobServer(wikiDir, port);
  await server.start();
  browser = new FakeBrowser(port);
  await browser.connect();
});

afterEach(async () => {
  browser?.close();
  await server?.stop();
  if (wikiDir) fs.rmSync(wikiDir, { recursive: true, force: true });
});

after(() => {
  if (emptyWiki) fs.rmSync(emptyWiki, { recursive: true, force: true });
});

test("a field value ending with a space survives a server restart", async () => {
  const value = "Acheter du pain ";
  browser.saveTiddler(baseFields({ "nouvelle-tache": value, modified: now() }));
  await sleep(1500);

  const fields = await tiddlerOnDisk(wikiDir);
  assert.ok(fields, `${TITLE} is missing from the tiddlers folder`);
  assert.equal(fields["nouvelle-tache"], value);
});

async function typeInForm(text) {
  for (let round = 0; round < typingRounds; round++) {
    for (let i = 1; i <= text.length; i++) {
      browser.saveTiddler(baseFields({
        "nouvelle-tache": text.slice(0, i),
        modified: now(),
      }));
      await sleep(30 + Math.random() * 60);
    }
    // Clearing the field, like the "Nouvelle tache" button does.
    browser.saveTiddler(baseFields({ modified: now() }));
    await sleep(300);
  }
  await sleep(1500);
}

test("control: typing without spaces never deletes the tiddler", async () => {
  await typeInForm("AcheterDuPainFrais");
  assert.equal(browser.deletions(TITLE).length, 0, `the server told the browser to delete ${TITLE}`);
});

test("typing words separated by spaces never deletes the tiddler", async () => {
  await typeInForm(TYPED_TEXT);
  assert.equal(browser.deletions(TITLE).length, 0, `the server told the browser to delete ${TITLE}`);
  const fields = await tiddlerOnDisk(wikiDir);
  assert.ok(fields, `${TITLE} is missing from the tiddlers folder`);
  assert.equal(fields.text, "{{||TemplatePlanning}}");
});
