// Tests of the synchronize button, on the browser side: while the
// synchronization runs, the page is blocked so that nothing typed is merged
// with a version of the tiddler that git is changing.
//
// Run with: node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { useTiddlyWiki, FakeServer, startSyncer, stopSyncer, typeIn, pluginModule, eventually, sleep, repoRoot } from "./browser-helpers.mjs";

const tw = useTiddlyWiki();
const STATE = "$:/temp/tiddlygit/synchronize";
const SERVER_STATE = "$:/temp/tiddlygit/server";

// A browser connected to a server, and the synchronization request it sends
async function setup() {
  const server = new FakeServer();
  server.set({ title: "Form", text: "a" });
  const { wiki, syncer } = startSyncer(tw(), server);
  await eventually(() => wiki.getTiddlerText("Form") === "a", "the tiddler was not loaded");
  const calls = { posts: [], blurs: 0, notifications: 0 };
  const synchronize = () => pluginModule("synchronize.js").synchronize({
    wiki,
    syncer,
    post: (callback) => calls.posts.push({ callback, unsavedChanges: syncer.isDirty() }),
    blur: () => calls.blurs++,
    notify: () => calls.notifications++,
  });
  const state = () => wiki.getTiddler(STATE)?.fields ?? {};
  return { server, wiki, syncer, calls, synchronize, state };
}

test("the page is blocked as soon as the synchronization starts", async () => {
  const { syncer, calls, synchronize, state } = await setup();
  try {
    synchronize();
    assert.equal(state().blocked, "yes");
    assert.equal(state().status, "running");
    assert.equal(calls.blurs, 1);
  } finally {
    stopSyncer(syncer);
  }
});

test("the synchronization starts once the browser changes are saved", async () => {
  const { server, wiki, syncer, calls, synchronize } = await setup();
  try {
    typeIn(tw(), wiki, "ab");
    await eventually(() => server.text("Form") === "ab", "the typed text was not saved");
    // Typed less than one second after the last save: not sent yet
    typeIn(tw(), wiki, "abc");
    synchronize();
    await sleep(100);
    assert.equal(calls.posts.length, 0);

    await eventually(() => calls.posts.length === 1, "the synchronization was not requested");
    assert.equal(server.text("Form"), "abc");
    assert.equal(calls.posts[0].unsavedChanges, false);
  } finally {
    stopSyncer(syncer);
  }
});

test("the page stays blocked until the tiddlers changed by git are loaded", async () => {
  const { server, wiki, syncer, calls, synchronize, state } = await setup();
  try {
    synchronize();
    await eventually(() => calls.posts.length === 1, "the synchronization was not requested");
    server.set({ title: "Form", text: "merged by git" });
    let textWhenUnblocked;
    wiki.addEventListener("change", (changes) => {
      if (changes[STATE] && state().blocked === "no" && textWhenUnblocked === undefined) {
        textWhenUnblocked = wiki.getTiddlerText("Form");
      }
    });
    calls.posts[0].callback(null, 200, { code: 0, output: "done" });
    assert.equal(state().blocked, "yes");

    await eventually(() => state().blocked === "no", "the page was not unblocked");
    assert.equal(textWhenUnblocked, "merged by git");
    assert.equal(state().status, "200");
    assert.equal(state().code, "0");
    assert.equal(state().text, "done");
    assert.equal(calls.notifications, 1);
  } finally {
    stopSyncer(syncer);
  }
});

test("the page is unblocked when the synchronization request fails", async () => {
  const { syncer, calls, synchronize, state } = await setup();
  try {
    synchronize();
    await eventually(() => calls.posts.length === 1, "the synchronization was not requested");
    calls.posts[0].callback("XMLHttpRequest error code: 500", 500, null);

    await eventually(() => state().blocked === "no", "the page was not unblocked");
    assert.equal(state().status, "500");
    assert.equal(calls.notifications, 1);
  } finally {
    stopSyncer(syncer);
  }
});

test("the page unblocked by hand is not blocked again at the end", async () => {
  const { wiki, syncer, calls, synchronize, state } = await setup();
  try {
    synchronize();
    await eventually(() => calls.posts.length === 1, "the synchronization was not requested");
    // The "unblock anyway" button
    wiki.addTiddler(new (tw().Tiddler)(wiki.getTiddler(STATE), { blocked: "no" }));
    calls.posts[0].callback(null, 200, { code: 0, output: "done" });

    await eventually(() => calls.notifications === 1, "the end was not notified");
    assert.equal(state().blocked, "no");
  } finally {
    stopSyncer(syncer);
  }
});

