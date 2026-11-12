// The run: the ball leaves the mark in the hero and makes its way down the page, through the
// rooms of scene.js and the pieces of the app, into the mark at the bottom. Scrolling moves it.
//
// It moves like a ball. It rolls along what it is on, leaves an edge the way it was going, falls
// in a parabola, and bounces twice where it lands before it rolls again. Where it lands on a
// slope it rolls downhill, whichever way it came. The path is worked out from where the pieces
// sit, so it holds at any width. Without this file, or with reduced motion, the page shows every
// piece in its finished state.

const root = document.documentElement;
const still = matchMedia("(prefers-reduced-motion: reduce)");

if (!still.matches && "getPointAtLength" in SVGPathElement.prototype) start();

function start() {
  const $ = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => [...p.querySelectorAll(s)];

  const page = $("#page");
  const base = $("#track-base");
  const lit = $("#track-lit");
  const wire = $("#track-wire");
  const ball = $("#ball");
  const qtext = $("#qtext");
  const query = qtext.textContent;
  const R = 13; // the ball on its way, in px
  const COS = Math.cos(Math.PI / 6);

  root.classList.add("run");

  let keys = []; // { len, at }: the ball is `len` along the path when the page is scrolled to `at`
  let gates = []; // { len, el, cls }: `el` gets `cls` once the ball is past `len`
  let typing = null; // { a, b }: the stretch of the path along the prompt
  let total = 0;
  let r0 = R;
  let r1 = R;
  let lastLeg = 0;
  let cur = 0;
  let frame = 0;
  let then = 0;

  function build() {
    const o = page.getBoundingClientRect();
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - o.left, t: r.top - o.top, w: r.width, h: r.height };
    };
    const at = (el, ax, ay, dx = 0, dy = 0) => {
      const r = box(el);
      return { x: r.l + r.w * ax + dx, y: r.t + r.h * ay + dy };
    };
    const mid = (el) => at(el, 0.5, 0.5);
    const unit = (from, to) => {
      const n = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      return { x: (to.x - from.x) / n, y: (to.y - from.y) / n };
    };

    let d = "";
    let p = null;
    let way = null; // the direction the ball is moving at `p`; null when it is at rest
    keys = [];
    gates = [];

    const len = () => {
      base.setAttribute("d", d);
      return base.getTotalLength();
    };
    const key = () => keys.push({ len: len(), y: p.y });
    const gate = (el, cls = "on") => {
      const here = len() - 2;
      for (const e of [el].flat()) gates.push({ len: here, el: e, cls });
    };

    // A fall. A ball that is moving sideways keeps doing so, and gravity does the rest: a
    // parabola that starts the way the ball was going. A ball with no sideways motion drops.
    const drop = (to) => {
      const dx = to.x - p.x;
      const dy = to.y - p.y;
      if (way && Math.abs(way.x) > 0.2 && way.x * dx > 0) {
        const c = {
          x: p.x + dx / 2,
          y: Math.min(p.y + (way.y / way.x) * (dx / 2), p.y + dy * 0.6),
        };
        d += `Q${c.x} ${c.y} ${to.x} ${to.y}`;
        way = unit(c, to);
      } else if (Math.abs(dx) < 6) {
        d += `L${to.x} ${to.y}`;
        way = { x: 0, y: 1 };
      } else if (!way || Math.abs(way.x) <= 0.2) {
        // Nearly straight down, with the little drift that brings it over its landing.
        d += `C${p.x} ${p.y + dy * 0.5} ${to.x} ${to.y - dy * 0.5} ${to.x} ${to.y}`;
        way = { x: 0, y: 1 };
      } else {
        // What it lands on is behind it: it tips off the edge that way.
        d += `Q${p.x + dx / 2} ${p.y} ${to.x} ${to.y}`;
        way = unit({ x: p.x + dx / 2, y: p.y }, to);
      }
      p = to;
    };
    const line = (to) => {
      d += `L${to.x} ${to.y}`;
      way = unit(p, to);
      p = to;
    };
    // One bounce: up and over to `to`.
    const hop = (to, h = 26) => {
      // Straight down to the next row: lean out, so it reads as a hop and not a line.
      const lean = Math.abs(to.x - p.x) < 20 ? 3 * h : 0;
      const c = { x: (p.x + to.x) / 2 + lean, y: Math.min(p.y, to.y) - 2 * h };
      d += `Q${c.x} ${c.y} ${to.x} ${to.y}`;
      way = unit(c, to);
      p = to;
    };
    // Landing on a surface that runs from `a` to `b`: fall to `a`, bounce twice along it, each
    // lower and shorter than the last, then roll to `b`. `landed` runs at the moment of landing.
    const land = (a, b, landed) => {
      const fell = Math.max(0, a.y - p.y);
      drop(a);
      landed?.();
      const u = unit(a, b);
      const run = Math.hypot(b.x - a.x, b.y - a.y);
      let h = Math.min(20, Math.max(6, fell * 0.06));
      let step = Math.min(run * 0.24, 64);
      for (let n = 0; n < 2 && step > 8; n++) {
        const to = { x: p.x + u.x * step, y: p.y + u.y * step };
        const c = { x: (p.x + to.x) / 2, y: (p.y + to.y) / 2 - 2 * h };
        d += `Q${c.x} ${c.y} ${to.x} ${to.y}`;
        p = to;
        h *= 0.4;
        step *= 0.6;
      }
      line(b);
    };
    // Landing on a level bar that runs the way the ball is going.
    const onto = (a, b, landed) => land(a, b, landed);
    const loop = (r) => {
      d += `A${r} ${r} 0 0 0 ${p.x} ${p.y - 2 * r}A${r} ${r} 0 0 0 ${p.x} ${p.y}`;
    };

    // Through a room of the other world (scene.js): down onto it, across it, and it is changed.
    // `under` moves the room to stand right below the ball, so the ball can simply drop.
    const rooms = [];
    const room = (name, under = false) => {
      const el = $(`.sc[data-scene="${name}"]`);
      if (!el) return;
      if (under) el.style.setProperty("--at", `${p.x - box(el.parentElement).l}px`);
      const r = box(el);
      const [vx, vy, vw] = el.getAttribute("viewBox").split(" ").map(Number);
      const k = r.w / vw;
      const pt = (s, lift = 0) => {
        const [x, y] = s.split(",").map(Number);
        return { x: r.l + (x - vx) * k, y: r.t + (y - vy) * k - lift };
      };
      rooms.push({ in: pt(el.dataset.in), out: pt(el.dataset.out) });
      land(pt(el.dataset.a, R), pt(el.dataset.b, R), () => {
        key();
        gate(el);
      });
      key();
    };

    // Out of the mark.
    const hero = box($("#hero-ball"));
    r0 = hero.w / 2;
    p = { x: hero.l + r0, y: hero.t + r0 };
    d = `M${p.x} ${p.y}`;
    key();

    room("desk", true);

    // 01: across the prompt, the way it was already going: it lands on the far end and bounces
    // along it, each bounce lower, and the prompt is typed as it goes.
    const bar = $("#qbar");
    const b0 = at(bar, 1, 0, -60, -R);
    const b1 = at(bar, 0, 0, 30, -R);
    drop(b0);
    key();
    const typed = len();
    [26, 19, 12].forEach((h, i) => {
      hop({ x: b0.x + ((b1.x - b0.x) * (i + 1)) / 3, y: b0.y }, h);
    });
    key();
    typing = { a: typed, b: len() };
    gate($("#res"));

    room("files");

    // 02: from tab to tab, ending on "Save view". The strip is cut off on the left, as if torn
    // from a wider window: only the tabs in sight, and ahead of the ball, count.
    const strip = box($("#tabs"));
    $$("#tabs .tab")
      .filter((t) => at(t, 0.5, 0).x > Math.max(strip.l + 24, p.x + 12))
      .forEach((t, i) => {
        const up = at(t, 0.5, 0, 0, -R);
        if (i) hop(up);
        else drop(up);
        key();
        gate(t);
      });

    room("trays");

    // 03: down the runtimes, one socket each.
    $$("#runtimes .sock").forEach((s, i) => {
      if (i) line(mid(s));
      else drop(mid(s));
      key();
      gate(s.parentElement);
    });

    room("machines", true);

    // 04: the ramp, a slope: the ball lands on it wherever it comes down and rolls to the end.
    // Two keys close together: a little scroll, a long way.
    const ramp = box($("#ramp"));
    const top = { x: ramp.l + 30, y: ramp.t + ramp.h - 46 };
    const foot = { x: ramp.l + ramp.w * 0.96, y: ramp.t + ramp.h - 6 };
    const on = (f) => ({ x: top.x + (foot.x - top.x) * f, y: top.y + (foot.y - top.y) * f });
    const wide = ramp.w > 620;
    const drift = way && way.x < -0.2 ? -0.12 : 0.08;
    const f0 = Math.min(wide ? 0.3 : 0.6, Math.max(0.03, (p.x - top.x) / (foot.x - top.x) + drift));
    const budgets = $$(".budget");
    land(on(f0), on(f0 + 0.14), key);
    [0.22, 0.5, 0.8].forEach((f, i) => {
      if (f > f0 + 0.14) line(on(f));
      if (i === 1 && wide) loop(48);
      gate(budgets[i]);
    });
    line(foot);
    key();

    room("belt");

    // 05: down the seam of the hive and through the core.
    const hive = $("#hive");
    const tiles = $$("#hive .tile");
    drop(at(hive, 0.5, 0, 0, 6));
    key();
    line(at(hive, 0.5, 0.2));
    gate(tiles.slice(0, 2));
    line(at(hive, 0.5, 0.4772)); // where the ball sits in the core's mark
    key();
    gate([$("#hive .core"), ...tiles.slice(2, 4)]);
    line(at(hive, 0.5, 0.74));
    gate(tiles.slice(4));
    line(at(hive, 0.5, 1, 0, -6));
    key();

    room("bench", true);

    // 06: across what is not built yet, starting at the end the ball is nearer. Where the tiles
    // wrap into rows, it runs each row the other way.
    const rows = new Map();
    for (const t of $$(".soon-tile")) {
      const y = Math.round(box(t).t);
      rows.set(y, [...(rows.get(y) ?? []), t]);
    }
    const first = [...rows.values()][0];
    const fromRight = Math.abs(mid(first.at(-1)).x - p.x) < Math.abs(mid(first[0]).x - p.x);
    [...rows.values()]
      .flatMap((row, i) => ((i % 2 === 1) !== fromRight ? row.reverse() : row))
      .forEach((t, i) => {
        const up = at(t, 0.5, 0, 0, -R);
        if (i) hop(up);
        else drop(up);
        key();
        gate(t);
      });

    room("crates");

    // 07: along the top of the terminal, a line at a time.
    const term = $("#term");
    const lines = $$("#term .t-l");
    const t0 = at(term, 0, 0, 30, -R);
    const t1 = at(term, 1, 0, -40, -R);
    onto(t0, { x: t0.x + (t1.x - t0.x) / lines.length, y: t0.y }, key);
    lines.forEach((l, i) => {
      if (i) line({ x: t0.x + ((t1.x - t0.x) * (i + 1)) / lines.length, y: t0.y });
      gate(l);
    });
    key();

    room("outbox");

    // Into the mark.
    lastLeg = len();
    const end = box($("#end-ball"));
    r1 = end.w / 2;
    drop({ x: end.l + r1, y: end.t + r1 });
    key();
    gate(ball, "home");

    total = len();
    lit.setAttribute("d", d);
    lit.style.strokeDasharray = total;

    // The cables: from the front corner of one room's floor to the back corner of the next, laid
    // along the two directions the floor itself has, so the rooms read as one floor.
    let cable = "";
    for (let i = 1; i < rooms.length; i++) {
      const a = rooms[i - 1].out;
      const b = rooms[i].in;
      const dx = (b.x - a.x) / COS;
      const dy = (b.y - a.y) * 2;
      const right = (dy + dx) / 2; // how far along the floor's right-and-down direction
      const left = (dy - dx) / 2; // and along its left-and-down one
      cable += `M${a.x} ${a.y}`;
      if (right > 0 && left > 0) {
        const turn =
          right > left ? { x: right * COS, y: right / 2 } : { x: -left * COS, y: left / 2 };
        cable += `L${a.x + turn.x} ${a.y + turn.y}`;
      }
      cable += `L${b.x} ${b.y}`;
    }
    wire.setAttribute("d", cable);

    // When each key is reached: as it crosses a line a little under the middle of the window.
    const line0 = innerHeight * 0.56;
    const most = Math.max(1, page.offsetHeight - innerHeight);
    keys.forEach((k, i) => {
      k.at = i ? Math.max(k.y - line0, keys[i - 1].at + 30) : 0;
    });
    for (let i = keys.length - 1, cap = most - 2; i > 0; i--, cap -= 2) {
      keys[i].at = Math.min(keys[i].at, cap);
    }
  }

  function target(y) {
    if (y <= 0) return 0;
    for (let i = 1; i < keys.length; i++) {
      const b = keys[i];
      if (y < b.at) {
        const a = keys[i - 1];
        return a.len + ((b.len - a.len) * (y - a.at)) / (b.at - a.at);
      }
    }
    return total;
  }

  const ease = (t) => t * t * (3 - 2 * t);

  function radius(l) {
    const out = keys[1].len * 0.55;
    if (l < out) return r0 + (R - r0) * ease(l / out);
    const home = lastLeg + (total - lastLeg) * 0.45;
    if (l > home) return R + (r1 - R) * ease((l - home) / (total - home));
    return R;
  }

  function draw() {
    const pt = base.getPointAtLength(cur);
    ball.style.transform = `translate(${pt.x}px,${pt.y}px) scale(${radius(cur) / 50})`;
    lit.style.strokeDashoffset = total - cur;
    for (const g of gates) g.el.classList.toggle(g.cls, cur >= g.len);
    const f = Math.min(1, Math.max(0, (cur - typing.a) / (typing.b - typing.a)));
    const n = Math.round(f * 1.04 * query.length);
    if (qtext.textContent.length !== Math.min(n, query.length))
      qtext.textContent = query.slice(0, n);
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - then) / 1000 || 0.016);
    then = now;
    const gap = target(scrollY) - cur;
    // The ball follows the scroll like something with weight: it closes the gap fast, but never
    // faster than a rolling ball could, unless it has fallen far behind.
    const most = Math.max(2600, Math.abs(gap) * 4) * dt;
    cur += Math.max(-most, Math.min(most, gap * (1 - Math.exp(-dt * 11))));
    if (Math.abs(gap) < 0.4) cur += gap;
    draw();
    frame = Math.abs(target(scrollY) - cur) > 0.01 ? requestAnimationFrame(tick) : 0;
  }

  function wake() {
    if (!frame) {
      then = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  function rebuild() {
    build();
    cur = target(scrollY);
    draw();
  }

  rebuild();
  addEventListener("scroll", wake, { passive: true });
  new ResizeObserver(rebuild).observe(page);
  document.addEventListener("rooms", rebuild);
  document.fonts?.ready.then(rebuild);
  still.addEventListener("change", () => location.reload());
}
