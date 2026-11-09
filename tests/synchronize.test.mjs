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
  for (const name of ["synchronize.sh", "tiddly-merge.py", ".gitattributes"]) {
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
