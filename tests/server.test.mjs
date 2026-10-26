// Tests of the TiddlyWiki server used by TiddlyGit: the core `--listen` server
// plus the tiddlygit plugin (tiddlygit-plugin/), which adds:
//   - loading of tiddler files changed on disk (text editor, git...),
//   - a route running synchronize.sh, used by the synchronize button.
//
// Each test starts a real server on a temporary wiki and talks to it over HTTP,
// like the browser does.
//
// Run with: node --test tests/

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
const pluginPath = path.join(repoRoot, "tiddlygit-plugin");
const tiddlywikiJs = path.join(repoRoot, "node_modules/tiddlywiki/tiddlywiki.js");

const TITLE = "PlanningDionisos";
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

function planningFields(extra = {}) {
  return {
    title: TITLE,
    "current-user": "Dionisos",
    "date-start": "23/10/2026",
    "days-count": "3",
    "nouvelle-tache": "",
    tags: "Bookmark Racine",
    type: "text/vnd.tiddlywiki",
    text: "{{||TemplatePlanning}}",
    ...extra,
  };
}

function tidFile(fields) {
  const { text = "", ...header } = fields;
  return Object.keys(header).sort().map((k) => `${k}: ${header[k]}`).join("\n") + "\n\n" + text;
}

function createWiki(dir) {
  fs.mkdirSync(path.join(dir, "tiddlers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tiddlywiki.info"), JSON.stringify({
    plugins: ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem"],
    themes: ["tiddlywiki/vanilla", "tiddlywiki/snowwhite"],
  }));
  if (fs.existsSync(pluginPath)) {
    fs.cpSync(pluginPath, path.join(dir, "plugins/tiddlygit"), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "tiddlers", TITLE + ".tid"),
    tidFile(planningFields({ created: "20220525015743800", modified: "20261026112222850" })));
}

class Server {
  constructor(wikiDir, port, env = {}) {
    this.wikiDir = wikiDir;
    this.port = port;
    this.env = env;
    this.output = "";
  }

