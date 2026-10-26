// Tests of join_upstream.sh, for a wiki repository created from a copy of
// TiddlyGit, which does not share its git history with it.
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
const script = path.join(repoRoot, "join_upstream.sh");

let root, upstream, mine;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(repo, relative, content) {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (repo, relative) => fs.readFileSync(path.join(repo, relative), "utf8");
const exists = (repo, relative) => fs.existsSync(path.join(repo, relative));
const commitAll = (repo, message) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
};
const SUBMODULE_COMMIT = "1111111111111111111111111111111111111111";
// A submodule that is not checked out: an empty folder
function addGitlink(repo, relative) {
  fs.mkdirSync(path.join(repo, relative), { recursive: true });
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${SUBMODULE_COMMIT},${relative}`);
}

function join(...args) {
  return spawnSync("bash", [script, ...args], { cwd: mine, encoding: "utf8" });
}

function init(repo, name) {
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.name", name);
  git(repo, "config", "user.email", `${name}@example.com`);
}

// TiddlyGit, with Bob in its history and the wiki/ layout now
function createUpstream() {
  init(upstream, "upstream");
  write(upstream, "run.sh", "old run with Bob");
  write(upstream, "modified_tiddlers/Bob.js", "// Bob");
  write(upstream, "tiddlers/PersonalConfiguration.tid", "title: PersonalConfiguration\n\n");
  addGitlink(upstream, "plugins_repositories/TW5-Bob");
  commitAll(upstream, "Old TiddlyGit");
  fs.rmSync(path.join(upstream, "tiddlers"), { recursive: true });
  git(upstream, "update-index", "--force-remove", "plugins_repositories/TW5-Bob");
  fs.rmSync(path.join(upstream, "modified_tiddlers/Bob.js"));
  for (const file of ["convert_wiki_folder.sh", "tiddly-merge.py", ".gitattributes"]) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(upstream, file));
  }
  write(upstream, ".gitignore", "node_modules\nwiki/plugins\nwiki/tiddlers/$__config*\nwiki/tiddlers/$__StoryList.tid\n");
  write(upstream, "run.sh", "new run");
  write(upstream, "tiddlygit-plugin/plugin.info", "{}");
  addGitlink(upstream, "plugins_repositories/tw5-relink");
  write(upstream, "wiki/tiddlywiki.info", '{"description": "TiddlyGit wiki"}');
  write(upstream, "wiki/tiddlers/SynchronizeButton.tid", "title: SynchronizeButton\n\n<<tiddlygit-synchronize-actions>>");
  write(upstream, "wiki/tiddlers/SynchronizeButtonImage.tid", "title: SynchronizeButtonImage\n\n<svg/>");
  write(upstream, "wiki/tiddlers/GitConflict.tid", "title: GitConflict\n\nList of conflicts");
  write(upstream, "wiki/tiddlers/What is this_.tid", "title: What is this?\n\nWelcome to TiddlyGit");
  commitAll(upstream, "New TiddlyGit");
}

// A wiki repository created from a copy of the old TiddlyGit
function createMine() {
  init(mine, "me");
  write(mine, ".gitignore", "node_modules\nWikis/BobWiki/plugins\nWikis/BobWiki/tiddlers/$__config*\nmy-notes.txt\n");
  write(mine, "run.sh", "old run with Bob");
  write(mine, "modified_tiddlers/Bob.js", "// Bob");
  write(mine, "tiddlers/PersonalConfiguration.tid", "title: PersonalConfiguration\ncurrent-user: Me\n\n");
  write(mine, "my-script.sh", "# my own script");
  addGitlink(mine, "plugins_repositories/TW5-Bob");
  addGitlink(mine, "plugins_repositories/tw5-relink");
  write(mine, "Wikis/BobWiki/tiddlywiki.info", '{"description": "My wiki", "plugins": ["tiddlywiki/katex"]}');
  write(mine, "Wikis/BobWiki/settings/settings.json", "{}");
  write(mine, "Wikis/BobWiki/tiddlers/My tiddler.tid", "title: My tiddler\n\nmine");
  write(mine, "Wikis/BobWiki/tiddlers/SynchronizeButton.tid",
    "tags: $:/tags/PageControls Méta\ntitle: SynchronizeButton\n\n<$action-websocketmessage $type='runScript' name='synchronize'/>");
  commitAll(mine, "My wiki");
  write(mine, "Wikis/BobWiki/tiddlers/$__config_Local.tid", "title: $:/config/Local\n\nlocal");
  git(mine, "remote", "add", "upstream", upstream);
  git(mine, "fetch", "-q", "upstream");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-join-"));
  upstream = path.join(root, "upstream");
  mine = path.join(root, "mine");
  createUpstream();
  createMine();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("joins the history of TiddlyGit, the merge being left to review", () => {
  const result = join("upstream/master");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(exists(mine, ".git/MERGE_HEAD"), "the merge is in progress");

  git(mine, "commit", "-q", "--no-edit");
  assert.equal(git(mine, "merge-base", "HEAD", "upstream/master").trim(), git(mine, "rev-parse", "upstream/master").trim());
});

test("takes the TiddlyGit files from upstream and removes the ones it deleted", () => {
  assert.equal(join("upstream/master").status, 0);

  assert.equal(read(mine, "run.sh"), "new run");
  assert.equal(read(mine, "tiddlygit-plugin/plugin.info"), "{}");
  assert.equal(read(mine, "tiddly-merge.py"), read(upstream, "tiddly-merge.py"));
  assert.equal(exists(mine, "modified_tiddlers/Bob.js"), false);
  const gitlinks = git(mine, "ls-files", "-s", "plugins_repositories");
  assert.doesNotMatch(gitlinks, /TW5-Bob/);
  assert.match(gitlinks, /tw5-relink/);
  assert.equal(read(mine, "my-script.sh"), "# my own script", "my own files are kept");
});

test("keeps the files deleted from TiddlyGit that I modified", () => {
  const result = join("upstream/master");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.match(read(mine, "tiddlers/PersonalConfiguration.tid"), /current-user: Me/);
  assert.notEqual(git(mine, "ls-files", "tiddlers/PersonalConfiguration.tid"), "");
  assert.match(result.stdout, /tiddlers\/PersonalConfiguration\.tid/);
});

test("keeps my wiki and adds the tiddlers TiddlyGit needs", () => {
  const result = join("upstream/master");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.equal(exists(mine, "Wikis"), false);
  assert.equal(read(mine, "wiki/tiddlywiki.info"), '{"description": "My wiki", "plugins": ["tiddlywiki/katex"]}');
  assert.equal(read(mine, "wiki/tiddlers/My tiddler.tid"), "title: My tiddler\n\nmine");
  assert.equal(read(mine, "wiki/tiddlers/$__config_Local.tid"), "title: $:/config/Local\n\nlocal");
  assert.equal(read(mine, "wiki/tiddlers/SynchronizeButton.tid"),
    "tags: $:/tags/PageControls Méta\ntitle: SynchronizeButton\n\n<<tiddlygit-synchronize-actions>>");
  assert.equal(read(mine, "wiki/tiddlers/SynchronizeButtonImage.tid"), "title: SynchronizeButtonImage\n\n<svg/>");
  assert.equal(read(mine, "wiki/tiddlers/GitConflict.tid"), "title: GitConflict\n\nList of conflicts");
  assert.equal(exists(mine, "wiki/tiddlers/What is this_.tid"), false, "the example tiddlers are not added");
});

test("merges .gitignore", () => {
  assert.equal(join("upstream/master").status, 0);

  const lines = read(mine, ".gitignore").split("\n");
  for (const line of ["node_modules", "wiki/plugins", "wiki/tiddlers/$__config*", "wiki/tiddlers/$__StoryList.tid", "my-notes.txt"]) {
    assert.ok(lines.includes(line), `${line} is missing`);
  }
  assert.equal(new Set(lines.filter((line) => line)).size, lines.filter((line) => line).length, "no duplicated line");
});

test("later updates are normal merges", () => {
  assert.equal(join("upstream/master").status, 0);
  git(mine, "commit", "-q", "--no-edit");

  write(upstream, "run.sh", "newer run");
  write(upstream, "wiki/tiddlers/SynchronizeButtonImage.tid", "title: SynchronizeButtonImage\n\n<svg new/>");
  commitAll(upstream, "Update");
  git(mine, "fetch", "-q", "upstream");
  git(mine, "merge", "-q", "--no-edit", "upstream/master");

  assert.equal(read(mine, "run.sh"), "newer run");
  assert.equal(read(mine, "wiki/tiddlers/SynchronizeButtonImage.tid"), "title: SynchronizeButtonImage\n\n<svg new/>");
  assert.equal(read(mine, "wiki/tiddlers/My tiddler.tid"), "title: My tiddler\n\nmine");
});

test("refuses to run with uncommitted changes", () => {
  write(mine, "Wikis/BobWiki/tiddlers/My tiddler.tid", "title: My tiddler\n\nchanged");
  const result = join("upstream/master");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted/);
  assert.equal(exists(mine, "wiki"), false);
});

test("does nothing when the histories are already joined", () => {
  assert.equal(join("upstream/master").status, 0);
  git(mine, "commit", "-q", "--no-edit");
  const head = git(mine, "rev-parse", "HEAD");

  const result = join("upstream/master");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already/i);
  assert.equal(git(mine, "rev-parse", "HEAD"), head);
});
