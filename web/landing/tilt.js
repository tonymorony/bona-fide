// Tilts the hero's certificate gently toward the pointer, with a glare that follows it. Only for a
// fine pointer that can hover, and never when the visitor asks for less motion. It sets CSS custom
// properties through the CSSOM, which the Content-Security-Policy allows; landing.css does the rest.

const MAX_DEG = 6.5;
// The share of the remaining distance the card covers in one 60 Hz frame, whatever the frame rate.
const EASE_PER_FRAME = 0.12;
const FRAME_MS = 1000 / 60;

const card = document.querySelector("[data-tilt]");
// The wrapper doesn't tilt, so the pointer stays over it even near the card's edges.
const area = card?.closest(".cert-float") ?? card;
if (card) {
  const pointer = matchMedia("(hover: hover) and (pointer: fine)");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const target = { x: 0, y: 0, lift: 0 };
  const now = { x: 0, y: 0, lift: 0 };
  let frame = 0;
  let last = 0;

  const write = () => {
    card.style.setProperty("--rx", `${(-now.y * MAX_DEG).toFixed(3)}deg`);
    card.style.setProperty("--ry", `${(now.x * MAX_DEG).toFixed(3)}deg`);
    card.style.setProperty("--lift", now.lift.toFixed(3));
    card.style.setProperty("--gx", `${((now.x + 1) * 50).toFixed(1)}%`);
    card.style.setProperty("--gy", `${((now.y + 1) * 50).toFixed(1)}%`);
  };

  const step = (time) => {
    const elapsed = last ? Math.min(time - last, 100) : FRAME_MS;
    last = time;
    const ease = 1 - (1 - EASE_PER_FRAME) ** (elapsed / FRAME_MS);
    let moving = false;
    for (const key of ["x", "y", "lift"]) {
      now[key] += (target[key] - now[key]) * ease;
      if (Math.abs(target[key] - now[key]) > 0.001) moving = true;
      else now[key] = target[key];
    }
    write();
    if (moving) frame = requestAnimationFrame(step);
    else frame = last = 0;
  };
  const run = () => {
    if (!frame) frame = requestAnimationFrame(step);
  };

  const fromMouse = (event) => event.pointerType === "mouse" || event.pointerType === "pen";
  const onMove = (event) => {
    if (!fromMouse(event)) return;
    const box = area.getBoundingClientRect();
    target.x = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
    target.y = Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height) * 2 - 1));
    target.lift = 1;
    run();
  };
  const onLeave = (event) => {
    if (!fromMouse(event)) return;
    target.x = 0;
    target.y = 0;
    target.lift = 0;
    run();
  };

  let on = false;
  const update = () => {
    const wanted = pointer.matches && !still.matches;
    if (wanted === on) return;
    on = wanted;
    if (on) {
      area.addEventListener("pointermove", onMove);
      area.addEventListener("pointerleave", onLeave);
      return;
    }
    area.removeEventListener("pointermove", onMove);
    area.removeEventListener("pointerleave", onLeave);
    cancelAnimationFrame(frame);
    frame = last = 0;
    Object.assign(target, { x: 0, y: 0, lift: 0 });
    Object.assign(now, target);
    for (const name of ["--rx", "--ry", "--lift", "--gx", "--gy"]) card.style.removeProperty(name);
  };
  pointer.addEventListener("change", update);
  still.addEventListener("change", update);
  update();
}
