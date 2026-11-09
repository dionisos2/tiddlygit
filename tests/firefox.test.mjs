// End-to-end tests in a real browser: a headless Firefox, driven through
// WebDriver BiDi (no dependency, node has a WebSocket client), connected to a
// real TiddlyWiki server with the tiddlygit plugin.
//
// Skipped when Firefox is not installed.
//
// Run with: node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasFirefox = spawnSync("sh", ["-c", "command -v firefox"]).status === 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Polls `check` until it returns a truthy value, returns the time it took
async function eventually(check, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return Date.now() - start;
    await sleep(100);
  }
  assert.fail(message);
}

// A wiki with the tiddlygit plugin, served by a real TiddlyWiki server
async function startWiki(root, syncScript) {
  const wikiDir = path.join(root, "wiki");
  fs.mkdirSync(path.join(wikiDir, "tiddlers"), { recursive: true });
  fs.writeFileSync(path.join(wikiDir, "tiddlywiki.info"), JSON.stringify({
    plugins: ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem"],
    themes: ["tiddlywiki/vanilla", "tiddlywiki/snowwhite"],
  }));
  fs.cpSync(path.join(repoRoot, "tiddlygit-plugin"), path.join(wikiDir, "plugins/tiddlygit"), { recursive: true });
  fs.writeFileSync(path.join(wikiDir, "tiddlers/Note.tid"), "title: Note\n\nbefore");
  const script = path.join(root, "sync.sh");
  fs.writeFileSync(script, "#!/bin/sh\n" + syncScript, { mode: 0o755 });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const process_ = spawn(process.execPath,
    [path.join(repoRoot, "node_modules/tiddlywiki/tiddlywiki.js"), wikiDir, "--listen", `port=${port}`, "host=127.0.0.1"],
    { env: { ...process.env, TIDDLYGIT_SYNC_SCRIPT: script }, stdio: "ignore" });
  await eventually(() => fetch(url + "/status").then(() => true, () => false), "the server did not start");
  return {
    url,
    noteOnDisk: () => fs.readFileSync(path.join(wikiDir, "tiddlers/Note.tid"), "utf8"),
    stop: () => process_.kill(),
  };
}

// A headless Firefox, with a fresh profile
class Firefox {
  async start(root) {
    const port = await freePort();
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile);
    this.process = spawn("firefox", ["--headless", "--no-remote", "--profile", profile, `--remote-debugging-port=${port}`],
      { stdio: "ignore" });
    this.lastId = 0;
    this.pending = new Map();
    await eventually(async () => {
      try {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
        await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
        return true;
      } catch {
        return false;
      }
    }, "Firefox did not start", 30000);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.type === "error") pending.reject(new Error(`${message.error}: ${message.message}`));
        else pending.resolve(message.result);
      }
    };
    await this.send("session.new", { capabilities: {} });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.lastId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async stop() {
    try {
      await Promise.race([this.send("session.end"), sleep(1000)]);
    } catch {}
    if (this.process && this.process.exitCode === null) {
      const exited = new Promise((resolve) => this.process.once("exit", resolve));
      this.process.kill();
      await exited;
    }
  }

  // Opens a tab on the wiki, once TiddlyWiki is booted
  async open(url) {
    const { context } = await this.send("browsingContext.create", { type: "tab" });
    await this.send("browsingContext.navigate", { context, url, wait: "complete" });
    const tab = new Tab(this, context);
    await eventually(() => tab.evaluate("!!(window.$tw && $tw.syncer && $tw.rootWidget && $tw.wiki.getTiddlerText('Note'))"),
      "TiddlyWiki did not boot");
    return tab;
  }
}

class Tab {
  constructor(firefox, context) {
    this.firefox = firefox;
    this.context = context;
  }

  async evaluate(expression) {
    const result = await this.firefox.send("script.evaluate",
      { target: { context: this.context }, expression, awaitPromise: true, resultOwnership: "none" });
    if (result.type === "exception") throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  // Firefox slows down the rendering of the tabs in the background
  activate() {
    return this.firefox.send("browsingContext.activate", { context: this.context });
  }

  isBlocked() {
    return this.evaluate("!!document.querySelector('.tiddlygit-overlay')");
  }

  alerts() {
    return this.evaluate("Array.from(document.querySelectorAll('.tc-alert')).map((e) => e.textContent).join(' | ')");
  }

  notifications() {
    return this.evaluate("Array.from(document.querySelectorAll('.tc-notification')).map((e) => e.textContent.trim()).join(' | ')");
  }
}

test("a synchronization blocks every tab, and the changes refused meanwhile are saved after",
  { skip: !hasFirefox && "Firefox is not installed", timeout: 120000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-firefox-"));
    const wiki = await startWiki(root, "sleep 8\necho done\n");
    const firefox = new Firefox();
    try {
      await firefox.start(root);
      const a = await firefox.open(wiki.url);
      const b = await firefox.open(wiki.url);
      assert.equal(await a.isBlocked(), false);
      assert.equal(await b.isBlocked(), false);

      // The synchronize button of tab A
      await a.activate();
      await a.evaluate("$tw.rootWidget.dispatchEvent({type: 'tm-tiddlygit-synchronize'}), true");
      await eventually(() => a.isBlocked(), "the tab synchronizing is not blocked", 3000);

      // Tab B learns it when it polls the server ($:/config/SyncPollingInterval)
      await b.activate();
      await eventually(() => b.isBlocked(), "the other tab is not blocked", 10000);

      // A change in tab B while the script runs is refused by the server...
      await eventually(async () => (await (await fetch(wiki.url + "/tiddlygit/status")).json()).synchronizing,
        "the server does not synchronize");
      await sleep(2500);
      await b.evaluate("$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getTiddler('Note'), {text: 'typed in B'})), true");
      await sleep(3000);
      assert.doesNotMatch(wiki.noteOnDisk(), /typed in B/, "written while the script runs");
      assert.equal(await b.alerts(), "", "the refused change is shown as an error");

      // ...and saved after
      await eventually(async () => !(await a.isBlocked()), "the tab synchronizing is not unblocked", 20000);
      await eventually(async () => !(await b.isBlocked()), "the other tab is not unblocked", 20000);
      await eventually(() => /typed in B/.test(wiki.noteOnDisk()), "the refused change is never saved", 20000);
      assert.equal(await b.evaluate("$tw.wiki.getTiddlerText('Note')"), "typed in B");
      assert.equal(await a.alerts(), "");
      assert.equal(await b.alerts(), "");
      assert.match(await a.notifications(), /Synchronization successful/);
    } finally {
      await firefox.stop();
      wiki.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
