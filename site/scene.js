// The other world behind the page: one office, seen from above, a room of it between each two
// sections. The ball of run.js drops into a room, rolls across it and leaves it changed: the
// pile is sorted, the drawer is open, the light is on. A line under each room says what was the
// matter and what became of it. Cables on the floor (drawn by run.js) join the rooms.
// Decoration only: without this file the page is whole.

const COS = Math.cos(Math.PI / 6);
const NS = "http://www.w3.org/2000/svg";
const narrow = matchMedia("(max-width: 860px)");

// One box: where it stands (x, y, z), its size (w, d, h), and optionally how it takes part.
//   c:    "lit" turns violet when the ball has been; "hid" appears then; "away" is gone then;
//         "dash" is not built yet.
//   from: where it is before the ball comes, as an offset in the room.
//   i:    its turn, when several things happen one after another.
const b = (x, y, z, w, d, h, o = {}) => ({ x, y, z, w, d, h, ...o });

// A table: four legs and a top. Everything else stands on `top`.
const table = (w, d, top) => [
  b(0, 0, 0, 5, 5, top - 5),
  b(w - 5, 0, 0, 5, 5, top - 5),
  b(0, d - 5, 0, 5, 5, top - 5),
  b(w - 5, d - 5, 0, 5, 5, top - 5),
  b(-6, -6, top - 5, w + 12, d + 12, 5),
];

// A room: `size` is its floor, `on` the height of the surface the ball rolls on, `run` where it
// rolls (from x, at y, to x), `was` and `now` the line under it before and after.
const ROOMS = {
  // The morning's mail on a desk. After: one letter left, the lamp on.
  desk: {
    size: [240, 100],
    on: 60,
    run: [6, 86, 234],
    was: "09:02 · 212 unread",
    now: "09:02 · 3 need you",
    boxes: [
      ...table(240, 100, 60),
      b(128, 14, 60, 36, 16, 3),
      b(100, 20, 63, 92, 4, 58),
      b(160, 30, 60, 64, 48, 4),
      b(164, 34, 64, 56, 40, 3),
      b(166, 36, 67, 56, 40, 3, { c: "away", i: 3 }),
      b(162, 33, 70, 56, 40, 3, { c: "away", i: 2 }),
      b(168, 37, 73, 56, 40, 3, { c: "away", i: 1 }),
      b(164, 34, 76, 56, 40, 3, { c: "away", i: 0 }),
      b(12, 12, 60, 16, 16, 3),
      b(18, 18, 63, 4, 4, 44),
      b(4, 10, 107, 30, 20, 7, { c: "lit" }),
    ],
  },
  // The cabinet where things get lost. After: a drawer is open and what was asked for stands up.
  files: {
    size: [230, 64],
    on: 84,
    run: [8, 30, 222],
    was: "where is that invoice?",
    now: "found · 3 of 212",
    boxes: [
      b(0, 0, 0, 230, 60, 84),
      b(8, 60, 10, 66, 4, 64),
      b(152, 60, 10, 66, 4, 64),
      b(80, 60, 10, 66, 44, 64, { from: [0, -40, 0] }),
      b(90, 74, 74, 46, 3, 24, { c: "hid lit", i: 1 }),
      b(90, 84, 74, 46, 3, 18, { c: "hid", i: 2 }),
    ],
  },
  // A shelf of trays, one for each saved view. After: the letter is in its tray.
  trays: {
    size: [244, 86],
    on: 44,
    run: [6, 70, 238],
    was: "ask again tomorrow?",
    now: "saved · it keeps reading",
    boxes: [
      b(0, 0, 0, 244, 86, 44),
      b(10, 8, 44, 48, 36, 10),
      b(68, 8, 44, 48, 36, 10),
      b(126, 8, 44, 48, 36, 10),
      b(184, 8, 44, 48, 36, 10),
      b(131, 12, 54, 38, 28, 2, { c: "lit", from: [0, 0, 46] }),
    ],
  },
  // The machines the agent runs on, on your own desk. After: their lights are on.
  machines: {
    size: [240, 100],
    on: 56,
    run: [6, 84, 234],
    was: "your machines · idle",
    now: "your machines · working",
    boxes: [
      ...table(240, 100, 56),
      b(16, 10, 56, 52, 46, 78),
      b(68, 18, 116, 1, 8, 4, { c: "lit", i: 0 }),
      b(68, 18, 100, 1, 8, 4, { c: "lit", i: 1 }),
      b(68, 18, 84, 1, 8, 4, { c: "lit", i: 2 }),
      b(98, 14, 56, 46, 42, 13),
      b(144, 22, 61, 1, 8, 3, { c: "lit", i: 3 }),
      b(166, 12, 56, 58, 4, 40, { c: "lit", i: 4 }),
      b(166, 16, 56, 58, 36, 3),
    ],
  },
  // A belt. After: the parcels have moved on.
  belt: {
    size: [260, 74],
    on: 34,
    run: [6, 60, 254],
    was: "waiting on the network",
    now: "already here",
    boxes: [
      b(0, 0, 0, 260, 74, 34),
      b(40, 8, 34, 32, 32, 24, { from: [-34, 0, 0] }),
      b(116, 8, 34, 40, 32, 16, { from: [-34, 0, 0], i: 1 }),
      b(200, 8, 34, 30, 32, 30, { from: [-34, 0, 0], i: 2 }),
    ],
  },
  // A bench with a row of adapters. After: one more has dropped into its place.
  bench: {
    size: [240, 100],
    on: 56,
    run: [6, 84, 150],
    was: "one more adapter",
    now: "plugged in",
    boxes: [
      ...table(240, 100, 56),
      b(24, 12, 56, 40, 40, 26),
      b(68, 12, 56, 40, 40, 26),
      b(112, 12, 56, 40, 40, 26, { c: "lit", from: [0, 0, 52] }),
      b(156, 12, 56, 40, 40, 26, { c: "dash" }),
    ],
  },
  // What is not unpacked yet.
  crates: {
    size: [250, 104],
    on: 8,
    run: [6, 88, 244],
    was: "not unpacked yet",
    now: "not unpacked yet",
    boxes: [
      b(0, 0, 0, 250, 104, 8),
      b(18, 10, 8, 62, 52, 52, { c: "dash" }),
      b(92, 10, 8, 52, 52, 36, { c: "dash" }),
      b(158, 10, 8, 72, 52, 64, { c: "dash" }),
    ],
  },
  // The desk again, in the evening. After: the tray is empty and the screen says so.
  outbox: {
    size: [240, 100],
    on: 60,
    run: [6, 86, 234],
    was: "17:40 · 3 drafts ready",
    now: "17:41 · sent by you",
    boxes: [
      ...table(240, 100, 60),
      b(20, 16, 60, 60, 44, 9),
      b(28, 22, 69, 44, 30, 2, { c: "away" }),
      b(128, 14, 60, 36, 16, 3),
      b(100, 20, 63, 92, 4, 58, { c: "lit", i: 1 }),
      b(208, 22, 60, 16, 16, 18),
    ],
  },
};

