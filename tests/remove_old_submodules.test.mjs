// Tests of remove_old_submodules.sh, with a wiki repository cloned from a
// TiddlyGit repository using a submodule, which TiddlyGit then removes (like
// TW5-Bob).
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
const OLD = "plugins_repositories/Old";
const KEPT = "plugins_repositories/Kept";

let root, seed, wiki;

// Local repositories as submodule urls
const allowFile = ["-c", "protocol.file.allow=always"];
function git(cwd, ...args) {
  return execFileSync("git", [...allowFile, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const exists = (name) => fs.existsSync(path.join(wiki, name));
const gitlinks = (ref) => git(wiki, "ls-tree", "-r", ref).split("\n").filter((line) => line.startsWith("160000"))
  .map((line) => line.split("\t")[1]);
const indexGitlinks = () => git(wiki, "ls-files", "-s").split("\n").filter((line) => line.startsWith("160000"))
  .map((line) => line.split("\t")[1]);

function removeOldSubmodules() {
  return spawnSync("./remove_old_submodules.sh", [], { cwd: wiki, encoding: "utf8" });
}
const output = (result) => result.stdout + result.stderr;

function makeLib(name) {
  const lib = path.join(root, name);
  git(root, "init", "-q", "-b", "main", name);
  git(lib, "-c", "user.name=Lib", "-c", "user.email=lib@example.com", "commit", "-q", "--allow-empty", "-m", "1");
  return lib;
}

// TiddlyGit removes the Old submodule, the wiki merges it: git leaves the
// directory of the submodule, it cannot remove its .git file
function removeOldFromTiddlyGit() {
  git(seed, "rm", "-q", OLD);
  git(seed, "commit", "-q", "-m", "Remove Old");
  git(seed, "push", "-q", "origin", "master");
  git(wiki, "pull", "-q", "--no-rebase");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-old-submodules-"));
  seed = path.join(root, "seed");
  wiki = path.join(root, "wiki");
  git(root, "init", "-q", "--bare", "-b", "master", "tiddlygit.git");
  git(root, "clone", "-q", "tiddlygit.git", "seed");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "user.email", "seed@example.com");
  fs.copyFileSync(path.join(repoRoot, "remove_old_submodules.sh"), path.join(seed, "remove_old_submodules.sh"));
  git(seed, "submodule", "add", "-q", makeLib("old"), OLD);
  git(seed, "submodule", "add", "-q", makeLib("kept"), KEPT);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "TiddlyGit");
  git(seed, "push", "-q", "origin", "master");
  git(root, "clone", "-q", "--recurse-submodules", "tiddlygit.git", "wiki");
  git(wiki, "config", "user.name", "Wiki");
  git(wiki, "config", "user.email", "wiki@example.com");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("the directory left by a submodule removed from TiddlyGit is deleted", () => {
  removeOldFromTiddlyGit();
  assert.ok(exists(`${OLD}/.git`), "git removed the directory itself, the test is useless");

  const result = removeOldSubmodules();
  assert.equal(result.status, 0, output(result));
  assert.equal(exists(OLD), false);
  git(wiki, "add", "--all");
  assert.deepEqual(indexGitlinks(), [KEPT]);
  assert.ok(exists(`${KEPT}/.git`), "a submodule of TiddlyGit was removed");
});

// The state of a wiki synchronized after such a merge: "git add --all" added
// the directory back, without url in .gitmodules
test("a submodule committed without url in .gitmodules is removed and the removal committed", () => {
  removeOldFromTiddlyGit();
  git(wiki, "add", "--all");
  git(wiki, "commit", "-q", "-m", "Synchronize with script");
  assert.deepEqual(gitlinks("HEAD"), [KEPT, OLD]);

  const result = removeOldSubmodules();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(gitlinks("HEAD"), [KEPT]);
  assert.equal(git(wiki, "status", "--porcelain"), "");
  assert.equal(exists(OLD), false);
});

test("a directory with uncommitted changes is kept, but ignored", () => {
  removeOldFromTiddlyGit();
  fs.writeFileSync(path.join(wiki, OLD, "work.txt"), "not committed");

  const result = removeOldSubmodules();
  assert.equal(result.status, 0, output(result));
  assert.ok(exists(`${OLD}/work.txt`));
  assert.match(output(result), new RegExp(OLD));
  git(wiki, "add", "--all");
  assert.deepEqual(indexGitlinks(), [KEPT]);
});

test("a repository inside the directory (not in .git/modules) is kept, but ignored", () => {
  removeOldFromTiddlyGit();
  fs.rmSync(path.join(wiki, OLD), { recursive: true, force: true });
  git(wiki, "clone", "-q", path.join(root, "old"), OLD);

  const result = removeOldSubmodules();
  assert.equal(result.status, 0, output(result));
  assert.ok(exists(`${OLD}/.git`));
  git(wiki, "add", "--all");
  assert.deepEqual(indexGitlinks(), [KEPT]);
});

test("nothing changes when every submodule is in .gitmodules", () => {
  const head = git(wiki, "rev-parse", "HEAD");
  const result = removeOldSubmodules();
  assert.equal(result.status, 0, output(result));
  assert.equal(git(wiki, "rev-parse", "HEAD"), head);
  assert.equal(git(wiki, "status", "--porcelain"), "");
  assert.ok(exists(`${OLD}/.git`));
});

test("nothing changes in a repository without submodules", () => {
  git(wiki, "rm", "-q", "-r", "plugins_repositories", ".gitmodules");
  git(wiki, "commit", "-q", "-m", "No submodules");
  fs.rmSync(path.join(wiki, "plugins_repositories"), { recursive: true, force: true });
  const head = git(wiki, "rev-parse", "HEAD");
  const result = removeOldSubmodules();
  assert.equal(result.status, 0, output(result));
  assert.equal(git(wiki, "rev-parse", "HEAD"), head);
});
