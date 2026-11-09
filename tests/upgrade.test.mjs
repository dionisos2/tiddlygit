// Tests of upgrade.sh, with a wiki repository cloned from a TiddlyGit
// repository (its "upstream" remote). update.sh and kill_tiddlygit.sh are
// replaced by scripts leaving a trace.
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

let root, seed, wiki;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const writeIn = (dir, name, content, mode = 0o644) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, { mode });
};
const exists = (name) => fs.existsSync(path.join(wiki, name));
const readWiki = (name) => fs.readFileSync(path.join(wiki, name), "utf8");

// A new version of TiddlyGit
function publish(files, message = "New version") {
  for (const [name, content] of Object.entries(files)) writeIn(seed, name, content, 0o755);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", message);
  git(seed, "push", "-q", "origin", "master");
}

function upgrade(answer) {
  return spawnSync("./upgrade.sh", [], { cwd: wiki, input: answer, encoding: "utf8" });
}

const output = (result) => result.stdout + result.stderr;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-upgrade-"));
  seed = path.join(root, "seed");
  wiki = path.join(root, "wiki");
  git(root, "init", "-q", "--bare", "-b", "master", "tiddlygit.git");
  git(root, "clone", "-q", "tiddlygit.git", "seed");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  for (const name of ["upgrade.sh", "tiddly-merge.py", ".gitattributes"]) {
    fs.copyFileSync(path.join(repoRoot, name), path.join(seed, name));
  }
  publish({
    "update.sh": "#!/usr/bin/env bash\necho v1 > updated\n",
    "kill_tiddlygit.sh": "#!/usr/bin/env bash\ntouch killed\n",
    "wiki/tiddlers/Note.tid": "title: Note\n\nfirst version",
  }, "TiddlyGit");
  git(root, "clone", "-q", "-o", "upstream", "tiddlygit.git", "wiki");
  git(wiki, "config", "user.name", "Wiki");
  git(wiki, "config", "user.email", "wiki@example.com");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("the server is stopped, TiddlyGit merged, then the new update.sh run", () => {
  publish({ "update.sh": "#!/usr/bin/env bash\necho v2 > updated\n" });
  const result = upgrade("y\n");
  assert.equal(result.status, 0, output(result));
  assert.ok(exists("killed"), "the server was not stopped");
  assert.equal(readWiki("updated"), "v2\n", "the new update.sh was not run");
  assert.equal(git(wiki, "rev-parse", "HEAD"), git(wiki, "rev-parse", "upstream/master"));
  assert.match(output(result), /restart the server/i);
});

test("nothing is done when stopping the server is refused", () => {
  publish({ "update.sh": "#!/usr/bin/env bash\necho v2 > updated\n" });
  const before = git(wiki, "rev-parse", "HEAD");
  for (const answer of ["n\n", ""]) {
    const result = upgrade(answer);
    assert.notEqual(result.status, 0, output(result));
    assert.ok(!exists("killed") && !exists("updated"), output(result));
    assert.equal(git(wiki, "rev-parse", "HEAD"), before);
  }
});

test("uncommitted changes stop the upgrade before stopping the server", () => {
  writeIn(wiki, "wiki/tiddlers/Note.tid", "title: Note\n\nnot committed");
  const result = upgrade("y\n");
  assert.notEqual(result.status, 0);
  assert.match(output(result), /uncommitted/);
  assert.ok(!exists("killed"), "the server was stopped");
});

test("a merge that fails stops the upgrade before update.sh", () => {
  // A file git cannot merge (not a tiddler), changed on both sides
  writeIn(wiki, "notes.txt", "ours\n");
  git(wiki, "add", "-A");
  git(wiki, "commit", "-q", "-m", "Ours");
  publish({ "notes.txt": "theirs\n", "update.sh": "#!/usr/bin/env bash\necho v2 > updated\n" });
  // Our notes.txt did not exist in the common version: add/add conflict
  const result = upgrade("y\n");
  assert.notEqual(result.status, 0, output(result));
  assert.ok(!exists("updated"), "update.sh was run");
  assert.match(output(result), /merge/i);
});

test("the upgrade works when the merge changes upgrade.sh itself", () => {
  // Bash reads a script while running it: new lines at the beginning would shift the rest
  const current = fs.readFileSync(path.join(seed, "upgrade.sh"), "utf8");
  const [shebang, ...rest] = current.split("\n");
  publish({
    "upgrade.sh": [shebang, ...Array(50).fill("# A comment added by a new version of TiddlyGit"), ...rest].join("\n"),
    "update.sh": "#!/usr/bin/env bash\necho v2 > updated\n",
  });
  const result = upgrade("y\n");
  assert.equal(result.status, 0, output(result));
  assert.equal(readWiki("updated"), "v2\n");
  assert.match(output(result), /restart the server/i);
});

test("without an upstream remote, the merge is skipped", () => {
  git(wiki, "remote", "rename", "upstream", "origin");
  const result = upgrade("y\n");
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /upstream/);
  assert.equal(readWiki("updated"), "v1\n");
});

test("pushing to the upstream remote is disabled, fetching still works", () => {
  const result = upgrade("y\n");
  assert.equal(result.status, 0, output(result));
  writeIn(wiki, "wiki/tiddlers/Private.tid", "title: Private\n\nmy notes");
  git(wiki, "add", "-A");
  git(wiki, "commit", "-q", "-m", "Private");
  const before = git(root, "--git-dir=tiddlygit.git", "rev-parse", "master");
  const push = spawnSync("git", ["push", "upstream", "HEAD:master"], { cwd: wiki, encoding: "utf8" });
  assert.notEqual(push.status, 0, "the push to upstream succeeded");
  assert.equal(git(root, "--git-dir=tiddlygit.git", "rev-parse", "master"), before);
  assert.equal(git(wiki, "remote", "get-url", "upstream"), path.join(root, "tiddlygit.git") + "\n");
});

test("pushing to upstream is disabled even when the merge fails", () => {
  writeIn(wiki, "notes.txt", "ours\n");
  git(wiki, "add", "-A");
  git(wiki, "commit", "-q", "-m", "Ours");
  publish({ "notes.txt": "theirs\n" });
  const result = upgrade("y\n");
  assert.notEqual(result.status, 0, output(result));
  assert.equal(git(wiki, "remote", "get-url", "--push", "upstream"), "no_push\n");
});
