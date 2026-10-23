// Script for sool.dev, served as written without dependencies or a build.
// The page works without this file; it adds the GitHub release chip, the
// bench feed and the lab shell.
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  document.documentElement.classList.add("js");

  $$("[data-path]").forEach((el) => { el.textContent = location.pathname; });
  $$("[data-year]").forEach((el) => { el.textContent = new Date().getFullYear(); });

  // GitHub (public API, no token) ----------------------------------------
  // Responses are cached for ten minutes so reloads stay under the
  // unauthenticated rate limit. The feed reports unavailable results.
  const GH_TTL = 10 * 60 * 1000;
  async function gh(path, valid = (v) => v !== null && typeof v === "object") {
    const key = `gh:${path}`;
    try {
      const hit = JSON.parse(localStorage.getItem(key));
      const age = Date.now() - hit?.t;
      if (hit && age >= 0 && age < GH_TTL && valid(hit.v)) return hit.v;
    } catch { /* storage blocked */ }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: { Accept: "application/vnd.github+json" }, signal: controller.signal,
      });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const v = await res.json();
      if (!valid(v)) throw new Error("invalid github response");
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch { /* full or blocked */ }
      return v;
    } finally {
      clearTimeout(timeout);
    }
  }
  const isGitHub = (url) => {
    if (typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      return parsed.origin === "https://github.com" && !parsed.username && !parsed.password;
    } catch { return false; }
  };
  const validDate = (date) => typeof date === "string" && Number.isFinite(Date.parse(date));

  // Latest release chip
  $$("[data-release]").forEach(async (el) => {
    try {
      const { tag_name: tag, html_url: url } = await gh(`/repos/${el.dataset.release}/releases/latest`);
      if (typeof tag !== "string" || !tag || !isGitHub(url)) return;
      const a = document.createElement("a");
      a.className = el.className;
      a.href = url;
      a.rel = "noopener";
      a.textContent = `latest ${tag}`;
      el.replaceWith(a);
    } catch { /* leave hidden */ }
  });

  // Bench feed: recent commits and releases across the org's public repos.
  let feedLines = null;
  const feed = $("[data-feed]");
  if (feed) loadFeed(feed);

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    const steps = [[60, "s", 1], [3600, "m", 60], [86400, "h", 3600], [86400 * 14, "d", 86400], [86400 * 60, "w", 604800], [86400 * 730, "mo", 2592000]];
    for (const [max, unit, div] of steps) if (s < max) return `${Math.floor(s / div)}${unit}`;
    return `${Math.floor(s / 31536000)}y`;
  }

  async function loadFeed(box) {
    const org = box.dataset.feed;
    const list = $(".feed-body", box);
    function notice(text) {
      const li = document.createElement("li");
      li.className = "feed-msg";
      li.append(`${text} The code is at `);
      li.append(Object.assign(document.createElement("a"), {
        href: `https://github.com/${org}`, rel: "noopener", textContent: `github.com/${org}`,
      }), ".");
      return li;
    }
    list.replaceChildren(notice("Fetching from GitHub."));
    try {
      let incomplete = false;
      const unavailable = () => { incomplete = true; return []; };
      const keep = (valid) => (value) => {
        if (valid(value)) return true;
        incomplete = true;
        return false;
      };
      const repos = (await gh(`/orgs/${org}/repos?sort=pushed&per_page=10`, Array.isArray))
        .filter(keep((r) => r && typeof r.name === "string" && /^[\w.-]+$/.test(r.name)))
        .filter((r) => !r.fork && !r.archived && !r.private && !r.name.startsWith("."))
        .slice(0, 5);
      const per = await Promise.all(repos.map(async (r) => {
        const [commits, releases] = await Promise.all([
          gh(`/repos/${org}/${r.name}/commits?per_page=10`, Array.isArray).catch(unavailable),
          gh(`/repos/${org}/${r.name}/releases?per_page=3`, Array.isArray).catch(unavailable),
        ]);
        const isBot = (c) => c.author?.type === "Bot" || /\[bot\]$/.test(c.author?.login || "");
        return [
          ...commits.filter(keep((c) => c && Array.isArray(c.parents) &&
            validDate(c.commit?.committer?.date) && typeof c.commit?.message === "string" && isGitHub(c.html_url)))
            .filter((c) => !isBot(c) && c.parents.length < 2).map((c) => ({
            t: c.commit.committer.date, repo: r.name, url: c.html_url, text: c.commit.message.split("\n")[0],
          })),
          ...releases.filter((x) => !x?.draft)
            .filter(keep((x) => x && validDate(x.published_at) && typeof x.tag_name === "string" && isGitHub(x.html_url))).map((x) => ({
            t: x.published_at, repo: r.name, url: x.html_url, text: `released ${x.tag_name}`, rel: true,
          })),
        ];
      }));
      const items = per.flat().filter((i) => isGitHub(i.url)).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 12);
      if (!items.length) {
        list.replaceChildren(notice(incomplete ? "GitHub results could not be loaded." : "No recent commits or releases to show."));
        return;
      }
      list.replaceChildren(...items.map(feedItem));
      if (incomplete) list.prepend(notice("Some repositories could not be fully loaded."));
      feedLines = items.map((i) => `${ago(i.t).padStart(4)}  ${i.repo.padEnd(12)} ${i.text}`);
      if (incomplete) feedLines.unshift("Some repositories could not be fully loaded.");
    } catch {
      list.replaceChildren(notice("GitHub results could not be loaded."));
    }
  }

  function feedItem(i) {
    const li = document.createElement("li");
    if (i.rel) li.className = "rel";
    const time = Object.assign(document.createElement("time"), { dateTime: i.t, title: new Date(i.t).toLocaleString("en-GB"), textContent: ago(i.t) });
    const repo = Object.assign(document.createElement("span"), { className: "repo", textContent: i.repo });
    const msg = Object.assign(document.createElement("a"), { className: "msg", href: i.url, rel: "noopener" });
    const m = !i.rel && i.text.match(/^(\w+)(\([^)]*\))?(!)?:\s*/);
    if (m) {
      msg.append(Object.assign(document.createElement("span"), { className: `type ${m[1].toLowerCase()}`, textContent: m[0] }));
      msg.append(i.text.slice(m[0].length));
    } else {
      msg.textContent = i.text;
    }
    li.append(time, repo, msg);
    return li;
  }

  // Shiny card ----------------------------------------------------------
  // With a mouse, a project screenshot leans towards the pointer and its
  // sheen follows it, like a shiny trading card. The CSS turns it off for
  // reduced motion.
  $$(".shot").forEach((shot) => {
    const able = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    let frame = 0;
    shot.addEventListener("pointermove", (e) => {
      if (!able.matches) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = shot.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        shot.classList.add("shiny");
        shot.style.setProperty("--ry", `${((x - 0.5) * 10).toFixed(2)}deg`);
        shot.style.setProperty("--rx", `${((0.5 - y) * 7).toFixed(2)}deg`);
        shot.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        shot.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
      });
    });
    shot.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      shot.classList.remove("shiny");
      shot.style.removeProperty("--rx");
      shot.style.removeProperty("--ry");
    });
  });

  // Lab shell -----------------------------------------------------------
  const shell = $(".shell");
  if (!shell) return;
  const out = $(".shell-out", shell);
  const input = $("#shell-cmd", shell);
  const shortcut = $("[data-term-shortcut]", shell);
  const history = [];
  let hIdx = 0;

  const LINKS = {
    hmd: "https://hmd.sool.dev",
    docs: "https://hmd.sool.dev",
    github: "https://github.com/soollabs",
    source: "https://github.com/soollabs/holdmydocs",
  };

  const COMMANDS = {
    help: () => [
      "commands:",
      "  ls              list projects",
      "  log             recent commits and releases",
      "  cat rules       read the lab rules",
      "  open <name>     hmd | docs | github | source",
      "  whoami          who is asking",
      "  date            local time",
      "  clear           wipe the screen",
      "  exit            close this shell",
    ].join("\n"),
    ls: () => $$(".cards .card").map((li) => {
      const [name, kind, status, what] = ["h3", ".kind", ".st", ".what"].map((s) => $(s, li).textContent.trim());
      return `${name.toLowerCase().padEnd(12)} ${kind.padEnd(5)} ${`[${status}]`.padEnd(12)} ${what}`;
    }).join("\n"),
    log: () => feedLines ? feedLines.join("\n") : "log: nothing yet. github may be slow or offline.",
    cat: (arg) => arg === "rules"
      ? $$(".rules li").map((li) => `${$("h3", li).textContent.toLowerCase()}\n  ${$("p", li).textContent}`).join("\n")
      : `cat: ${arg || "missing operand"}: try 'cat rules'`,
    open: (arg) => {
      const url = Object.hasOwn(LINKS, arg) ? LINKS[arg] : null;
      if (!url) return `open: unknown target '${arg || ""}'. try: ${Object.keys(LINKS).join(", ")}`;
      window.open(url, "_blank", "noopener");
      return `opening ${url}`;
    },
    whoami: () => "guest",
    date: () => new Date().toString(),
    sudo: () => "guest is not in the sudoers file. this incident will be reported to nobody.",
    rm: () => "nice try.",
    hmd: () => COMMANDS.open("hmd"),
    clear: () => { out.textContent = ""; return null; },
    exit: () => { shell.close(); return null; },
  };

  function print(text, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    out.append(div);
    out.scrollTop = out.scrollHeight;
  }

  function run(line) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    print(`guest@sool:~$ ${line}`, "dim");
    if (!cmd) return;
    const name = cmd.toLowerCase();
    const fn = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
    const res = fn ? fn(args.join(" ")) : `${cmd}: command not found. type 'help'.`;
    if (res) print(res);
  }

  function openShell() {
    if (shell.open) return;
    shell.showModal();
    if (!out.childElementCount) print("sool labs shell. type 'help' to look around.");
    input.focus();
  }

  $$("[data-term-open]").forEach((b) => b.addEventListener("click", openShell));
  $$("[data-term-close]").forEach((b) => b.addEventListener("click", () => shell.close()));
  let downOnBackdrop = false;
  shell.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === shell; });
  shell.addEventListener("click", (e) => { if (e.target === shell && downOnBackdrop) shell.close(); });

  $(".shell-in", shell).addEventListener("submit", (e) => {
    e.preventDefault();
    const line = input.value;
    if (line.trim()) history.push(line);
    hIdx = history.length;
    input.value = "";
    run(line);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && hIdx > 0) { input.value = history[--hIdx]; e.preventDefault(); }
    if (e.key === "ArrowDown") { hIdx = Math.min(history.length, hIdx + 1); input.value = history[hIdx] || ""; e.preventDefault(); }
    if (e.key === "`") { e.preventDefault(); if (!e.repeat) shell.close(); }
  });

  document.addEventListener("keydown", (e) => {
    if (!shortcut.checked || e.key !== "`" || e.repeat || shell.open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    openShell();
  });
})();
