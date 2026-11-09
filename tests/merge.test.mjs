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
// side and modified as .tid on the other is a modify/delete conflict for git,
// like a tiddler modified on one side and deleted or renamed on the other.
function resolveConflicts() {
  return spawnSync(driver, ["--resolve-conflicts"], { cwd: repo, encoding: "utf8" });
}

const unmergedFiles = () => git("diff", "--name-only", "--diff-filter=U").trim();

test("resolve: a .tid saved as .json on our side and modified on theirs is merged", () => {
  const merge = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": null, "Planning.json": jsonTiddler(planning({ "nouvelle-tache": "Ours ", "current-user": "Ours" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Theirs" })) },
  );
  assert.notEqual(merge.status, 0, "git alone cannot merge it");

  const result = resolveConflicts();
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

  const result = resolveConflicts();
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

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.match(JSON.parse(read("Planning.json"))[0].text, /^ours text\n\nCONFLICT/);
  const copies = conflictFiles().filter((name) => name !== "Planning.json");
  assert.equal(copies.length, 1);
  assert.match(read(copies[0]), /theirs text/);
});

test("resolve: a tiddler modified on their side and deleted on ours is kept, with a conflict note", () => {
  const merge = mergeScenario(
    { "Other.tid": tidTiddler({ title: "Other", tags: "Racine", text: "x" }) },
    { "Other.tid": null },
    { "Other.tid": tidTiddler({ title: "Other", tags: "Racine", text: "y" }) },
  );
  assert.notEqual(merge.status, 0, "git alone cannot merge it");

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.equal(read("Other.tid"), tidTiddler({ title: "Other", tags: "Racine GitConflict", text: "y\n\nCONFLICT : deleted by Test, but modified by Test" }));
  git("commit", "-q", "--no-edit");
  assert.equal(git("status", "--porcelain"), "");
});

test("resolve: a tiddler modified on our side and deleted on theirs is kept, with a conflict note", () => {
  mergeScenario(
    { "Other.json": jsonTiddler({ title: "Other", text: "x" }) },
    { "Other.json": jsonTiddler({ title: "Other", text: "y", field: " spaces " }) },
    { "Other.json": null },
  );

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.deepEqual(JSON.parse(read("Other.json")),
    [{ title: "Other", text: "y\n\nCONFLICT : deleted by Test, but modified by Test", field: " spaces ", tags: "GitConflict" }]);
});

test("resolve: a tiddler renamed on one side and deleted on the other is kept", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  mergeScenario(
    { "Old.tid": tidTiddler({ title: "Old", text }) },
    { "Old.tid": null, "New.tid": tidTiddler({ title: "New", text }) },
    { "Old.tid": null },
  );

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.match(read("New.tid"), /^title: New$/m);
  assert.equal(fs.existsSync(path.join(tiddlersDir(), "Old.tid")), false);
});

test("resolve: a tiddler renamed differently on both sides is a conflict on its title", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  mergeScenario(
    { "Old.tid": tidTiddler({ title: "Old", text }) },
    { "Old.tid": null, "Ours.tid": tidTiddler({ title: "Ours", text }) },
    { "Old.tid": null, "Theirs.tid": tidTiddler({ title: "Theirs", text }) },
  );

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.equal(fs.existsSync(path.join(tiddlersDir(), "Theirs.tid")), false, "git copies the merged tiddler in both files");
  assert.match(read("Ours.tid"), /^title: Ours$/m);
  const copies = conflictFiles().filter((name) => name !== "Ours.tid");
  assert.equal(copies.length, 1);
  assert.match(read(copies[0]), /^title: Theirs.+$/m);
});

test("resolve: a binary tiddler changed on both sides keeps ours and saves theirs as a conflict tiddler", () => {
  const meta = "title: Image\ntype: image/png\n";
  const merge = mergeScenario(
    { "Image.png": Buffer.from([0, 1, 2, 0]), "Image.png.meta": meta },
    { "Image.png": Buffer.from([0, 1, 3, 0]) },
    { "Image.png": Buffer.from([0, 1, 4, 0]) },
  );
  assert.notEqual(merge.status, 0, "git alone cannot merge it");

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(unmergedFiles(), "");
  assert.deepEqual([...fs.readFileSync(path.join(tiddlersDir(), "Image.png"))], [0, 1, 3, 0]);
  const copies = fs.readdirSync(tiddlersDir()).filter((name) => !name.startsWith("Image.png"));
  assert.equal(copies.length, 2, copies.join(", "));
  const copy = copies.find((name) => name.endsWith(".png"));
  assert.deepEqual([...fs.readFileSync(path.join(tiddlersDir(), copy))], [0, 1, 4, 0]);
  const copyMeta = read(copy + ".meta");
  assert.match(copyMeta, /^title: Image.+$/m);
  assert.match(copyMeta, /^tags: GitConflict$/m);
  assert.match(copyMeta, /^type: image\/png$/m);
});

