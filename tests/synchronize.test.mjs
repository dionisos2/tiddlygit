// Tests of synchronize.sh, with two clones of a local remote repository.
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

let root;
let env;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const file = (clone, name) => path.join(root, clone, "wiki/tiddlers", name);
const read = (clone, name) => fs.readFileSync(file(clone, name), "utf8");
const write = (clone, name, content) => fs.writeFileSync(file(clone, name), content);

function synchronize(clone) {
  return spawnSync("./synchronize.sh", [], { cwd: path.join(root, clone), env, encoding: "utf8" });
}

const tid = (fields) => {
  const { text, ...header } = fields;
  return Object.keys(header).sort().map((name) => `${name}: ${header[name]}`).join("\n") + (text ? "\n\n" + text : "");
};
const json = (fields) => JSON.stringify([fields], null, 4);
const planning = (extra = {}) => ({ title: "PlanningDionisos", "current-user": "Dionisos", tags: "Racine", text: "{{||TemplatePlanning}}", ...extra });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-sync-"));
  // notify-send may not be available
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin/notify-send"), "#!/bin/sh\n", { mode: 0o755 });
  env = { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}` };

  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "seed");
  const seed = path.join(root, "seed");
  for (const name of ["synchronize.sh", "remove_old_submodules.sh", "tiddly-merge.py", ".gitattributes"]) {
    fs.copyFileSync(path.join(repoRoot, name), path.join(seed, name));
  }
  fs.mkdirSync(path.join(seed, "wiki/tiddlers"), { recursive: true });
  write("seed", "PlanningDionisos.tid", tid(planning()));
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "Seed");
  git(seed, "push", "-q", "origin", "main");
  for (const clone of ["alice", "bob"]) {
    git(root, "clone", "-q", "origin.git", clone);
    git(path.join(root, clone), "config", "user.name", clone);
    git(path.join(root, clone), "config", "user.email", `${clone}@example.com`);
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("a tiddler saved as .json by one and modified as .tid by the other is merged", () => {
  fs.rmSync(file("alice", "PlanningDionisos.tid"));
  write("alice", "PlanningDionisos.json", json(planning({ "nouvelle-tache": "Acheter " })));
  let result = synchronize("alice");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  write("bob", "PlanningDionisos.tid", tid(planning({ "current-user": "Bob" })));
  result = synchronize("bob");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.equal(fs.existsSync(file("bob", "PlanningDionisos.tid")), false);
  assert.deepEqual(JSON.parse(read("bob", "PlanningDionisos.json")),
    [planning({ "current-user": "Bob", "nouvelle-tache": "Acheter " })]);
  assert.equal(git(path.join(root, "bob"), "status", "--porcelain"), "");
  assert.equal(git(path.join(root, "bob"), "rev-parse", "HEAD"), git(path.join(root, "bob"), "rev-parse", "origin/main"),
    "the merge was pushed");
});

test("a tiddler saved as .json by both is merged with the .tid as common version", () => {
  fs.rmSync(file("alice", "PlanningDionisos.tid"));
  write("alice", "PlanningDionisos.json", json(planning({ "nouvelle-tache": "Acheter ", tags: "Alice" })));
  assert.equal(synchronize("alice").status, 0);

  fs.rmSync(file("bob", "PlanningDionisos.tid"));
  write("bob", "PlanningDionisos.json", json(planning({ "nouvelle-tache": "Vendre ", "current-user": "Bob" })));
  const result = synchronize("bob");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.deepEqual(JSON.parse(read("bob", "PlanningDionisos.json")),
    [planning({ "nouvelle-tache": "Vendre ", "current-user": "Bob", tags: "Alice" })]);
  assert.deepEqual(fs.readdirSync(path.join(root, "bob/wiki/tiddlers")), ["PlanningDionisos.json"]);
});

test("a tiddler deleted by one and modified by the other is kept", () => {
  fs.rmSync(file("alice", "PlanningDionisos.tid"));
  assert.equal(synchronize("alice").status, 0);

  write("bob", "PlanningDionisos.tid", tid(planning({ "current-user": "Bob" })));
  const result = synchronize("bob");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(read("bob", "PlanningDionisos.tid"), /CONFLICT : deleted by alice, but modified by bob/);
  assert.equal(git(path.join(root, "bob"), "status", "--porcelain"), "");
});

test("a conflict that cannot be resolved cancels the merge and makes the synchronization fail", () => {
  const notes = (clone) => path.join(root, clone, "wiki/notes.txt");
  fs.writeFileSync(notes("alice"), "alice\n");
  assert.equal(synchronize("alice").status, 0);

  write("alice", "PlanningDionisos.tid", tid(planning({ text: "alice text" })));
  assert.equal(synchronize("alice").status, 0);

  fs.writeFileSync(notes("bob"), "bob\n");
  write("bob", "PlanningDionisos.tid", tid(planning({ text: "bob text" })));
  const bob = path.join(root, "bob");
  const result = synchronize("bob");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /wiki\/notes.txt/, "the conflicting file is reported");
  assert.equal(fs.readFileSync(notes("bob"), "utf8"), "bob\n", "no conflict marker is left");
  assert.equal(fs.existsSync(path.join(bob, ".git/MERGE_HEAD")), false, "the merge is cancelled");
  assert.equal(git(bob, "status", "--porcelain", "--untracked-files=all"), "", "the conflict tiddlers of the cancelled merge are removed");
  assert.equal(read("bob", "PlanningDionisos.tid"), tid(planning({ text: "bob text" })));
});

test("the changes that cannot be committed stop the synchronization before merging, and are kept", () => {
  const notes = (clone) => path.join(root, clone, "wiki/notes.txt");
  fs.writeFileSync(notes("alice"), "alice\n");
  assert.equal(synchronize("alice").status, 0);

  // A file git cannot read makes "git add" fail, nothing is committed
  fs.writeFileSync(notes("bob"), "bob\n");
  write("bob", "NewTiddler.tid", tid({ title: "NewTiddler", text: "not committed yet" }));
  write("bob", "Unreadable.tid", tid({ title: "Unreadable" }));
  fs.chmodSync(file("bob", "Unreadable.tid"), 0o000);
  const result = synchronize("bob");
  assert.equal(fs.existsSync(file("bob", "Unreadable.tid")), true, "the files not committed are kept");
  fs.chmodSync(file("bob", "Unreadable.tid"), 0o644);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Synchronization failed: git add/);
  assert.equal(read("bob", "NewTiddler.tid"), tid({ title: "NewTiddler", text: "not committed yet" }));
  assert.equal(fs.readFileSync(notes("bob"), "utf8"), "bob\n");
});

test("a commit refused by a hook stops the synchronization before merging", () => {
  fs.writeFileSync(path.join(root, "bob/.git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  write("bob", "PlanningDionisos.tid", tid(planning({ "current-user": "Bob" })));
  const result = synchronize("bob");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Synchronization failed: git commit/);
});

test("the result of the synchronization does not depend on notify-send", () => {
  fs.writeFileSync(path.join(root, "bin/notify-send"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  write("alice", "PlanningDionisos.tid", tid(planning({ "current-user": "Alice" })));
  const result = synchronize("alice");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a push refused by the remote makes the synchronization fail", () => {
  fs.writeFileSync(path.join(root, "origin.git/hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  write("alice", "PlanningDionisos.tid", tid(planning({ "current-user": "Alice" })));
  const result = synchronize("alice");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

// Each wiki may use other versions of the plugins (update.sh takes their latest
// version): the submodules moved to another commit are not committed.
test("a submodule moved to another commit is not committed", () => {
  const seed = path.join(root, "seed");
  const lib = path.join(root, "lib");
  // The first submodule of TiddlyGit, with a local repository as its url
  const [key, submodule] = git(repoRoot, "config", "-f", ".gitmodules", "--get-regexp", "\\.path$").split("\n")[0].split(" ");
  const name = key.replace(/^submodule\./, "").replace(/\.path$/, "");
  const commitLib = (message) => git(lib, "-c", "user.name=Lib", "-c", "user.email=lib@example.com", "commit", "-q", "--allow-empty", "-m", message);
  git(root, "init", "-q", "-b", "main", "lib");
  commitLib("1");
  const first = git(lib, "rev-parse", "HEAD").trim();

  fs.copyFileSync(path.join(repoRoot, ".gitmodules"), path.join(seed, ".gitmodules"));
  git(seed, "config", "-f", ".gitmodules", `submodule.${name}.url`, lib);
  git(seed, "clone", "-q", lib, submodule);
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "Add a plugin");
  git(seed, "push", "-q", "origin", "main");

  const alice = path.join(root, "alice");
  git(alice, "pull", "-q");
  commitLib("2");
  git(alice, "clone", "-q", lib, submodule);
  write("alice", "PlanningDionisos.tid", tid(planning({ "current-user": "Alice" })));
  const result = synchronize("alice");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.match(read("alice", "PlanningDionisos.tid"), /Alice/);
  assert.equal(git(alice, "show", "origin/main:wiki/tiddlers/PlanningDionisos.tid").includes("Alice"), true);
  assert.equal(git(alice, "rev-parse", `origin/main:${submodule}`).trim(), first);
});

// A merge removing a submodule leaves its directory (git cannot remove its .git
// file): the next synchronization must not add it back without url in
// .gitmodules ("No url found for submodule path" in update.sh)
test("a submodule removed by the merge is not added back", () => {
  const seed = path.join(root, "seed");
  const alice = path.join(root, "alice");
  const lib = path.join(root, "lib");
  const submodule = "plugins_repositories/Old";
  const allowFile = ["-c", "protocol.file.allow=always"];
  git(root, "init", "-q", "-b", "main", "lib");
  git(lib, "-c", "user.name=Lib", "-c", "user.email=lib@example.com", "commit", "-q", "--allow-empty", "-m", "1");
  const commitSeed = (message) => {
    git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", message);
    git(seed, "push", "-q", "origin", "main");
  };
  git(seed, ...allowFile, "submodule", "add", "-q", lib, submodule);
  commitSeed("Add a plugin");
  git(alice, "pull", "-q");
  git(alice, ...allowFile, "submodule", "update", "-q", "--init");

  git(seed, "rm", "-q", submodule);
  commitSeed("Remove the plugin");
  let result = synchronize("alice");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  write("alice", "PlanningDionisos.tid", tid(planning({ "current-user": "Alice" })));
  result = synchronize("alice");
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.equal(git(alice, "ls-tree", "origin/main", submodule), "");
  assert.equal(git(alice, "show", "origin/main:wiki/tiddlers/PlanningDionisos.tid").includes("Alice"), true);
});
