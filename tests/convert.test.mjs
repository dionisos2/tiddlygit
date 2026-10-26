// Tests of convert_wiki_folder.sh, which moves an existing wiki from the old
// Wikis/<name>/ layout (Bob) to the wiki/ folder.
//
// Run with: node --test tests/

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "convert_wiki_folder.sh");

const OLD_INFO = JSON.stringify({ description: "Bob demo", plugins: ["tiddlywiki/tiddlyweb", "tiddlywiki/filesystem", "tiddlywiki/katex"] }, null, 2);

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(relative, content) {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const exists = (relative) => fs.existsSync(path.join(repo, relative));
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");
const tracked = (relative) => git("ls-files", "--", relative).trim() !== "";

function convert(...args) {
  return spawnSync("bash", [script, ...args], { cwd: repo, encoding: "utf8" });
}

// A repository using the old layout, like a fork of TiddlyGit used with Bob.
function createOldRepo(name = "planning") {
  const wiki = `Wikis/${name}`;
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write(".gitignore", [
    "node_modules",
    "",
    `${wiki}/plugins`,
    `${wiki}/tiddlers/PersonalConfiguration.tid`,
    `${wiki}/tiddlers/$__config*`,
  ].join("\n"));
  write(`${wiki}/tiddlywiki.info`, OLD_INFO);
  write(`${wiki}/tiddlers/A.tid`, "title: A\n\nalpha");
  write(`${wiki}/tiddlers/sub/C.tid`, "title: C\n\ngamma");
  write(`${wiki}/tiddlers/$__StoryList.tid`, "list: A\ntitle: $:/StoryList\n\n");
  write(`${wiki}/tiddlers/$__MultiUser_EditingTiddlers.tid`, "title: $:/Bob/EditingTiddlers\nlist:\n\n");
  write(`${wiki}/tiddlers/$__plugins_OokTech_Bob_NodeScriptHandlers.js`, "// Bob");
  write(`${wiki}/tiddlers/$__plugins_OokTech_Bob_NodeScriptHandlers.js.meta`, "title: $:/plugins/OokTech/Bob/NodeScriptHandlers.js\n");
  write(`${wiki}/settings/settings.json`, "{}");
  write(`${wiki}/example-start-script.sh`, "tiddlywiki --wsserver");
  write(`${wiki}/jours_feries.js`, "// holidays");
  write(`${wiki}/ressources/image.svg`, "<svg/>");
  git("add", "-A");
  git("commit", "-q", "-m", "Old layout");
  // Local files, ignored by git
  write(`${wiki}/tiddlers/PersonalConfiguration.tid`, "title: PersonalConfiguration\ncurrent-user: Me\n\n");
  write(`${wiki}/tiddlers/$__config_Something.tid`, "title: $:/config/Something\n\nyes");
  write(`${wiki}/plugins/TW5-Bob/plugin.info`, "{}");
  write(`${wiki}/plugins/tw5-relink/plugin.info`, "{}");
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-convert-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test("moves the wiki to wiki/ and keeps the git history of the tiddlers", () => {
  createOldRepo();
  const result = convert();
  assert.equal(result.status, 0, result.stderr + result.stdout);

  assert.equal(exists("Wikis"), false);
  assert.equal(read("wiki/tiddlywiki.info"), OLD_INFO);
  assert.equal(read("wiki/tiddlers/A.tid"), "title: A\n\nalpha");
  assert.equal(read("wiki/tiddlers/sub/C.tid"), "title: C\n\ngamma");
  assert.equal(read("wiki/jours_feries.js"), "// holidays");
  assert.equal(read("wiki/ressources/image.svg"), "<svg/>");
  assert.ok(tracked("wiki/tiddlers/A.tid"));

  git("commit", "-q", "-m", "Convert");
  assert.match(git("log", "--follow", "--format=%s", "--", "wiki/tiddlers/A.tid"), /Old layout/);
});

test("keeps the local files ignored by git", () => {
  createOldRepo();
  assert.equal(convert().status, 0);

  assert.match(read("wiki/tiddlers/PersonalConfiguration.tid"), /current-user: Me/);
  assert.equal(read("wiki/tiddlers/$__config_Something.tid"), "title: $:/config/Something\n\nyes");
  assert.equal(tracked("wiki/tiddlers/PersonalConfiguration.tid"), false);
  assert.equal(git("status", "--porcelain", "--", "wiki/tiddlers/PersonalConfiguration.tid"), "");
});

test("removes what belonged to Bob", () => {
  createOldRepo();
  assert.equal(convert().status, 0);

  for (const file of [
    "wiki/settings",
    "wiki/example-start-script.sh",
    "wiki/tiddlers/$__MultiUser_EditingTiddlers.tid",
    "wiki/tiddlers/$__plugins_OokTech_Bob_NodeScriptHandlers.js",
    "wiki/tiddlers/$__plugins_OokTech_Bob_NodeScriptHandlers.js.meta",
    "wiki/plugins/TW5-Bob",
  ]) {
    assert.equal(exists(file), false, `${file} still exists`);
    assert.equal(tracked(file), false, `${file} is still tracked`);
  }
  assert.ok(exists("wiki/plugins/tw5-relink/plugin.info"), "other plugins are kept");
});

test("updates .gitignore and stops tracking the story list", () => {
  createOldRepo();
  assert.equal(convert().status, 0);

  const gitignore = read(".gitignore").split("\n");
  assert.deepEqual(gitignore.filter((line) => line.includes("Wikis")), []);
  assert.ok(gitignore.includes("wiki/plugins"));
  assert.ok(gitignore.includes("wiki/tiddlers/PersonalConfiguration.tid"));
  assert.ok(gitignore.includes("wiki/tiddlers/$__StoryList.tid"));
  assert.ok(exists("wiki/tiddlers/$__StoryList.tid"), "the story list is kept on disk");
  assert.equal(tracked("wiki/tiddlers/$__StoryList.tid"), false);
});

test("refuses to run with uncommitted changes", () => {
  createOldRepo();
  write("Wikis/planning/tiddlers/A.tid", "title: A\n\nchanged");
  const result = convert();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted/);
  assert.ok(exists("Wikis/planning/tiddlers/A.tid"));
  assert.equal(exists("wiki"), false);
});

test("does nothing on a wiki already converted", () => {
  createOldRepo();
  assert.equal(convert().status, 0);
  git("commit", "-q", "-am", "Convert");
  const head = git("rev-parse", "HEAD");

  const result = convert();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to convert/i);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--porcelain"), "");
});