  async start() {
    this.process = spawn(process.execPath,
      [tiddlywikiJs, this.wikiDir, "--listen", `port=${this.port}`, "host=127.0.0.1"], {
        cwd: this.wikiDir,
        env: { ...process.env, ...this.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    const collect = (data) => { this.output += data.toString(); };
    this.process.stdout.on("data", collect);
    this.process.stderr.on("data", collect);
    for (let i = 0; i < 100; i++) {
      if (this.process.exitCode !== null) break;
      try {
        await fetch(this.url("/status"));
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error("Server did not start:\n" + this.output);
  }

  async stop() {
    if (this.process && this.process.exitCode === null) {
      const exited = new Promise((resolve) => this.process.once("exit", resolve));
      this.process.kill();
      await exited;
    }
  }

  url(pathname) {
    return `http://127.0.0.1:${this.port}${pathname}`;
  }

  async putTiddler(fields) {
    const response = await fetch(this.url("/recipes/default/tiddlers/" + encodeURIComponent(fields.title)), {
      method: "PUT",
      headers: { "X-Requested-With": "TiddlyWiki", "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    assert.equal(response.status, 204, `PUT ${fields.title} failed`);
  }

  // Returns the tiddler fields (custom fields flattened), or null if missing.
  async getTiddler(title) {
    const response = await fetch(this.url("/recipes/default/tiddlers/" + encodeURIComponent(title)));
    if (response.status === 404) return null;
    assert.equal(response.status, 200, `GET ${title} failed`);
    const { fields = {}, ...known } = await response.json();
    return { ...known, ...fields };
  }

  async synchronize(headers = { "X-Requested-With": "TiddlyWiki" }) {
    return fetch(this.url("/tiddlygit/synchronize"), { method: "POST", headers });
  }
}

// Polls `check` until it returns a truthy value, or fails after `timeout` ms.
async function eventually(check, message, timeout = 5000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await check();
    if (last) return last;
    await sleep(100);
  }
  assert.fail(message);
}

// A bare TiddlyWiki instance (no wiki folder, no plugin) used to parse tiddler files.
let bareTw;
let emptyWiki;
async function bareTiddlyWiki() {
  if (!bareTw) {
    const bootJs = path.join(repoRoot, "node_modules/tiddlywiki/boot/boot.js");
    const $tw = createRequire(import.meta.url)(bootJs).TiddlyWiki();
    emptyWiki = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-reader-"));
    // Boot without any command, we only need the deserializers.
    $tw.boot.argv = [emptyWiki];
    await new Promise((resolve) => $tw.boot.boot(resolve));
    bareTw = $tw;
  }
  return bareTw;
}

// Reads a tiddler from the tiddlers folder the way TiddlyWiki does when it boots.
async function tiddlerOnDisk(wikiDir, title) {
  const $tw = await bareTiddlyWiki();
  const files = $tw.loadTiddlersFromPath(path.join(wikiDir, "tiddlers"));
  return files.flatMap((file) => file.tiddlers).find((fields) => fields.title === title);
}

// Like in the TiddlyGit repository, the wiki folder is next to synchronize.sh
let rootDir;
let wikiDir;
let server;

async function startServer(env = {}) {
  server = new Server(wikiDir, await freePort(), env);
  await server.start();
}

// Each test gets its own wiki and server.
beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-repo-"));
  wikiDir = path.join(rootDir, "wiki");
  createWiki(wikiDir);
});

afterEach(async () => {
  await server?.stop();
  server = null;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

after(() => {
  if (emptyWiki) fs.rmSync(emptyWiki, { recursive: true, force: true });
});

// --- Saving from the browser -------------------------------------------------

test("a field value ending with a space is kept on disk", async () => {
  await startServer();
  const value = "Acheter du pain ";
  await server.putTiddler(planningFields({ "nouvelle-tache": value, modified: now() }));

  const fields = await eventually(async () => {
    const onDisk = await tiddlerOnDisk(wikiDir, TITLE);
    return onDisk?.["nouvelle-tache"] === value && onDisk;
  }, `"${value}" never reached the disk`);
  assert.equal(fields.text, "{{||TemplatePlanning}}");
});

test("typing words separated by spaces never deletes nor reverts the tiddler", async () => {
  await startServer();
  const problems = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 1; i <= TYPED_TEXT.length; i++) {
      const typed = TYPED_TEXT.slice(0, i);
      await server.putTiddler(planningFields({ "nouvelle-tache": typed, modified: now() }));
      await sleep(30 + Math.random() * 60);
      const current = await server.getTiddler(TITLE);
      if (!current) problems.push(`deleted after typing "${typed}"`);
      else if (current["nouvelle-tache"] !== typed) problems.push(`"${typed}" became "${current["nouvelle-tache"]}"`);
    }
  }
  // Leave time to the file watcher to react to the last writes.
  await sleep(2000);
  const current = await server.getTiddler(TITLE);
  if (current?.["nouvelle-tache"] !== TYPED_TEXT) problems.push(`final value is ${JSON.stringify(current?.["nouvelle-tache"])}`);
  assert.deepEqual(problems, []);
});

test("the server does not reload the files it writes itself", async () => {
  await startServer();
  await server.putTiddler(planningFields({ "nouvelle-tache": "Acheter ", modified: now() }));
  const { revision } = await server.getTiddler(TITLE);
  await sleep(2500);
  assert.equal((await server.getTiddler(TITLE)).revision, revision);
});

test("the server does not reload the files it writes for tiddlers with an empty text", async () => {
  await startServer();
  // A .tid file cannot tell an empty text from a missing one
  await server.putTiddler({ title: "Empty", text: "", list: "a b" });
  const { revision } = await server.getTiddler("Empty");
  await sleep(2500);
  assert.equal((await server.getTiddler("Empty")).revision, revision);
});

const tiddlerFiles = (title) => fs.readdirSync(path.join(wikiDir, "tiddlers")).filter((name) => name.startsWith(title + "."));

test("a tiddler saved as .json stays .json", async () => {
  await startServer();
  await server.putTiddler(planningFields({ "nouvelle-tache": "Acheter ", modified: now() }));
  await eventually(() => tiddlerFiles(TITLE).join() === TITLE + ".json", "the tiddler was not saved as .json");

  await server.putTiddler(planningFields({ "nouvelle-tache": "Acheter du", modified: now() }));
  await eventually(async () => (await tiddlerOnDisk(wikiDir, TITLE))?.["nouvelle-tache"] === "Acheter du",
    "the change was not saved");
  assert.deepEqual(tiddlerFiles(TITLE), [TITLE + ".json"]);
});

test("a tiddler loaded from a .json file stays .json", async () => {
  fs.unlinkSync(path.join(wikiDir, "tiddlers", TITLE + ".tid"));
  fs.writeFileSync(path.join(wikiDir, "tiddlers", TITLE + ".json"), JSON.stringify([planningFields()], null, 4));
  await startServer();

  await server.putTiddler(planningFields({ "days-count": "5", modified: now() }));
  await eventually(async () => (await tiddlerOnDisk(wikiDir, TITLE))?.["days-count"] === "5", "the change was not saved");
  assert.deepEqual(tiddlerFiles(TITLE), [TITLE + ".json"]);
});

test("a tiddler that never needed .json is saved as .tid", async () => {
  await startServer();
  await server.putTiddler({ title: "Simple", text: "hello", tags: "a b" });
  await eventually(() => tiddlerFiles("Simple").join() === "Simple.tid", "the tiddler was not saved as .tid");
});

// --- Loading files changed on disk -------------------------------------------

test("a tiddler file modified on disk is loaded by the server", async () => {
  await startServer();
  fs.writeFileSync(path.join(wikiDir, "tiddlers", TITLE + ".tid"),
    tidFile(planningFields({ text: "Edited with a text editor" })));

  await eventually(async () => (await server.getTiddler(TITLE))?.text === "Edited with a text editor",
    "the modified file was not loaded");
});

test("a new tiddler file is loaded by the server", async () => {
  await startServer();
  fs.writeFileSync(path.join(wikiDir, "tiddlers", "New one.tid"), tidFile({ title: "New one", text: "Hello" }));

  await eventually(async () => (await server.getTiddler("New one"))?.text === "Hello",
    "the new file was not loaded");
});

test("a new tiddler file in a subfolder is loaded by the server", async () => {
  await startServer();
  fs.mkdirSync(path.join(wikiDir, "tiddlers", "sub"));
  fs.writeFileSync(path.join(wikiDir, "tiddlers", "sub", "Deep.tid"), tidFile({ title: "Deep", text: "Down" }));

  await eventually(async () => (await server.getTiddler("Deep"))?.text === "Down",
    "the new file was not loaded");
});

test("a tiddler whose file is deleted is removed from the server", async () => {
  await startServer();
  fs.unlinkSync(path.join(wikiDir, "tiddlers", TITLE + ".tid"));

  await eventually(async () => (await server.getTiddler(TITLE)) === null, "the tiddler is still there");
  await sleep(1500);
  assert.equal(await tiddlerOnDisk(wikiDir, TITLE), undefined, "the server recreated the file");
});

test("changing the title inside a file renames the tiddler", async () => {
  await startServer();
  fs.writeFileSync(path.join(wikiDir, "tiddlers", TITLE + ".tid"),
    tidFile(planningFields({ title: "Renamed" })));

  await eventually(async () => (await server.getTiddler("Renamed")) && (await server.getTiddler(TITLE)) === null,
    "the tiddler was not renamed");
});

// --- Synchronize route ---------------------------------------------------------

function writeScript(body) {
  const script = path.join(wikiDir, "sync-test.sh");
  fs.writeFileSync(script, "#!/usr/bin/env bash\n" + body, { mode: 0o755 });
  return script;
}

test("the synchronize route runs the script and returns its result", async () => {
  const script = writeScript('echo "hello from $PWD"\nexit 3\n');
  await startServer({ TIDDLYGIT_SYNC_SCRIPT: script });

  const response = await server.synchronize();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.code, 3);
  assert.match(result.output, new RegExp("hello from " + wikiDir));
});

test("the synchronize route runs the synchronize.sh next to the wiki folder by default", async () => {
  fs.writeFileSync(path.join(rootDir, "synchronize.sh"), '#!/usr/bin/env bash\necho "default script in $PWD"\n', { mode: 0o755 });
  await startServer();

  const result = await (await server.synchronize()).json();
  assert.equal(result.code, 0);
  assert.equal(result.output, `default script in ${rootDir}\n`);
});

test("the synchronize route requires the TiddlyWiki CSRF header", async () => {
  const marker = path.join(wikiDir, "ran");
  const script = writeScript(`touch "${marker}"\n`);
  await startServer({ TIDDLYGIT_SYNC_SCRIPT: script });

  const response = await server.synchronize({});
  assert.equal(response.status, 403);
  assert.equal(fs.existsSync(marker), false);
});

test("pending browser changes are written to disk before the script runs", async () => {
  const script = writeScript(`grep -q "Just typed" "${path.join(wikiDir, "tiddlers", TITLE + ".tid")}" && echo saved || echo missing\n`);
  await startServer({ TIDDLYGIT_SYNC_SCRIPT: script });
  await server.putTiddler(planningFields({ text: "Just typed", modified: now() }));

  const result = await (await server.synchronize()).json();
  assert.match(result.output, /saved/);
});

test("files changed by the script are loaded as soon as it ends", async () => {
  const tiddlers = path.join(wikiDir, "tiddlers");
  const script = writeScript([
    `printf 'title: From git\\n\\nMerged' > "${path.join(tiddlers, "From git.tid")}"`,
    `rm "${path.join(tiddlers, TITLE + ".tid")}"`,
  ].join("\n") + "\n");
  await startServer({ TIDDLYGIT_SYNC_SCRIPT: script });

  await server.synchronize();
  assert.equal((await server.getTiddler("From git"))?.text, "Merged");
  assert.equal(await server.getTiddler(TITLE), null);
});

test("the server does not write files while the script runs", async () => {
  const file = path.join(wikiDir, "tiddlers", "During sync.tid");
  const started = path.join(wikiDir, "started");
  const script = writeScript(`touch "${started}"\nsleep 2\n[ -e "${file}" ] && echo written || echo untouched\n`);
  await startServer({ TIDDLYGIT_SYNC_SCRIPT: script });

  const pending = server.synchronize();
  await eventually(() => fs.existsSync(started), "the script did not start");
  await server.putTiddler({ title: "During sync", text: "typed while syncing" });
  const result = await (await pending).json();

  assert.match(result.output, /untouched/);
  await eventually(async () => (await tiddlerOnDisk(wikiDir, "During sync"))?.text === "typed while syncing",
    "the change made during the synchronization was never saved");
});

test("only one synchronization runs at a time", async () => {
  const script = writeScript("sleep 1\n");
  await startServer({ TIDDLYGIT_SYNC_SCRIPT: script });

  const first = server.synchronize();
  await sleep(300);
  const second = await server.synchronize();
  assert.equal(second.status, 409);
  assert.equal((await first).status, 200);
});