test("resolve: a conflict on a file that is not a tiddler is left unresolved", () => {
  const merge = mergeScenario(
    { "../notes.txt": "base\n" },
    { "../notes.txt": "ours\n" },
    { "../notes.txt": "theirs\n" },
  );
  assert.notEqual(merge.status, 0);

  const result = resolveConflicts();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Unresolved conflict: wiki\/notes.txt/);
});

test("resolve: a tiddler file whose name has accents is resolved", () => {
  mergeScenario(
    { "Tâche.tid": tidTiddler({ title: "Tâche", text: "x" }) },
    { "Tâche.tid": null, "Tâche.json": jsonTiddler({ title: "Tâche", text: "x", field: " a " }) },
    { "Tâche.tid": tidTiddler({ title: "Tâche", text: "y" }) },
  );

  const result = resolveConflicts();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(read("Tâche.json")), [{ title: "Tâche", text: "y", field: " a " }]);
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

// An array of objects without a title is a data tiddler (its title is in the .meta
// file), not a tiddler file: TiddlyWiki requires a title.
test("json: an array without title changed on both sides is merged as other json files", () => {
  const meta = "title: Data\ntype: application/json\n";
  const result = mergeScenario(
    { "data.json": JSON.stringify([{ a: "base" }]), "data.json.meta": meta },
    { "data.json": JSON.stringify([{ a: "ours" }]) },
    { "data.json": JSON.stringify([{ a: "theirs" }]) },
  );
  assert.notEqual(result.status, 0, "the conflict must be reported to git");
  assert.doesNotMatch(result.stdout + result.stderr, /Traceback/);
  assert.match(read("data.json"), /<<<<<<<[^]*"ours"[^]*"theirs"/);
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

// --- Title lists (tags, list) ---------------------------------------------------

test("tid: tags added and removed on both sides are merged", () => {
  const result = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Bookmark Racine" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Bookmark Racine [[Ours tag]]" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Racine Theirs" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.tid"), tidTiddler(tidPlanning({ tags: "Racine Theirs [[Ours tag]]" })));
  assert.deepEqual(conflictFiles(), []);
});

test("json: the elements added to a list field are inserted after the element preceding them", () => {
  const result = mergeScenario(
    { "Planning.json": jsonTiddler(planning({ list: "A [[B b]] C" })) },
    { "Planning.json": jsonTiddler(planning({ list: "A [[B b]] C D" })) },
    { "Planning.json": jsonTiddler(planning({ list: "X A [[B b]] Y C" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.json"), jsonTiddler(planning({ list: "X A [[B b]] Y C D" })));
  assert.deepEqual(conflictFiles(), []);
});

test("tid: tags added on one side to a tiddler whose tags were removed on the other are kept", () => {
  const { tags, ...untagged } = tidPlanning();
  const result = mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Bookmark" })) },
    { "Planning.tid": tidTiddler(untagged) },
    { "Planning.tid": tidTiddler(tidPlanning({ tags: "Bookmark Theirs" })) },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read("Planning.tid"), tidTiddler(tidPlanning({ tags: "Theirs" })));
  assert.deepEqual(conflictFiles(), []);
});

test("the same conflict always gives the same conflict tiddler name", () => {
  const merge = () => spawnSync("git", ["merge", "--no-edit", "theirs"], { cwd: repo, encoding: "utf8" });
  mergeScenario(
    { "Planning.tid": tidTiddler(tidPlanning()) },
    { "Planning.tid": tidTiddler(tidPlanning({ text: "ours text" })) },
    { "Planning.tid": tidTiddler(tidPlanning({ text: "theirs text" })) },
  );
  const first = conflictFiles().filter((name) => name !== "Planning.tid");
  assert.equal(first.length, 1);
  assert.match(first[0], /^PlanningDionisos-[0-9a-f]{8}\.tid$/);

  git("reset", "-q", "--hard", "HEAD^");
  git("clean", "-q", "-f");
  merge();
  assert.deepEqual(conflictFiles().filter((name) => name !== "Planning.tid"), first);
});
