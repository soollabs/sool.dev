// Dependency-free behaviour checks; run with node --test tools/site.test.cjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(new URL("../public/js/site.js", `file://${__filename}`), "utf8");

class Element {
  constructor() { this.children = []; this.dataset = {}; this.handlers = {}; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map((x) => typeof x === "string" ? x : x.textContent).join(""); }
  set innerHTML(_) { throw new Error("HTML injection is forbidden"); }
}

function fixture(reply, { cached = null, shell = false } = {}) {
  const list = new Element();
  const feed = new Element();
  feed.dataset.feed = "soollabs";
  feed.querySelector = () => list;
  const input = new Element();
  input.focus = () => {};
  const shortcut = { checked: false };
  const dialog = new Element();
  const out = new Element();
  const form = new Element();
  dialog.querySelector = (selector) => ({
    ".shell-out": out, "#shell-cmd": input,
    "[data-term-shortcut]": shortcut, ".shell-in": form,
  })[selector];
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const document = new Element();
  document.documentElement = { classList: { add() {} } };
  document.querySelector = (selector) => selector === "[data-feed]" ? feed : shell ? dialog : null;
  document.querySelectorAll = () => [];
  document.createElement = () => new Element();
  const timers = new Map();
  let counter = 0;
  let requests = 0;
  vm.runInNewContext(source, {
    document, AbortController, URL, console,
    localStorage: { getItem: () => cached, setItem() {} },
    fetch: async (url, options) => { requests++; return reply(url, options); },
    setTimeout: (fn) => { timers.set(++counter, fn); return counter; },
    clearTimeout: (id) => timers.delete(id),
  });
  return { list, timers, document, dialog, shortcut, input, requests: () => requests };
}

const ok = (body) => ({ ok: true, json: async () => body });
const repos = [{ name: "holdmydocs" }];
const commit = (message = "fix: a bug", url = "https://github.com/soollabs/holdmydocs/commit/abc") => ({
  author: { type: "User", login: "soolbyte" }, parents: [{}], html_url: url,
  commit: { committer: { date: "2026-10-16T00:00:00Z" }, message },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("loading and unavailable states retain a GitHub link", async () => {
  const f = fixture(async () => ({ ok: false, status: 403 }));
  assert.match(f.list.textContent, /Fetching.*github.com\/soollabs/);
  await flush();
  assert.match(f.list.textContent, /could not be loaded.*github.com\/soollabs/);
  assert.equal(f.timers.size, 0);
});

test("a stalled request is aborted and replaced with the fallback", async () => {
  const f = fixture((_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  for (const timeout of f.timers.values()) timeout();
  await flush();
  assert.match(f.list.textContent, /could not be loaded/);
  assert.equal(f.timers.size, 0);
});

test("partial results are labelled and external text is never parsed as HTML", async () => {
  const f = fixture(async (url) => {
    if (url.includes("/orgs/")) return ok(repos);
    if (url.includes("/commits?")) return ok([commit("<img src=x onerror=alert(1)>")]);
    return { ok: false, status: 503 };
  });
  await flush();
  assert.match(f.list.textContent, /Some repositories could not be fully loaded/);
  assert.match(f.list.textContent, /<img src=x onerror=alert\(1\)>/);
});

test("unsafe commit destinations are discarded", async () => {
  const f = fixture(async (url) => ok(url.includes("/orgs/") ? repos :
    url.includes("/commits?") ? [commit("unsafe", "javascript:alert(1)")] : []));
  await flush();
  assert.doesNotMatch(f.list.textContent, /unsafe/);
  assert.match(f.list.textContent, /could not be loaded/);
});

test("a fresh cached response avoids the network", async () => {
  const f = fixture(() => { throw new Error("unexpected request"); }, {
    cached: JSON.stringify({ t: Date.now(), v: [] }),
  });
  await flush();
  assert.equal(f.requests(), 0);
});

test("backtick only opens the shell after explicit opt-in", async () => {
  const f = fixture(async () => ok([]), { shell: true });
  const event = { key: "`", target: { closest: () => null }, preventDefault() {} };
  f.document.handlers.keydown(event);
  assert.ok(!f.dialog.open);
  f.shortcut.checked = true;
  f.document.handlers.keydown(event);
  assert.equal(f.dialog.open, true);
  f.dialog.close();
  f.document.handlers.keydown({ ...event, target: { closest: () => true } });
  assert.equal(f.dialog.open, false);
  await flush();
});

test("invalid cached response shapes are replaced from the network", async () => {
  const f = fixture(async () => ok([]), {
    cached: JSON.stringify({ t: Date.now(), v: { message: "not an array" } }),
  });
  await flush();
  assert.equal(f.requests(), 1);
  assert.match(f.list.textContent, /No recent commits/);
});

test("future-dated cache entries cannot indefinitely suppress requests", async () => {
  const f = fixture(async () => ok([]), {
    cached: JSON.stringify({ t: Date.now() + 86400000, v: [] }),
  });
  await flush();
  assert.equal(f.requests(), 1);
});

test("malformed records do not discard valid neighbouring commits", async () => {
  const f = fixture(async (url) => ok(url.includes("/orgs/") ? [null, ...repos] :
    url.includes("/commits?") ? [null, {}, commit()] : [null]));
  await flush();
  assert.match(f.list.textContent, /Some repositories/);
  assert.match(f.list.textContent, /fix: a bug/);
});

test("non-array endpoints do not discard results from another endpoint", async () => {
  const f = fixture(async (url) => ok(url.includes("/orgs/") ? repos :
    url.includes("/commits?") ? [commit()] : { message: "unexpected response" }));
  await flush();
  assert.match(f.list.textContent, /Some repositories/);
  assert.match(f.list.textContent, /fix: a bug/);
});

test("spoofed GitHub hosts, credentials and invalid dates are rejected", async () => {
  const badDate = commit("invalid date");
  badDate.commit.committer.date = "not a date";
  const f = fixture(async (url) => ok(url.includes("/orgs/") ? repos :
    url.includes("/commits?") ? [
      commit("spoofed host", "https://github.com.evil.example/commit"),
      commit("credentials", "https://github.com@evil.example/commit"),
      commit("embedded password", "https://user:password@github.com/commit"),
      badDate, commit("valid commit"),
    ] : []));
  await flush();
  assert.match(f.list.textContent, /valid commit/);
  assert.doesNotMatch(f.list.textContent, /spoofed host|credentials|embedded password|invalid date/);
});

test("bot and merge commits remain excluded", async () => {
  const bot = commit("automated");
  bot.author.type = "Bot";
  const merge = commit("merged");
  merge.parents.push({});
  const f = fixture(async (url) => ok(url.includes("/orgs/") ? repos :
    url.includes("/commits?") ? [bot, merge, commit()] : []));
  await flush();
  assert.match(f.list.textContent, /fix: a bug/);
  assert.doesNotMatch(f.list.textContent, /automated|merged/);
});
