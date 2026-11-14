// The fit runs here, off the main thread: this page is being watched, and a fit takes longer than a frame.
import { fitMotion, formatFit } from "/lib/physics.js";

onmessage = (e) => {
  const { id, samples, period } = e.data, t0 = performance.now();
  const fit = fitMotion(samples, period);
  postMessage({
    id,
    lines: fit ? formatFit(fit, { from: "the puck's left edge, frame by frame" }) : null,
    ms: performance.now() - t0,
    frames: samples.length - 1,
  });
};
