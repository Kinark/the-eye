// Draw a corner, and let the-eye's own corner reader (src/still.ts, served as /lib/still.js) say what it is. The reader
// only gets pixels: the same call the server makes on a window that is holding still.
import { readCorner } from "/lib/still.js";
import { squirclePath } from "./squircle.js";

const $ = (id) => document.getElementById(id);
const GREY = "#808080", WHITE = "#F4F4F2";

/** Paint one shape on the recording grey and read its corner back off the pixels. */
function paintAndRead(c, w, h, dpr, box, path) {
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = GREY;
  c.fillRect(0, 0, w, h);
  c.fillStyle = WHITE;
  c.fill(new Path2D(path));
  const px = c.getImageData(0, 0, Math.round(w * dpr), Math.round(h * dpr));
  return readCorner({ w: px.width, h: px.height, data: px.data, scale: dpr, x: 0, y: 0 }, box);
}

const say = (read) => {
  if (!read) return "nothing the reader will commit to";
  if (read.kind === "square") return "square, no corner to speak of";
  if (read.kind === "capsule") return `r≈${Math.round(read.radius_pt)} capsule, the ends are half the height`;
  const shape = read.kind === "continuous" ? "continuous" : "circular arc";
  return `r≈${Math.round(read.radius_pt)} ${shape}\nexponent ${read.n.toFixed(2)}, the edge starts to turn ${Math.round(read.reach_pt)}pt from the corner`;
};

export function corner() {
  const canvas = $("corner-canvas"), nIn = $("c-n"), rIn = $("c-r"), out = $("corner-read");
  const c = canvas.getContext("2d", { willReadFrequently: true });
  let queued = false;

  function draw() {
    queued = false;
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const n = +nIn.value, inset = Math.round(w * 0.18);
    const box = { x: inset, y: inset, w: w - 2 * inset, h: h - 2 * inset };
    const r = Math.min(+rIn.value, box.w / 2 - 8);
    nIn.nextElementSibling.textContent = n.toFixed(2);
    rIn.nextElementSibling.textContent = `${Math.round(r)}pt`;
    const read = paintAndRead(c, w, h, dpr, box, squirclePath(box.w, box.h, r, n, 1, box.x, box.y));
    // Only now, after the read, the comparison: the circular arc with the same corner box.
    c.strokeStyle = "rgba(11, 11, 12, 0.35)";
    c.lineWidth = 1;
    c.stroke(new Path2D(squirclePath(box.w, box.h, r, 2, 1, box.x, box.y)));
    const text = say(read);
    if (out.textContent !== text) out.textContent = text;
    out.classList.toggle("caught", read?.kind === "continuous");
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  nIn.addEventListener("input", queue);
  rIn.addEventListener("input", queue);
  new ResizeObserver(queue).observe(canvas);

  // The page's own plates, handed to the same reader.
  const off = document.createElement("canvas");
  off.width = 760; off.height = 560;
  const own = paintAndRead(off.getContext("2d"), 380, 280, 2, { x: 40, y: 40, w: 300, h: 200 }, squirclePath(300, 200, 40, undefined, undefined, 40, 40));
  $("corner-self").textContent = own
    ? `This page's own plates, handed to the same reader: ${own.kind}, exponent ${own.n.toFixed(2)}, r≈${Math.round(own.radius_pt)}.`
    : "The reader would not commit to a shape for this page's own plates.";
}
