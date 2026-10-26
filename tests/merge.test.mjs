// Tests of the git merge driver for tiddler files (tiddly-merge.py), through
// real git merges.
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
const driver = path.join(repoRoot, "tiddly-merge.py");

let repo;

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const tiddlersDir = () => path.join(repo, "wiki/tiddlers");
const read = (name) => fs.readFileSync(path.join(tiddlersDir(), name), "utf8");
const write = (name, content) => fs.writeFileSync(path.join(tiddlersDir(), name), content);

// The way TiddlyWiki writes tiddler files
const jsonTiddler = (fields) => JSON.stringify([fields], null, 4);
function tidTiddler(fields) {
  const { text, ...header } = fields;
  const block = Object.keys(header).sort().map((name) => `${name}: ${header[name]}`).join("\n");
  return block + (text ? "\n\n" + text : "");
}

function conflictFiles() {
  return fs.readdirSync(tiddlersDir()).filter((name) => read(name).includes("GitConflict"));
}

// Commits `base`, then `theirs` on a branch and `ours` on the main branch, and
// merges the branch. Each argument maps file names to contents.
function mergeScenario(base, ours, theirs) {
  const commitAll = (files, message) => {
    for (const [name, content] of Object.entries(files)) write(name, content);
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  commitAll(base, "base");
  git("checkout", "-q", "-b", "theirs");
  commitAll(theirs, "theirs");
  git("checkout", "-q", "main");
  commitAll(ours, "ours");
  return spawnSync("git", ["merge", "--no-edit", "theirs"], { cwd: repo, encoding: "utf8" });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "tiddlygit-merge-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "merge.tiddly-merge.driver", `${driver} %O %A %B`);
  fs.copyFileSync(path.join(repoRoot, ".gitattributes"), path.join(repo, ".gitattributes"));
  fs.mkdirSync(tiddlersDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const planning = (extra = {}) => ({
  title: "PlanningDionisos",
  "current-user": "Dionisos",
  "days-count": "3",
  "nouvelle-tache": "Acheter ",
  tags: "Bookmark Racine",
  text: "first paragraph\n\nsecond paragraph\n\nthird paragraph",
  type: "text/vnd.tiddlywiki",
  ...extra,
});

// --- .json tiddlers ---------------------------------------------------------------

test("json: changes to different fields, even on adjacent lines, are merged", () => {
  const result = mergeScenario(
    { "Planning.json": jsonTiddler(planning()) },
    { "Planning.json": jsonTiddler(planning({ "days-count": "5" })) },
    { "Planning.json": jsonTiddler(planning({ "current-user": "Someone", tags: "Bookmark" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.json"), jsonTiddler(planning({ "current-user": "Someone", "days-count": "5", tags: "Bookmark" })));
  assert.deepEqual(conflictFiles(), []);
});

test("json: changes to different lines of the text are merged", () => {
  const result = mergeScenario(
    { "Planning.json": jsonTiddler(planning()) },
    { "Planning.json": jsonTiddler(planning({ text: "first paragraph, ours\n\nsecond paragraph\n\nthird paragraph" })) },
    { "Planning.json": jsonTiddler(planning({ text: "first paragraph\n\nsecond paragraph\n\nthird paragraph, theirs" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(read("Planning.json"))[0].text, "first paragraph, ours\n\nsecond paragraph\n\nthird paragraph, theirs");
  assert.deepEqual(conflictFiles(), []);
});

test("json: fields added or removed on one side are merged", () => {
  const { "nouvelle-tache": removed, ...withoutTask } = planning();
  const result = mergeScenario(
    { "Planning.json": jsonTiddler(planning()) },
    { "Planning.json": jsonTiddler(withoutTask) },
    { "Planning.json": jsonTiddler(planning({ caption: "My planning" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.json"), jsonTiddler({ ...withoutTask, caption: "My planning" }));
});

test("json: a field changed differently on both sides creates a conflict tiddler", () => {
  const result = mergeScenario(
    { "Planning.json": jsonTiddler(planning()) },
    { "Planning.json": jsonTiddler(planning({ "current-user": "Ours" })) },
    { "Planning.json": jsonTiddler(planning({ "current-user": "Theirs" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [ours] = JSON.parse(read("Planning.json"));
  assert.equal(ours["current-user"], "Ours");
  assert.match(ours.text, /CONFLICT : \[\[PlanningDionisos.+\]\]/);

  const copies = conflictFiles().filter((name) => name !== "Planning.json");
  assert.equal(copies.length, 1);
  const [theirs] = JSON.parse(read(copies[0]));
  assert.equal(theirs["current-user"], "Theirs");
  assert.match(theirs.title, /^PlanningDionisos.+/);
  assert.match(theirs.tags, /GitConflict/);
  assert.match(theirs.text, /CONFLICT : \[\[PlanningDionisos\]\]/);
});

test("json: unimportant fields changed on both sides keep our value", () => {
  const result = mergeScenario(
    { "Planning.json": jsonTiddler(planning({ modified: "20260101000000000" })) },
    { "Planning.json": jsonTiddler(planning({ modified: "20260102000000000", "nouvelle-tache": "Ours " })) },
    { "Planning.json": jsonTiddler(planning({ modified: "20260103000000000", "nouvelle-tache": "Theirs " })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.json"), jsonTiddler(planning({ modified: "20260102000000000", "nouvelle-tache": "Ours " })));
  assert.deepEqual(conflictFiles(), []);
});

test("json: other json files are merged line by line", () => {
  const base = JSON.stringify({ tiddlers: { a: { text: "a" }, b: { text: "b" }, c: { text: "c" } } }, null, 4);
  const result = mergeScenario(
    { "plugin.json": base },
    { "plugin.json": base.replace('"a"', '"a, ours"') },
    { "plugin.json": base.replace('"c"', '"c, theirs"') },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("plugin.json"), base.replace('"a"', '"a, ours"').replace('"c"', '"c, theirs"'));

  git("reset", "-q", "--hard", "HEAD~1");
  write("plugin.json", base.replace('"b"', '"b, ours"'));
  git("commit", "-q", "-am", "ours again");
  git("checkout", "-q", "theirs");
  write("plugin.json", base.replace('"b"', '"b, theirs"'));
  git("commit", "-q", "-am", "theirs again");
  git("checkout", "-q", "main");
  const conflicting = spawnSync("git", ["merge", "--no-edit", "theirs"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(conflicting.status, 0, "an overlapping change must be reported as a conflict");
});

// --- .tid tiddlers ----------------------------------------------------------------

const tidPlanning = (extra = {}) => {
  const { "nouvelle-tache": task, ...fields } = planning(extra);
  return { ...fields, "nouvelle-tache": task.trim() };
};

test("tid: changes to different fields are merged", () => {
  const result = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": tidTiddler(tidPlanning({ "days-count": "5" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ "current-user": "Someone" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.tid"), tidTiddler(tidPlanning({ "current-user": "Someone", "days-count": "5" })));
  assert.deepEqual(conflictFiles(), []);
});

test("tid: a field changed differently on both sides creates a conflict tiddler", () => {
  const result = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": tidTiddler(tidPlanning({ text: "ours text" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ text: "theirs text" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(read("Planning.tid"), /^ours text\n\nCONFLICT : \[\[PlanningDionisos.+\]\]/m);
  const copies = conflictFiles().filter((name) => name !== "Planning.tid");
  assert.equal(copies.length, 1);
  assert.match(copies[0], /\.tid$/);
  assert.match(read(copies[0]), /^tags: .*GitConflict/m);
  assert.match(read(copies[0]), /^theirs text\n\nCONFLICT : \[\[PlanningDionisos\]\]/m);
});
