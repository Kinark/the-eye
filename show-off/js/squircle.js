// Continuous corners. CSS can only cut a circular arc (corner-shape is Chromium-only), so every plate, button and
// puck gets its outline as a path: straight sides joined by superellipse corners, |x|^n + |y|^n = a^n with n = 5.
// The corner section of the page hands these same shapes to the-eye's corner reader, which calls them continuous.

export const EXPONENT = 5;
/** A continuous corner reaches further along the side than its nominal radius: this far. */
export const REACH = 1.5;

/** The outline of a w×h box whose corners have nominal radius r, as SVG path data. */
export function squirclePath(w, h, r, n = EXPONENT, reach = REACH, ox = 0, oy = 0) {
  const a = Math.max(0, Math.min(r * reach, w / 2, h / 2)), e = 2 / n, STEPS = 14;
  const f = (v) => (ox + v).toFixed(2), g = (v) => (oy + v).toFixed(2);
  // One corner: centre (cx, cy), swept from the direction (ux, uy) to the direction (vx, vy).
  const corner = (cx, cy, ux, uy, vx, vy) => {
    let d = "";
    for (let i = 1; i <= STEPS; i++) {
      const th = (i / STEPS) * (Math.PI / 2), p = a * Math.pow(Math.cos(th), e), q = a * Math.pow(Math.sin(th), e);
      d += `L${f(cx + ux * p + vx * q)} ${g(cy + uy * p + vy * q)}`;
    }
    return d;
  };
  return `M${f(a)} ${g(0)}L${f(w - a)} ${g(0)}` + corner(w - a, a, 0, -1, 1, 0)
    + `L${f(w)} ${g(h - a)}` + corner(w - a, h - a, 1, 0, 0, 1)
    + `L${f(a)} ${g(h)}` + corner(a, h - a, 0, 1, -1, 0)
    + `L${f(0)} ${g(a)}` + corner(a, a, -1, 0, 0, -1) + "Z";
}

/** Cut every [data-squircle="radius"] under `root` to its shape, and keep it cut as it resizes. */
export function cutAll(root = document) {
  const ro = new ResizeObserver((entries) => {
    for (const en of entries) {
      const el = en.target, box = en.borderBoxSize?.[0];
      const w = box ? box.inlineSize : el.offsetWidth, h = box ? box.blockSize : el.offsetHeight;
      if (w > 0 && h > 0) el.style.clipPath = `path("${squirclePath(w, h, Number(el.dataset.squircle))}")`;
    }
  });
  for (const el of root.querySelectorAll("[data-squircle]")) ro.observe(el);
}
