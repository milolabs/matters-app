// The run: the ball leaves the mark in the hero and rides one rope down the page, through the
// pieces of the app, into the mark at the bottom. Scrolling moves it. Where the rope goes is read
// from where the pieces sit, so it holds at any width. Without this file, or with reduced motion,
// the page shows every piece in its finished state.

const root = document.documentElement;
const still = matchMedia("(prefers-reduced-motion: reduce)");

if (!still.matches && "getPointAtLength" in SVGPathElement.prototype) start();

function start() {
  const $ = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => [...p.querySelectorAll(s)];

  const page = $("#page");
  const base = $("#track-base");
  const lit = $("#track-lit");
  const ball = $("#ball");
  const qtext = $("#qtext");
  const query = qtext.textContent;
  const R = 13; // the ball on its way, in px

  root.classList.add("run");

  let keys = []; // { len, at }: the ball is `len` along the rope when the page is scrolled to `at`
  let gates = []; // { len, el, cls }: `el` gets `cls` once the ball is past `len`
  let typing = null; // { a, b }: the stretch of rope along the prompt
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
      const b = box(el);
      return { x: b.l + b.w * ax + dx, y: b.t + b.h * ay + dy };
    };
    const mid = (el) => at(el, 0.5, 0.5);
    const edge = Math.min(46, o.width * 0.05);
    // How far outside a piece the ball can pass without leaving the page.
    const side = Math.max(4, Math.min(20, box($("#qbar")).l - R - 3));

    let d = "";
    let p = null;
    let dir = "v"; // how the ball is moving at `p`: down, right or left
    keys = [];
    gates = [];

    const len = () => {
      base.setAttribute("d", d);
      return base.getTotalLength();
    };
    const key = () => keys.push({ len: len(), y: p.y });
    const gate = (el, cls = "on") => {
      const at = len() - 2;
      for (const e of [el].flat()) gates.push({ len: at, el: e, cls });
    };

    // A drop: leaves the way the ball is moving, arrives straight down.
    const fall = (to) => {
      const k = Math.max(50, Math.abs(to.y - p.y) * 0.45);
      const c1 =
        dir === "v" ? { x: p.x, y: p.y + k } : { x: p.x + (dir === "r" ? edge : -edge), y: p.y };
      d += `C${c1.x} ${c1.y} ${to.x} ${to.y - k} ${to.x} ${to.y}`;
      p = to;
      dir = "v";
    };
    // A drop that turns onto a level surface and rolls on, right or left.
    const chute = (to, way) => {
      const q = 26;
      const s = way === "r" ? -1 : 1;
      fall({ x: to.x + s * q, y: to.y - q });
      d += `Q${to.x + s * q} ${to.y} ${to.x} ${to.y}`;
      p = to;
      dir = way;
    };
    const line = (to) => {
      d += `L${to.x} ${to.y}`;
      if (Math.abs(to.x - p.x) > Math.abs(to.y - p.y)) dir = to.x > p.x ? "r" : "l";
      else dir = "v";
      p = to;
    };
    const hop = (to, h = 26) => {
      // Straight down to the next row: lean out, so it reads as a hop and not a line.
      const lean = Math.abs(to.x - p.x) < 20 ? 3 * h : 0;
      d += `Q${(p.x + to.x) / 2 + lean} ${Math.min(p.y, to.y) - 2 * h} ${to.x} ${to.y}`;
      p = to;
      dir = "v";
    };
    const loop = (r) => {
      d += `A${r} ${r} 0 0 0 ${p.x} ${p.y - 2 * r}A${r} ${r} 0 0 0 ${p.x} ${p.y}`;
    };

    // Out of the mark.
    const hero = box($("#hero-ball"));
    r0 = hero.w / 2;
    p = { x: hero.l + r0, y: hero.t + r0 };
    d = `M${p.x} ${p.y}`;
    key();

    // 01: along the prompt, which is typed as the ball rolls over it.
    const bar = $("#qbar");
    chute(at(bar, 0, 0, 30, -R), "r");
    key();
    const a = len();
    line(at(bar, 1, 0, -30, -R));
    key();
    typing = { a, b: len() };
    gate($("#res"));
    // Off the end and down the outside of the piece, so it does not cross what it found.
    fall(at(bar.parentElement, 1, 1, side, 0));
    key();

    // 02: onto "Save view", then from tab to tab. The strip is cut off on the left, as if torn
    // from a wider window: only the tabs in sight count.
    const strip = box($("#tabs"));
    $$("#tabs .tab")
      .reverse()
      .filter((t) => at(t, 0.5, 0).x > strip.l + 24)
      .forEach((t, i) => {
        const top = at(t, 0.5, 0, 0, -R);
        if (i) hop(top);
        else fall(top);
        key();
        gate(t);
      });
    dir = "l";

    // 03: down the runtimes, one socket each.
    $$("#runtimes .sock").forEach((s, i) => {
      if (i) line(mid(s));
      else fall(mid(s));
      key();
      gate(s.parentElement);
    });

    // 04: the ramp. Two keys close together: a little scroll, a long way.
    const ramp = box($("#ramp"));
    const from = { x: ramp.l + 30, y: ramp.t + ramp.h - 46 };
    const to = { x: ramp.l + ramp.w, y: ramp.t + ramp.h - 6 };
    const on = (f) => ({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
    const budgets = $$(".budget");
    chute(from, "r");
    key();
    line(on(0.22));
    gate(budgets[0]);
    line(on(0.5));
    if (ramp.w > 620) loop(48);
    gate(budgets[1]);
    line(on(0.8));
    gate(budgets[2]);
    line(to);
    key();

    // 05: down the seam of the hive and through the core.
    const hive = $("#hive");
    const tiles = $$("#hive .tile");
    fall(at(hive, 0.5, 0, 0, 6));
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

    // 06: along the top of the terminal, right to left, a line at a time.
    const term = $("#term");
    const lines = $$("#term .t-l");
    chute(at(term, 1, 0, -30, -R), "l");
    key();
    lines.forEach((l, i) => {
      const f = 1 - (i + 1) / lines.length;
      line(at(term, f, 0, f ? 0 : -4, -R));
      gate(l);
    });
    key();
    fall(at(term, 0, 1, -side, 0));
    key();

    // 07: across what is not built yet.
    // Where they wrap into rows, it runs each row the other way, like a marble run.
    const rows = new Map();
    for (const t of $$(".soon-tile")) {
      const y = Math.round(box(t).t);
      rows.set(y, [...(rows.get(y) ?? []), t]);
    }
    const snake = [...rows.values()].flatMap((row, i) => (i % 2 ? row.reverse() : row));
    snake.forEach((t, i) => {
      const top = at(t, 0.5, 0, 0, -R);
      if (i) hop(top);
      else fall(top);
      key();
      gate(t);
    });
    dir = rows.size % 2 ? "r" : "l";

    // Into the mark.
    lastLeg = len();
    const end = box($("#end-ball"));
    r1 = end.w / 2;
    fall({ x: end.l + r1, y: end.t + r1 });
    key();
    gate(ball, "home");

    total = len();
    lit.setAttribute("d", d);
    lit.style.strokeDasharray = total;

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
  document.fonts?.ready.then(rebuild);
  still.addEventListener("change", () => location.reload());
}