test("unblocking before the request is sent cancels the synchronization", async () => {
  const { server, wiki, syncer, calls, synchronize, state } = await setup();
  try {
    server.unreachable = true;
    typeIn(tw(), wiki, "ab");
    synchronize();
    await sleep(100);
    // The "unblock anyway" button
    wiki.addTiddler(new (tw().Tiddler)(wiki.getTiddler(STATE), { blocked: "no" }));
    await eventually(() => state().status === "cancelled", "the synchronization was not cancelled");
    assert.equal(calls.notifications, 1);

    server.reachable();
    await eventually(() => server.text("Form") === "ab", "the typed text was not saved");
    await sleep(200);
    assert.equal(calls.posts.length, 0);

    synchronize();
    await eventually(() => calls.posts.length === 1, "a new synchronization could not be started");
  } finally {
    stopSyncer(syncer);
  }
});

test("a second click during a synchronization does nothing", async () => {
  const { syncer, calls, synchronize } = await setup();
  try {
    synchronize();
    await eventually(() => calls.posts.length === 1, "the synchronization was not requested");
    synchronize();
    await sleep(200);
    assert.equal(calls.posts.length, 1);
    assert.equal(calls.blurs, 1);
  } finally {
    stopSyncer(syncer);
  }
});

// --- Page --------------------------------------------------------------------

// A wiki with the tiddlygit plugin, and a function rendering wikitext in it
function wikiWithPlugin() {
  const $tw = tw();
  const wiki = new $tw.Wiki();
  wiki.addTiddler($tw.loadPluginFolder(path.join(repoRoot, "tiddlygit-plugin")));
  wiki.readPluginInfo();
  wiki.registerPluginTiddlers("plugin");
  wiki.unpackPluginTiddlers();
  const messages = [];
  const { widget: Widget } = $tw.modules.execute("$:/core/modules/widgets/widget.js");
  const root = new Widget({}, { wiki, document: $tw.fakeDocument });
  root.addEventListener("tm-tiddlygit-synchronize", (event) => { messages.push(event); return false; });
  const render = (text) => {
    const widget = wiki.makeWidget(wiki.parseText("text/vnd.tiddlywiki", text), { parentWidget: root, document: $tw.fakeDocument });
    const container = $tw.fakeDocument.createElement("div");
    widget.render(container, null);
    return { widget, container };
  };
  return { wiki, render, messages };
}

function findButton(widget) {
  if (widget.parseTreeNode?.type === "button") return widget;
  for (const child of widget.children ?? []) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}

const OVERLAY = "$:/plugins/dionisos/tiddlygit/synchronize-overlay";

test("the synchronize button sends the synchronization message", async () => {
  const { render, messages } = wikiWithPlugin();
  const { widget } = render("\\import [[$:/plugins/dionisos/tiddlygit/synchronize-actions]]\n<$button><<tiddlygit-synchronize-actions>></$button>");
  findButton(widget).invokeActions(widget, {});
  assert.equal(messages.length, 1);
});

test("the page shows a blocking overlay while blocked", async () => {
  const { wiki, render } = wikiWithPlugin();
  assert.deepEqual(wiki.getTiddler(OVERLAY).fields.tags, ["$:/tags/PageTemplate"]);
  assert.equal(render(`{{${OVERLAY}}}`).container.textContent.trim(), "");

  wiki.addTiddler({ title: STATE, status: "running", blocked: "yes" });
  const { container } = render(`{{${OVERLAY}}}`);
  assert.match(container.innerHTML, /class="tiddlygit-overlay"/);
  assert.match(container.textContent, /Synchronization in progress/);
});

test("the notification tells the synchronization was cancelled", async () => {
  const { wiki, render } = wikiWithPlugin();
  wiki.addTiddler({ title: STATE, status: "cancelled", blocked: "no" });
  const { container } = render("{{$:/plugins/dionisos/tiddlygit/synchronize-notification}}");
  assert.equal(container.textContent.trim(), "Synchronization cancelled");
});

