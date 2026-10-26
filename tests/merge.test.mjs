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
    for (const [name, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(tiddlersDir(), name));
      else write(name, content);
    }
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
  git("config", "merge.tiddly-merge.driver", `${driver} %O %A %B %P`);
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

// --- Tiddlers changing format ---------------------------------------------------
// TiddlyWiki saves a tiddler as .json when a field has leading or trailing spaces.

test("json: a .tid saved as .json on both sides is merged with the .tid as common version", () => {
  const result = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Ours ", "current-user": "Ours" })) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Theirs ", tags: "Theirs" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.json"), jsonTiddler(planning({ "nouvelle-tache": "Ours ", "current-user": "Ours", tags: "Theirs" })));
  assert.deepEqual(conflictFiles(), []);
});

// Run by synchronize.sh when git cannot merge: a tiddler saved as .json on one
// side and modified as .tid on the other is a modify/delete conflict for git.
function resolveFormatChanges() {
  return spawnSync(driver, ["--resolve-format-changes"], { cwd: repo, encoding: "utf8" });
}

const unmergedFiles = () => git("diff", "--name-only", "--diff-filter=U").trim();

test("resolve: a .tid saved as .json on our side and modified on theirs is merged", () => {
  const merge = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Ours ", "current-user": "Ours" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Theirs" })) },
  );
  assert.notEqual(merge.status, 0, "git alone cannot merge it");

  const result = resolveFormatChanges();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.equal(read("Planning.json"), jsonTiddler(planning({ "nouvelle-tache": "Ours ", "current-user": "Ours", tags: "Theirs" })));
  assert.equal(fs.existsSync(path.join(tiddlersDir(), "Planning.tid")), false);
  git("commit", "-q", "--no-edit");
  assert.equal(git("status", "--porcelain"), "");
});

test("resolve: a .tid modified on our side and saved as .json on theirs is merged as .json", () => {
  const merge = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Ours" })) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Theirs " })) },
  );
  assert.notEqual(merge.status, 0, "git alone cannot merge it");

  const result = resolveFormatChanges();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  // The field order of ours (the .tid file) is kept
  assert.deepEqual(JSON.parse(read("Planning.json")), [{ ...tidPlanning({ tags: "Ours" }), "nouvelle-tache": "Theirs " }]);
  assert.equal(fs.existsSync(path.join(tiddlersDir(), "Planning.tid")), false);
});

test("resolve: a conflict between the two formats creates a conflict tiddler", () => {
  mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Ours ", text: "ours text" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ text: "theirs text" })) },
  );

  const result = resolveFormatChanges();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.match(JSON.parse(read("Planning.json"))[0].text, /^ours text\n\nCONFLICT/);
  const copies = conflictFiles().filter((name) => name !== "Planning.json");
  assert.equal(copies.length, 1);
  assert.match(read(copies[0]), /theirs text/);
});

test("resolve: a real modify/delete conflict is left to the user", () => {
  const merge = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()), "Other.tid": tidTiddler({ title: "Other", text: "x" }) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Ours " })), "Other.tid": null },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Theirs" })), "Other.tid": tidTiddler({ title: "Other", text: "y" }) },
  );
  assert.notEqual(merge.status, 0);

  const result = resolveFormatChanges();
  assert.notEqual(result.status, 0);
  assert.equal(unmergedFiles(), "wiki/tiddlers/Other.tid");
  assert.match(read("Planning.json"), /Theirs/, "the format change is resolved anyway");
});

// --- Other .json files -------------------------------------------------------------

const plugin = (tiddlers, extra = {}) => ({ title: "$:/plugins/x", tiddlers, ...extra });
const pluginTiddlers = { a: { caption: "A", text: "a" }, b: { text: "b" } };

test("json: changes to different keys of other json files are merged, even on adjacent lines", () => {
  const result = mergeScenario(
    { "plugin.json": JSON.stringify(plugin(pluginTiddlers), null, 4) },
    { "plugin.json": JSON.stringify(plugin({ ...pluginTiddlers, a: { caption: "A, ours", text: "a" } }), null, 4) },
    { "plugin.json": JSON.stringify(plugin({ ...pluginTiddlers, a: { caption: "A", text: "a, theirs" }, d: { text: "d" } }), null, 4) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("plugin.json"),
    JSON.stringify(plugin({ a: { caption: "A, ours", text: "a, theirs" }, b: { text: "b" }, d: { text: "d" } }), null, 4));
});

test("json: strings changed on both sides are merged line by line", () => {
  const result = mergeScenario(
    { "data.json": JSON.stringify({ code: "line 1\nline 2\nline 3\nline 4" }) },
    { "data.json": JSON.stringify({ code: "line 1, ours\nline 2\nline 3\nline 4" }) },
    { "data.json": JSON.stringify({ code: "line 1\nline 2\nline 3\nline 4, theirs" }) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("data.json"), JSON.stringify({ code: "line 1, ours\nline 2\nline 3\nline 4, theirs" }));
});

test("json: the formatting of other json files is kept", () => {
  const base = { list: [1, 2], name: "x", other: "y" };
  const result = mergeScenario(
    { "data.json": JSON.stringify(base, null, "\t") + "\n" },
    { "data.json": JSON.stringify({ ...base, name: "ours" }, null, "\t") + "\n" },
    { "data.json": JSON.stringify({ ...base, other: "theirs" }, null, "\t") + "\n" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("data.json"), JSON.stringify({ ...base, name: "ours", other: "theirs" }, null, "\t") + "\n");
});

test("json: a value changed differently on both sides of other json files is a conflict", () => {
  const result = mergeScenario(
    { "data.json": JSON.stringify({ a: "base", b: "b" }, null, 2) },
    { "data.json": JSON.stringify({ a: "ours", b: "b" }, null, 2) },
    { "data.json": JSON.stringify({ a: "theirs", b: "b" }, null, 2) },
  );
  assert.notEqual(result.status, 0, "the conflict must be reported to git");
  assert.match(read("data.json"), /<<<<<<<[^]*"ours"[^]*"theirs"/);
});

test("json: arrays changed on both sides are merged element by element", () => {
  const result = mergeScenario(
    { "data.json": JSON.stringify({ list: [1, 2, 3] }) },
    { "data.json": JSON.stringify({ list: [0, 1, 2, 3] }) },
    { "data.json": JSON.stringify({ list: [1, 2, 3, { four: 4 }] }) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("data.json"), JSON.stringify({ list: [0, 1, 2, 3, { four: 4 }] }));
});

test("json: an array element changed differently on both sides is a conflict", () => {
  const result = mergeScenario(
    { "data.json": JSON.stringify({ list: [1, 2, 3] }) },
    { "data.json": JSON.stringify({ list: [1, "ours", 3] }) },
    { "data.json": JSON.stringify({ list: [1, "theirs", 3] }) },
  );
  assert.notEqual(result.status, 0, "the conflict must be reported to git");
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
