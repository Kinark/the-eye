// The page probe: injected by web.ts into every document of the session's tab (main frame only), before the page's
// own scripts run. It is the web twin of swift/EyeProbe.swift and writes the same kinds of lines, which web.ts drains
// four times a second and puts on the recording's clock:
//   L  an element seen for the first time {id, cls: tag, view: selector, name}
//   T  one animation frame {t, us = this probe's cost, c = changed elements [[id, x, y, w, h, opacity]], g = gone ids}
//   A  an animation the page declared (CSS transition, CSS animation, Web Animation) on an element
//   LOAF a long animation frame (>50ms) with the scripts that ran in it · EV a slow answer to input · LS a layout shift
// Times are wall milliseconds (performance.timeOrigin + now); rects are CSS pixels in the layout viewport.
(() => {
  const V = "__EYE_VERSION__", RECORD = "__EYE_RECORD__" === "1";
  if (window !== window.top) return;
  if (window.__eye && window.__eye.v === V) { if (RECORD) window.__eye.start(); return; }
  const now = () => performance.timeOrigin + performance.now();
  const E = (window.__eye = { v: V, out: [], n: Math.floor(Math.random() * 9e5 + 1e5) * 1000, ids: new WeakMap(), els: new Map(), track: new Map(), seen: new WeakSet(), origin: null, dropped: 0 });
  const push = (o) => { E.out.push(o); if (E.out.length > 30000) { E.out.splice(0, 10000); E.dropped += 10000; } };
  const r2 = (x) => Math.round(x * 100) / 100;

  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const selector = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${cssEsc(el.id)}`;
    const t = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy");
    if (t) return `[data-testid="${t}"]`;
    const cls = [...el.classList].filter((c) => !/^(css|sc|jsx|svelte)-|^_|\d{3,}/.test(c)).slice(0, 2);
    return el.tagName.toLowerCase() + cls.map((c) => `.${cssEsc(c)}`).join("");
  };
  const ROLE = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button", IMG: "img", H1: "heading", H2: "heading", H3: "heading", H4: "heading", NAV: "navigation", DIALOG: "dialog", LI: "listitem", LABEL: "label", OPTION: "option" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : ["button", "submit", "reset"].includes(t) ? "button" : t === "range" ? "slider" : "textbox";
    }
    if (el.tagName === "A" && !el.hasAttribute("href")) return "";
    return ROLE[el.tagName] || (el.isContentEditable ? "textbox" : "");
  };
  const nameOf = (el) => {
    const a = el.getAttribute("aria-label");
    if (a) return a.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ").trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = el.labels[0].textContent.trim(); if (t) return t; }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value;
    const txt = (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 80);
    return (el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("title") || "").trim();
  };
  const idOf = (el) => {
    let id = E.ids.get(el);
    if (!id) {
      id = ++E.n;
      E.ids.set(el, id);
      E.els.set(id, new WeakRef(el));
      push({ k: "L", id, cls: el.tagName.toLowerCase(), view: selector(el), name: nameOf(el).slice(0, 50) });
    }
    return id;
  };
  // Elements read every frame for a while: what an animation runs on, what a script restyled, and their children.
  const follow = (el, ms) => {
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return;
    const id = idOf(el), until = now() + ms, t = E.track.get(id);
    if (t) t.until = Math.max(t.until, until);
    else if (E.track.size < 80) E.track.set(id, { until, last: null, same: 0 });
  };
  // Recording: on only while a session's probe runs (web.ts start/stop), so a page that is only looked at pays nothing.
  E.obs = [];
  E.off = true;
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      const el = m.target;
      if (el.nodeType !== 1) continue;
      follow(el, 700);
      const kids = el.getElementsByTagName("*");
      for (let i = 0; i < kids.length && i < 24; i++) follow(kids[i], 700);
    }
  });
  const watchDom = () => mo.observe(document, { subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });

  const declare = (a) => {
    const ef = a.effect, el = ef && ef.target;
    if (!el || el.nodeType !== 1) return;
    let tm = {}, kf = [];
    try { tm = ef.getTiming(); kf = ef.getKeyframes(); } catch { /* a detached effect */ }
    const skip = ["offset", "computedOffset", "easing", "composite"];
    const props = a.transitionProperty ? [a.transitionProperty] : [...new Set(kf.flatMap((k) => Object.keys(k).filter((x) => !skip.includes(x))))];
    const val = (k) => (k && props[0] in k ? String(k[props[0]]) : null);
    const dur = typeof tm.duration === "number" ? tm.duration : 0, delay = tm.delay || 0;
    const reps = tm.iterations === Infinity ? Infinity : tm.iterations || 1;
    // A transition's curve is on its timing; an animation's is on its keyframes (the effect itself runs linear).
    const easing = tm.easing && tm.easing !== "linear" ? tm.easing : kf.length === 2 && kf[0].easing ? kf[0].easing : tm.easing || "linear";
    push({
      k: "A", id: idOf(el), t: now(), cls: a.constructor && a.constructor.name || "Animation",
      key: a.animationName || a.transitionProperty || a.id || "animation", kp: props.join(", "),
      dur: dur / 1000, delay: delay / 1000, easing, repeat: reps === Infinity ? "forever" : reps > 1 ? reps : undefined,
      autoreverses: /alternate/.test(tm.direction || "") || undefined, speed: a.playbackRate !== 1 ? a.playbackRate : undefined,
      from: val(kf[0]), to: val(kf[kf.length - 1]), stops: kf.length,
      compositor: props.length > 0 && props.every((p) => ["transform", "opacity", "translate", "scale", "rotate", "filter"].includes(p)),
    });
    follow(el, reps === Infinity ? 3000 : Math.min(15000, (dur * reps + delay) / Math.max(0.1, Math.abs(a.playbackRate || 1)) + 400));
  };

  const tick = () => {
    const p0 = performance.now(), t = performance.timeOrigin + p0;
    try {
      for (const a of document.getAnimations()) if (!E.seen.has(a)) { E.seen.add(a); declare(a); }
    } catch { /* getAnimations unsupported */ }
    const c = [], g = [];
    for (const [id, tr] of E.track) {
      const el = E.els.get(id)?.deref();
      if (!el || !el.isConnected) { E.track.delete(id); if (tr.last) g.push(id); continue; }
      const r = el.getBoundingClientRect();
      // Shown or hidden is not motion: a box with no size has left the picture, and comes back as new.
      if (r.width === 0 && r.height === 0) { if (tr.last) { g.push(id); tr.last = null; } if (t > tr.until) E.track.delete(id); continue; }
      const v = [r2(r.x), r2(r.y), r2(r.width), r2(r.height), r2(Number(getComputedStyle(el).opacity))];
      if (!tr.last || v.some((x, i) => x !== tr.last[i])) { c.push([id, ...v]); tr.last = v; tr.same = 0; }
      else if (++tr.same > 30 && t > tr.until) E.track.delete(id);
    }
    const o = { k: "T", t, us: Math.round((performance.now() - p0) * 1000) };
    if (c.length) o.c = c;
    if (g.length) o.g = g;
    push(o);
    if (!E.off) requestAnimationFrame(tick);
  };

  const observe = (type, fn, extra) => {
    try { const o = new PerformanceObserver((l) => { if (!E.off) for (const e of l.getEntries()) fn(e); }); o.observe({ type, buffered: true, ...extra }); E.obs.push(o); return true; } catch { return false; }
  };
  const at = (e) => performance.timeOrigin + e.startTime;
  const loafOn = () => observe("long-animation-frame", (e) => push({
    k: "LOAF", t: at(e), ms: e.duration, block: e.blockingDuration,
    style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
    scripts: [...e.scripts].sort((p, q) => q.duration - p.duration).slice(0, 6).map((s) => ({
      inv: s.invoker, type: s.invokerType, src: s.sourceURL, fn: s.sourceFunctionName, pos: s.sourceCharPosition,
      ms: s.duration, forced: s.forcedStyleAndLayoutDuration, pause: s.pauseDuration,
    })),
  }));
  const observers = () => {
  if (!E.loaf) observe("longtask", (e) => push({ k: "LOAF", t: at(e), ms: e.duration, scripts: [] }));
  observe("event", (e) => {
    if (e.duration < 40 || !e.interactionId && !["click", "pointerdown", "keydown", "pointerup"].includes(e.name)) return;
    push({ k: "EV", t: at(e), id: e.interactionId || 0, name: e.name, ms: e.duration, wait: e.processingStart - e.startTime, run: e.processingEnd - e.processingStart, target: e.target ? `${selector(e.target)}${nameOf(e.target) ? ` "${nameOf(e.target).slice(0, 30)}"` : ""}` : "" });
  }, { durationThreshold: 16 });
  observe("layout-shift", (e) => {
    if (e.value < 0.001) return;
    push({ k: "LS", t: at(e), v: e.value, input: e.hadRecentInput, src: (e.sources || []).slice(0, 3).map((s) => ({
      el: s.node && s.node.nodeType === 1 ? selector(s.node) : s.node ? "text" : "?",
      from: [s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map(Math.round),
      to: [s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map(Math.round),
    })) });
  });
  };

  E.start = () => {
    if (!E.off) return;
    E.off = false;
    watchDom();
    E.loaf = loafOn();
    observers();
    requestAnimationFrame(tick);
  };
  E.stop = () => { E.off = true; mo.disconnect(); for (const o of E.obs.splice(0)) o.disconnect(); E.track.clear(); E.out = []; };

  // Where the viewport sits on screen, exactly: a real pointer event knows both its screen and its page position.
  const calibrate = (e) => { if (e.isTrusted && e.pointerType !== "touch") E.origin = [e.screenX - e.clientX, e.screenY - e.clientY]; };
  addEventListener("pointermove", calibrate, { capture: true, passive: true });
  addEventListener("pointerdown", calibrate, { capture: true, passive: true });

  E.view = () => {
    const vv = window.visualViewport;
    return { url: location.href, title: document.title, ready: document.readyState, iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight,
      sx: screenX, sy: screenY, origin: E.origin, scale: vv ? vv.scale : 1, vx: vv ? vv.offsetLeft : 0, vy: vv ? vv.offsetTop : 0, dpr: devicePixelRatio,
      scrollY, scrollX, focus: document.activeElement && document.activeElement !== document.body ? selector(document.activeElement) : "", loaf: E.loaf,
      sh: document.scrollingElement ? document.scrollingElement.scrollHeight : 0, sw: document.scrollingElement ? document.scrollingElement.scrollWidth : 0 };
  };
  E.drain = (watch) => {
    const out = E.out; E.out = [];
    const d = E.dropped; E.dropped = 0;
    const watched = (watch || []).map((q) => {
      const h = E.lookup(q);
      if (!h) return { q };
      const r = h.el.getBoundingClientRect();
      return { q, id: idOf(h.el), rect: [r.x, r.y, r.width, r.height] };
    });
    return { out, view: E.view(), dropped: d, watched };
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility === "visible" && cs.display !== "none" && Number(cs.opacity) > 0.01;
  };
  const INTERACTIVE = "a[href],button,input,select,textarea,summary,label,[role],[tabindex],[onclick],[contenteditable=''],[contenteditable=true]";
  // A thing by CSS selector, else by what it is called (exact first, then contains), the interactive and visible first.
  E.lookup = (q) => {
    let all = [];
    try { all = [...document.querySelectorAll(q)]; } catch { /* not a selector */ }
    if (all.length) return { el: all.find(visible) || all[0], how: "selector", n: all.length };
    const want = q.trim().toLowerCase().replace(/\s+/g, " ");
    const pool = [...document.querySelectorAll(INTERACTIVE)];
    const named = (els) => els.map((el) => ({ el, name: nameOf(el).toLowerCase().replace(/\s+/g, " ") }));
    const pick = (cands) => cands.sort((a, b) => (visible(b.el) - visible(a.el)) || ((a.el.tagName === "LABEL") - (b.el.tagName === "LABEL")) || (a.name.length - b.name.length))[0];
    let hit = pick(named(pool).filter((x) => x.name === want)) || pick(named(pool).filter((x) => x.name.includes(want)));
    if (!hit) {
      // Plain text: the innermost element that says it.
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let best = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.toLowerCase().includes(want) || !n.parentElement) continue;
        const el = n.parentElement;
        if (visible(el) && (!best || best.contains(el))) best = el;
        if (best && visible(best)) break;
      }
      if (best) return { el: best, how: "text", n: 1 };
      return null;
    }
    return { el: hit.el, how: "name", n: 1 };
  };
  // Can a person press it right now: visible, enabled, in the viewport (scrolled there if not), and on top at its centre.
  E.find = (q, scroll) => {
    const hit = E.lookup(q);
    if (!hit) return { ok: false, why: `nothing on the page matches ${JSON.stringify(q)} (a CSS selector, or what the thing is called)` };
    const el = hit.el, label = `${roleOf(el) || el.tagName.toLowerCase()} ${selector(el)}${nameOf(el) ? ` "${nameOf(el).slice(0, 40)}"` : ""}`;
    if (!visible(el)) return { ok: false, why: `${label} is on the page but not visible (display, visibility, opacity or no size)`, label };
    let r = el.getBoundingClientRect(), scrolled = false;
    const inView = () => r.bottom > 2 && r.right > 2 && r.top < innerHeight - 2 && r.left < innerWidth - 2;
    if (!inView() && scroll !== false) { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); r = el.getBoundingClientRect(); scrolled = true; }
    if (!inView()) return { ok: false, why: `${label} is outside the window and could not be scrolled into it`, label };
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const top = document.elementFromPoint(cx, cy);
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const covered = top && top !== el && !el.contains(top) && !(top.contains(el) && getComputedStyle(el).pointerEvents === "none")
      ? `${selector(top)}${nameOf(top) ? ` "${nameOf(top).slice(0, 30)}"` : ""}` : "";
    return { ok: true, label, how: hit.how, matches: hit.n, rect: [r.left, r.top, r.width, r.height], x: cx, y: cy, scrolled, disabled, covered };
  };
  E.focusOn = (q) => {
    const hit = E.lookup(q);
    if (!hit) return `nothing on the page matches ${JSON.stringify(q)}`;
    const el = hit.el.tagName === "LABEL" && hit.el.control ? hit.el.control : hit.el;
    el.focus();
    if (typeof el.setSelectionRange === "function" && typeof el.value === "string") { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* type=email etc. */ } }
    return document.activeElement === el ? "" : `${selector(el)} does not take focus`;
  };
  // What can be pressed or read in the window right now, in reading order.
  E.tree = (max) => {
    const out = [];
    let hidden = 0;
    for (const el of document.querySelectorAll(`${INTERACTIVE},h1,h2,h3,h4,img[alt],[aria-live],dialog,nav,main,form`)) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { hidden++; continue; }
      if (out.length >= max) { hidden++; continue; }
      const st = [el.disabled && "disabled", document.activeElement === el && "focused", el.checked && "checked", el.getAttribute("aria-expanded") === "true" && "expanded", el.getAttribute("aria-selected") === "true" && "selected"].filter(Boolean);
      const value = "value" in el && typeof el.value === "string" && el.tagName !== "BUTTON" && el.type !== "submit" ? el.value : null;
      out.push({ role: roleOf(el) || el.tagName.toLowerCase(), name: nameOf(el).slice(0, 60), sel: selector(el), rect: [r.left, r.top, r.width, r.height].map(Math.round), st, value: value === null ? undefined : value.slice(0, 60) });
    }
    return { items: out, hidden };
  };
  if (RECORD) E.start();
})();