test("the overlay can be removed before the end of the synchronization", async () => {
  const { wiki, render } = wikiWithPlugin();
  wiki.addTiddler({ title: STATE, status: "running", blocked: "yes" });
  const { widget } = render(`{{${OVERLAY}}}`);
  findButton(widget).invokeActions(widget, {});
  assert.equal(wiki.getTiddler(STATE).fields.blocked, "no");
  assert.equal(wiki.getTiddler(STATE).fields.status, "running");
});

test("the page is blocked while the server synchronizes, even for a synchronization started elsewhere", async () => {
  const { wiki, render } = wikiWithPlugin();
  wiki.addTiddler({ title: SERVER_STATE, synchronizing: "yes" });
  assert.match(render(`{{${OVERLAY}}}`).container.innerHTML, /class="tiddlygit-overlay"/);
  wiki.addTiddler({ title: SERVER_STATE, synchronizing: "no" });
  assert.equal(render(`{{${OVERLAY}}}`).container.textContent.trim(), "");
});

test("the page unblocked by hand stays unblocked until the next synchronization of the server", async () => {
  const { wiki, render } = wikiWithPlugin();
  pluginModule("synchronize.js").followServer(wiki);
  wiki.addTiddler({ title: SERVER_STATE, synchronizing: "yes" });
  const { widget } = render(`{{${OVERLAY}}}`);
  findButton(widget).invokeActions(widget, {});
  assert.equal(render(`{{${OVERLAY}}}`).container.textContent.trim(), "");

  wiki.addTiddler({ title: SERVER_STATE, synchronizing: "no" });
  await sleep(10);
  wiki.addTiddler({ title: SERVER_STATE, synchronizing: "yes" });
  await sleep(10);
  assert.match(render(`{{${OVERLAY}}}`).container.innerHTML, /class="tiddlygit-overlay"/);
});

test("starting a synchronization blocks the page again after an unblocking by hand", async () => {
  const { wiki, syncer, synchronize, state } = await setup();
  try {
    wiki.addTiddler({ title: STATE, status: "200", blocked: "no", dismissed: "yes" });
    synchronize();
    assert.equal(state().blocked, "yes");
    assert.notEqual(state().dismissed, "yes");
  } finally {
    stopSyncer(syncer);
  }
});

test("a change refused by the server during a synchronization is saved after, without error message", async () => {
  const { server, wiki, syncer } = await setup();
  const alerts = [];
  syncer.logger.alert = (...args) => alerts.push(args.join(" "));
  try {
    server.locked = true;
    typeIn(tw(), wiki, "typed while syncing");
    await sleep(300);
    assert.equal(server.text("Form"), "a");
    server.locked = false;
    await eventually(() => server.text("Form") === "typed while syncing", "the refused change was not sent again");
    assert.deepEqual(alerts, []);
  } finally {
    stopSyncer(syncer);
  }
});

test("the browser asks the server whether it synchronizes each time it polls it", async () => {
  const { wiki, syncer } = await setup();
  let synchronizing = true;
  pluginModule("synchronize.js").pollServerState(wiki, syncer, (callback) => callback(null, { synchronizing }));
  try {
    syncer.syncFromServer();
    await eventually(() => wiki.getTiddler(SERVER_STATE)?.fields.synchronizing === "yes", "the server state was not asked");
    // A sync from the server asked while one runs is ignored by the syncer
    await eventually(() => !syncer.forceSyncFromServer && syncer.numTasksInProgress === 0, "the syncer is still busy");
    synchronizing = false;
    syncer.syncFromServer();
    await eventually(() => wiki.getTiddler(SERVER_STATE)?.fields.synchronizing === "no", "the server state was not updated");
  } finally {
    stopSyncer(syncer);
  }
});

test("the server state is changed only when it changes, not to forget an unblocking by hand", async () => {
  const { wiki, syncer } = await setup();
  pluginModule("synchronize.js").pollServerState(wiki, syncer, (callback) => callback(null, { synchronizing: true }));
  try {
    syncer.syncFromServer();
    await eventually(() => wiki.getTiddler(SERVER_STATE)?.fields.synchronizing === "yes", "the server state was not asked");
    const changeCount = wiki.getChangeCount(SERVER_STATE);
    syncer.syncFromServer();
    await sleep(100);
    assert.equal(wiki.getChangeCount(SERVER_STATE), changeCount);
  } finally {
    stopSyncer(syncer);
  }
});