test("needs the wiki folder when there are several wikis", () => {
  createOldRepo("first");
  write("Wikis/second/tiddlers/B.tid", "title: B\n\nbeta");
  git("add", "-A");
  git("commit", "-q", "-m", "Second wiki");

  const ambiguous = convert();
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /Wikis\/first.*Wikis\/second|several/s);

  const result = convert("Wikis/second");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read("wiki/tiddlers/B.tid"), "title: B\n\nbeta");
  assert.ok(exists("Wikis/first/tiddlers/A.tid"), "the other wiki is left alone");
});

// After merging the new version of TiddlyGit, wiki/ already holds the template
// tiddlers, while the tiddlers created by the user are still in Wikis/<name>/.
function mergeUpstreamLayout() {
  write("wiki/tiddlywiki.info", '{"description": "TiddlyGit wiki"}');
  write("wiki/tiddlers/SynchronizeButton.tid", "title: SynchronizeButton\n\nnew button");
  write("wiki/tiddlers/A.tid", "title: A\n\nalpha");
  git("add", "-A");
  git("commit", "-q", "-m", "Merge upstream");
}

test("finishes the conversion after merging the new version of TiddlyGit", () => {
  createOldRepo();
  mergeUpstreamLayout();
  const result = convert();
  assert.equal(result.status, 0, result.stderr + result.stdout);

  assert.equal(exists("Wikis"), false);
  assert.equal(read("wiki/tiddlers/SynchronizeButton.tid"), "title: SynchronizeButton\n\nnew button");
  assert.equal(read("wiki/tiddlers/A.tid"), "title: A\n\nalpha");
  assert.equal(read("wiki/tiddlers/sub/C.tid"), "title: C\n\ngamma");
  assert.match(read("wiki/tiddlers/PersonalConfiguration.tid"), /current-user: Me/);
  assert.equal(read("wiki/tiddlywiki.info"), OLD_INFO, "the user's configuration wins");
  assert.equal(exists("wiki/tiddlers/$__MultiUser_EditingTiddlers.tid"), false);
});

