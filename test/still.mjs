// node test/still.mjs — the maths on a still frame (src/still.ts), on drawn pixels and made-up frames: no screen needed.
import { contrast, elements, readCorner, readLayout, readText, still } from "../src/still.ts";

let failed = 0, n = 0;
const want = (what, ok, got) => { n++; console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `  (got ${JSON.stringify(got)})`}`); if (!ok) failed++; };
const near = (x, truth, tol) => Math.abs(x - truth) <= tol;

// A 2x canvas with 4x4 supersampled shapes, blended in sRGB the way a screen shot arrives.
function canvas(wPt, hPt, bg = [255, 255, 255]) {
  const scale = 2, w = wPt * scale, h = hPt * scale, data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4);
  const img = { w, h, data, scale, x: 100, y: 50 }; // the image starts at global (100,50): frames are global
  /** Fill where inside(xPt, yPt) holds, in points local to the image. */
  img.fill = (inside, c, box = [0, 0, wPt, hPt]) => {
    for (let y = Math.floor(box[1] * scale); y < Math.ceil((box[1] + box[3]) * scale); y++) for (let x = Math.floor(box[0] * scale); x < Math.ceil((box[0] + box[2]) * scale); x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside((x + (sx + 0.5) / 4) / scale, (y + (sy + 0.5) / 4) / scale)) hit++;
      if (!hit) continue;
      const i = (y * w + x) * 4, t = hit / 16;
      for (let k = 0; k < 3; k++) data[i + k] = Math.round(data[i + k] * (1 - t) + c[k] * t);
    }
  };
  return img;
}
/** A rounded box: |dx|^n + |dy|^n <= r^n inside each corner square of side r. */
const rounded = (x, y, w, h, r, n) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const dx = Math.max(0, x + r - px, px - (x + w - r)), dy = Math.max(0, y + r - py, py - (y + h - r));
  return dx ** n + dy ** n <= r ** n;
};
const el = (name, role, x, y, w, h) => ({ name: `"${name}"`, label: name, role, isText: role === "AXStaticText", leaf: true, x: x + 100, y: y + 50, w, h, parent: 0, win: 0 });

// ---- corners
{
  const img = canvas(520, 120), red = [217, 64, 77];
  img.fill(rounded(10, 10, 120, 80, 16, 2), red, [10, 10, 120, 80]);
  img.fill(rounded(140, 10, 120, 80, 24, 5), red, [140, 10, 120, 80]);
  img.fill(rounded(270, 10, 120, 80, 40, 2), red, [270, 10, 120, 80]);
  img.fill(rounded(400, 10, 100, 80, 0.001, 2), red, [400, 10, 100, 80]);
  const arc = readCorner(img, el("arc", "AXImage", 10, 10, 120, 80));
  want("a circular corner is called circular", arc?.kind === "circular", arc);
  want("its radius is read to half a point (16)", arc && near(arc.radius_pt, 16, 0.5), arc);
  want("its fitted exponent is 2", arc && near(arc.n, 2, 0.1), arc);
  const sq = readCorner(img, el("squircle", "AXImage", 140, 10, 120, 80));
  want("a superellipse corner is called continuous", sq?.kind === "continuous", sq);
  want("its exponent is well above an arc's (5)", sq && sq.n > 4, sq);
  const pill = readCorner(img, el("pill", "AXImage", 270, 10, 120, 80));
  want("a radius of half the height is a capsule", pill?.kind === "capsule", pill);
  const box = readCorner(img, el("box", "AXImage", 400, 10, 100, 80));
  want("a sharp corner is square", box?.kind === "square", box);
  want("nothing painted there: no corner claimed", readCorner(img, el("empty", "AXImage", 30, 95, 60, 24)) === undefined);
  // One corner hidden behind something else: the other three still agree.
  img.fill((px, py) => px < 30 && py < 30, [20, 20, 30], [0, 0, 30, 30]);
  const hid = readCorner(img, el("arc", "AXImage", 10, 10, 120, 80));
  want("three clean corners outvote a covered one", hid?.kind === "circular" && near(hid.radius_pt, 16, 0.5), hid);
}

// ---- text: block capitals of a known cap height, in a known colour
{
  const img = canvas(300, 120, [255, 255, 255]);
  const word = (x, y, cap, c, frameH) => {
    for (let i = 0; i < 6; i++) img.fill((px, py) => px >= x + i * cap * 0.8 && px < x + i * cap * 0.8 + cap * 0.18 && py >= y && py < y + cap, c, [x, y - 1, 6 * cap, cap + 2]);
    img.fill((px, py) => px >= x && px < x + 5 * cap * 0.8 && py >= y + cap - cap * 0.15 && py < y + cap, c, [x, y, 6 * cap, cap + 1]);
    return el("HELLO", "AXStaticText", x - 1, y - (frameH - cap) / 2, 6 * cap * 0.8 + 2, frameH);
  };
  const big = readText(img, word(10, 12, 0.72 * 20, [0, 0, 0], 26));
  want("20pt capitals read as 20pt (±1)", big && near(big.size_pt, 20, 1), big?.size_pt);
  want("black on white is 21:1", big && near(big.contrast, 21, 0.3), big?.contrast);
  const small = readText(img, word(10, 50, 0.72 * 9, [0, 0, 0], 12));
  want("9pt capitals read as 9pt (±0.7)", small && near(small.size_pt, 9, 0.7), small?.size_pt);
  const faint = readText(img, word(10, 80, 0.72 * 13, [158, 158, 158], 17));
  want("#9e9e9e on white reads 2.68:1 (±0.1)", faint && near(faint.contrast, 2.68, 0.1), faint?.contrast);
  want("an empty frame has no text to read", readText(img, el("ghost", "AXStaticText", 200, 10, 80, 20)) === undefined);
  want("contrast() matches WCAG on a known pair", near(contrast([119, 119, 119], [255, 255, 255]), 4.48, 0.01));
}

// ---- layout, from frames alone
{
  const win = { name: "Window", label: "", role: "AXWindow", isText: false, leaf: false, x: 0, y: 0, w: 400, h: 300, parent: -1, win: 0 };
  const E = (name, x, y, w, h, role = "AXButton") => ({ name: `"${name}"`, label: name, role, isText: role === "AXStaticText", leaf: true, x, y, w, h, parent: 0, win: 0 });
  const kinds = (list) => readLayout([win, ...list]);
  const has = (f, kind, re) => f.some((x) => x.kind === kind && re.test(x.text));

  let f = kinds([E("A", 20, 20, 60, 30), E("B", 92, 20, 60, 30), E("C", 164, 20, 60, 30), E("D", 239, 20, 60, 30)]);
  want("gaps 12, 12, 15 in a row are called uneven", has(f, "gaps", /12, 12, 15pt/), f);
  f = kinds([E("A", 20, 20, 60, 30), E("B", 92, 20, 60, 30), E("C", 164, 20, 60, 30), E("D", 236, 20, 60, 30)]);
  want("even gaps say nothing", f.length === 0, f);
  f = kinds([E("A", 20, 20, 60, 30), E("B", 92, 20, 60, 30), E("C", 300, 20, 60, 30)]);
  want("a deliberate big gap is not an uneven one", !has(f, "gaps", /./), f);

  f = kinds([E("Top", 20, 20, 100, 24), E("Mid", 20, 54, 100, 24), E("Off", 22, 88, 100, 24)]);
  want("the one that is 2pt off is named, once", f.filter((x) => x.kind === "align").length === 1 && has(f, "align", /^"Off" left edge at x 22, 2pt off/), f);
  f = kinds([E("Top", 20, 20, 100, 24), E("Mid", 20, 54, 140, 24), E("Low", 20, 88, 80, 24)]);
  want("left-aligned things of different widths say nothing", f.length === 0, f);
  f = kinds([E("L", 20, 20, 60, 30), E("R", 100, 21.5, 60, 30)]);
  want("side by side, 1.5pt apart in height: almost aligned", has(f, "align", /top edge.*1\.5pt off/), f);
  f = kinds([E("Far", 20, 20, 60, 30), E("Away", 22, 250, 60, 30)]);
  want("things far apart are not compared", f.length === 0, f);
  f = kinds([E("Big", 20, 20, 30, 14, "AXStaticText"), E("Small", 60, 22.5, 30, 9, "AXStaticText")]);
  want("two texts of different sizes on a line (baseline-aligned) say nothing", f.length === 0, f);

  f = kinds([E("Back", 100, 100, 80, 40), E("Front", 170, 120, 80, 40)]);
  want("a shared 10×20 is reported as overlap", has(f, "overlap", /share 10×20pt/), f);
  f = kinds([E("Edge", 350, 100, 80, 20)]);
  want("30pt past the right edge is cut off", has(f, "cut", /30pt past the window's right edge/), f);
  f = kinds([E("Gone", 900, 100, 80, 20)]);
  want("entirely outside the window: not judged", f.length === 0, f);
}

// ---- the whole reading, from an accessibility tree
{
  const img = canvas(200, 100);
  img.fill(rounded(20, 20, 80, 40, 10, 2), [30, 90, 220], [20, 20, 80, 40]);
  const tree = [{ app: "T", tree: { role: "AXWindow", title: "T", frame: [100, 50, 200, 100], children: [
    { role: "AXGroup", frame: [100, 50, 200, 100], children: [{ role: "AXButton", title: "Go", frame: [120, 70, 80, 40] }] },
    { role: "AXButton", frame: [0, 0, 0, 0] },
  ] } }];
  const els = elements(tree);
  want("elements() keeps framed nodes and their nearest framed parent", els.length === 3 && els[2].parent === 1 && els[2].win === 0 && !els[1].leaf && els[2].leaf, els);
  const s = still(img, tree);
  want("the reading names the corner", /corners: r≈10 circular arc — "Go"/.test(s.text), s.text);
  want("and has a heading that says how it was measured", s.text.startsWith("## at rest"), s.text);
  want("nothing readable: no text at all", still(canvas(50, 50), [{ tree: { role: "AXWindow", frame: [100, 50, 50, 50] } }]).text === "", null);
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
