/**
 * The tasks as lights in the scene: each active task is a lantern (a boat on the
 * lake, a window on the rooftop, a soft light over your own picture). This keeps
 * only what every scene needs, with no drawing: which lights exist, a place for
 * each that doesn't change while it's alive, and how lit it is right now, eased
 * so a light kindles and goes out rather than switching.
 *
 * `set` takes [[id, state, hot], ...], state being 'working', 'needs', 'unread'
 * or 'idle', and hot meaning it's the task you're on or pointing at.
 */

export const FLEET_MAX = 12;

// How lit each state is (0..1). A task that needs you is the brightest thing on the water.
const LIT = { working: 0.72, needs: 1, unread: 0.5, idle: 0.3 };
const HOT = 0.22;
// How fast it eases, per second: lights come up gently and go out slower still.
const RISE = 2.4;
const FALL = 1.3;
const FLARE = 3;
const ROW = 1.2;

const ease = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));

// Evenly scattered and never repeating: two lights never land close together until there are many.
const scatter = (slot, step, start) => (start + slot * step) % 1;

export function createFleet() {
  const boats = new Map();
  let list = [];
  let wanted = [];
  let lastT = null;

  const freeSlot = () => {
    const taken = new Set([...boats.values()].map((boat) => boat.slot));
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    return slot;
  };

  function set(agents = []) {
    wanted = agents.slice(0, FLEET_MAX);
    const here = new Set();
    for (const [id, state, hot] of wanted) {
      here.add(id);
      let boat = boats.get(id);
      if (!boat) {
        const slot = freeSlot();
        boat = {
          id,
          slot,
          // Across the view and how far out on the water (or down the picture).
          across: scatter(slot, 0.61803, 0.31),
          out: scatter(slot, 0.37139, 0.23),
          seed: (slot * 2.399) % 6.283,
          light: 0,
          flare: 0,
          rowing: 0,
          travel: 0,
          leaving: false,
          state,
          hot: false,
        };
        boats.set(id, boat);
      }
      boat.state = state;
      boat.hot = Boolean(hot);
      boat.leaving = false;
    }
    for (const boat of boats.values()) if (!here.has(boat.id)) boat.leaving = true;
  }

  /** Moves everything on to scene time `t`; `instant` (animations off) goes straight to the end. */
  function step(t, instant = false) {
    const dt = lastT === null ? 0 : Math.min(0.25, Math.max(0, t - lastT));
    lastT = t;
    for (const boat of boats.values()) {
      const lit = boat.leaving ? 0 : Math.min(1, (LIT[boat.state] ?? LIT.idle) + (boat.hot ? HOT : 0));
      const flare = !boat.leaving && boat.state === 'needs' ? 1 : 0;
      const rowing = !boat.leaving && boat.state === 'working' ? 1 : 0;
      if (instant) {
        boat.light = lit;
        boat.flare = flare;
        boat.rowing = rowing;
      } else {
        boat.light = ease(boat.light, lit, lit > boat.light ? RISE : FALL, dt);
        boat.flare = ease(boat.flare, flare, FLARE, dt);
        boat.rowing = ease(boat.rowing, rowing, ROW, dt);
      }
      boat.travel += boat.rowing * dt;
      if (boat.leaving && boat.light < 0.01) boats.delete(boat.id);
    }
    list = [...boats.values()].sort((a, b) => a.out - b.out);
    return list;
  }

  return {
    set,
    step,
    get list() {
      return list;
    },
  };
}