// Which section a room sits above; then, on a wide page and on a narrow one, how far across the
// point is where the ball lands in it, and whether the room is mirrored (the ball then rolls
// left). run.js moves three of them to stand right under the ball instead.
const PLACES = [
  ["desk", "#ask", [78, true], [40, false]],
  ["files", "#keep", [3, false], [8, false]],
  ["trays", "#agents", [93, true], [90, true]],
  ["machines", "#speed", [51, true], [10, false]],
  ["belt", "#extend", [93, true], [93, true]],
  ["bench", "#next", [71, false], [50, false]],
  ["crates", "#open", [9, false], [14, false]],
  ["outbox", "#get", [93, true], [90, true]],
];

function draw(name, flip) {
  const room = ROOMS[name];
  const at = (x, y, z) => [(flip ? -1 : 1) * (x - y) * COS, (x + y) / 2 - z];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const see = (p) => {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
    return p.map((n) => n.toFixed(1)).join(",");
  };
  const el = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const svg = el("svg", { class: "sc", "aria-hidden": "true" });

  // The floor the room stands on: the cables run from one floor to the next.
  const [fw, fd] = room.size;
  const m = 26;
  const floor = [at(-m, -m, 0), at(fw + m, -m, 0), at(fw + m, fd + m, 0), at(-m, fd + m, 0)];
  svg.append(el("polygon", { class: "floor", points: floor.map(see).join(" ") }));

  for (const { x, y, z, w, d, h, c, from, i } of room.boxes) {
    const g = el("g");
    const faces = [
      // The side toward +y, the side toward +x, the top: the three that face the viewer.
      [at(x, y + d, z), at(x + w, y + d, z), at(x + w, y + d, z + h), at(x, y + d, z + h)],
      [at(x + w, y, z), at(x + w, y + d, z), at(x + w, y + d, z + h), at(x + w, y, z + h)],
      [at(x, y, z + h), at(x + w, y, z + h), at(x + w, y + d, z + h), at(x, y + d, z + h)],
    ];
    faces.forEach((face, n) => {
      g.append(el("polygon", { points: face.map(see).join(" "), class: n === 2 ? "top" : "" }));
    });
    if (c) g.setAttribute("class", c);
    if (from) {
      const [mx, my] = at(...from);
      g.classList.add("mv");
      g.style.setProperty("--mx", `${mx.toFixed(1)}px`);
      g.style.setProperty("--my", `${my.toFixed(1)}px`);
    }
    if (i) g.style.setProperty("--i", i);
    svg.append(g);
  }

  // The line beside the room, at the corner the ball leaves by.
  const corner = floor[1];
  for (const [cls, words] of [
    ["was", room.was],
    ["now", room.now],
  ]) {
    const text = el("text", {
      class: cls,
      x: (corner[0] + (flip ? -12 : 12)).toFixed(1),
      y: (corner[1] + 4).toFixed(1),
      "text-anchor": flip ? "end" : "start",
    });
    text.textContent = words;
    svg.append(text);
  }

  const [run0, y, run1] = room.run;
  const a = at(run0, y, room.on);
  svg.dataset.a = a.join(",");
  svg.dataset.b = at(run1, y, room.on).join(",");
  svg.dataset.in = floor[0].join(",");
  svg.dataset.out = floor[2].join(",");
  svg.dataset.scene = name;
  // Room above for what rises.
  svg.setAttribute("viewBox", `${x0 - 2} ${y0 - 60} ${x1 - x0 + 4} ${y1 - y0 + 64}`);
  svg.style.setProperty("--w", Math.round(x1 - x0 + 4));
  svg.style.setProperty("--ax", Math.round(a[0] - x0 + 2));
  return svg;
}

function furnish() {
  for (const old of document.querySelectorAll(".sc")) old.remove();
  for (const [name, where, wide, small] of PLACES) {
    const section = document.querySelector(where);
    if (!section) continue;
    const [across, flip] = narrow.matches ? small : wide;
    const svg = draw(name, flip);
    svg.style.setProperty("--at", `${across}%`);
    section.prepend(svg);
  }
  document.dispatchEvent(new Event("rooms"));
}

furnish();
narrow.addEventListener("change", furnish);