test("stops without changing anything when a tiddler differs in both folders", () => {
  createOldRepo();
  mergeUpstreamLayout();
  write("wiki/tiddlers/sub/C.tid", "title: C\n\nanother gamma");
  git("add", "-A");
  git("commit", "-q", "-m", "Conflicting C");
  const before = git("status", "--porcelain", "--ignored");

  const result = convert();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tiddlers\/sub\/C\.tid/);
  assert.equal(git("status", "--porcelain", "--ignored"), before);
});

// --- Whole workflow: a fork of TiddlyGit getting the new version ---------------

// Real tiddlers are long enough for git to detect them as renamed when edited.
const longText = (name) => Array.from({ length: 15 }, (_, i) => `line ${i} of ${name}, some tiddler content`).join("\n");

// Creates an upstream repository converted to the new layout, and a fork of
// its old version where the user added and edited tiddlers.
function createForkOfConvertedUpstream() {
  const upstream = repo;
  createOldRepo("BobWiki");
  write("Wikis/BobWiki/tiddlers/Button.tid", "title: Button\n\n" + longText("Button"));
  write("Wikis/BobWiki/tiddlers/A.tid", "title: A\n\n" + longText("A"));
  git("add", "-A");
  git("commit", "-q", "-m", "Template");

  const fork = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-fork-"));
  execFileSync("git", ["clone", "-q", upstream, fork]);
  repo = fork;
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("Wikis/BobWiki/tiddlers/Mine.tid", "title: Mine\n\n" + longText("Mine"));
  write("Wikis/BobWiki/tiddlers/A.tid", read("Wikis/BobWiki/tiddlers/A.tid") + "\nedited in the fork");
  git("add", "-A");
  git("commit", "-q", "-m", "User changes");
  write("Wikis/BobWiki/tiddlers/PersonalConfiguration.tid", "title: PersonalConfiguration\ncurrent-user: Me\n\n");

  repo = upstream;
  assert.equal(convert().status, 0);
  write("wiki/tiddlers/Button.tid", read("wiki/tiddlers/Button.tid") + "\nnew version of the button");
  git("add", "-A");
  git("commit", "-q", "-m", "Convert upstream");

  repo = fork;
  // afterEach removes the fork, the current repository
  return () => fs.rmSync(upstream, { recursive: true, force: true });
}

function assertForkConverted() {
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(exists("Wikis"), false);
  assert.match(read("wiki/tiddlers/A.tid"), /edited in the fork$/);
  assert.match(read("wiki/tiddlers/Button.tid"), /new version of the button$/);
  assert.match(read("wiki/tiddlers/Mine.tid"), /^title: Mine/);
  assert.match(read("wiki/tiddlers/PersonalConfiguration.tid"), /current-user: Me/);
}

test("a fork converted before merging the new version merges without conflict", () => {
  const cleanup = createForkOfConvertedUpstream();
  try {
    assert.equal(convert().status, 0);
    git("commit", "-q", "-m", "Convert");
    git("fetch", "-q");
    git("merge", "-q", "--no-edit", "origin/HEAD");
    assertForkConverted();
  } finally {
    cleanup();
  }
});

test("a fork merging the new version with directory renames can be converted afterwards", () => {
  const cleanup = createForkOfConvertedUpstream();
  try {
    git("fetch", "-q");
    git("-c", "merge.directoryRenames=true", "merge", "-q", "--no-edit", "origin/HEAD");
    assert.equal(convert().status, 0);
    git("commit", "-q", "--allow-empty", "-m", "Convert");
    assertForkConverted();
  } finally {
    cleanup();
  }
});
