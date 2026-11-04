// The tasks as lights in the scene (src/renderer/js/fleet.js): places stay put, lights ease, gone lights free their place.
import assert from 'node:assert/strict';
import { createFleet, FLEET_MAX } from '../src/renderer/js/fleet.js';

const run = (fleet, from, seconds) => {
  let t = from;
  for (let i = 0; i < seconds * 30; i += 1) fleet.step((t += 1 / 30));
  return t;
};

// A light kindles rather than switching on.
{
  const fleet = createFleet();
  fleet.set([['a', 'working', false]]);
  fleet.step(0);
  fleet.step(1 / 30);
  const [boat] = fleet.list;
  assert.ok(boat.light > 0 && boat.light < 0.2, `starts low, was ${boat.light}`);
  run(fleet, 0, 5);
  assert.ok(Math.abs(fleet.list[0].light - 0.72) < 0.01, 'settles at its level');
  assert.ok(fleet.list[0].rowing > 0.9, 'a working task rows');
  assert.ok(fleet.list[0].travel > 0, 'and gets somewhere');
}

// Places: all different, and they don't change as other tasks come and go.
{
  const fleet = createFleet();
  fleet.set(['a', 'b', 'c', 'd'].map((id) => [id, 'working', false]));
  fleet.step(0);
  const where = new Map(fleet.list.map((boat) => [boat.id, boat.across]));
  assert.equal(new Set(fleet.list.map((boat) => boat.slot)).size, 4, 'one place each');
  fleet.set([['b', 'working', false], ['d', 'needs', false]]);
  let t = run(fleet, 0, 12);
  assert.deepEqual(fleet.list.map((boat) => boat.id).sort(), ['b', 'd'], 'the others have gone out and left');
  for (const boat of fleet.list) assert.equal(boat.across, where.get(boat.id), 'kept its place');
  // The freed place is used again rather than the fleet walking off.
  fleet.set([['b', 'working', false], ['d', 'needs', false], ['e', 'working', false]]);
  t = run(fleet, t, 1);
  assert.ok(fleet.list.find((boat) => boat.id === 'e').slot < 4, 'reuses a free place');
}

// What it means: needing you is brightest and flares; finished is lit but quiet; pointing at one lifts it.
{
  const fleet = createFleet();
  fleet.set([['needs', 'needs', false], ['done', 'unread', false], ['here', 'idle', true], ['idle', 'idle', false]]);
  run(fleet, 0, 6);
  const by = Object.fromEntries(fleet.list.map((boat) => [boat.id, boat]));
  assert.ok(by.needs.light > by.done.light && by.done.light > by.idle.light, 'brightness follows the state');
  assert.ok(by.here.light > by.idle.light, 'the one you are on stands out');
  assert.ok(by.needs.flare > 0.9 && by.done.flare < 0.05, 'only a task that needs you flares');
  assert.ok(by.done.rowing < 0.05, 'a finished task has stopped');
}

// Back on after going out: it comes back where it was, not as a new light.
{
  const fleet = createFleet();
  fleet.set([['a', 'working', false]]);
  run(fleet, 0, 3);
  const { slot } = fleet.list[0];
  fleet.set([]);
  fleet.step(3.1);
  assert.equal(fleet.list[0].leaving, true);
  fleet.set([['a', 'needs', false]]);
  fleet.step(3.2);
  assert.equal(fleet.list[0].leaving, false);
  assert.equal(fleet.list[0].slot, slot);
}

// Animations off: everything is at its end at once, and a gone light is gone.
{
  const fleet = createFleet();
  fleet.set([['a', 'needs', false]]);
  fleet.step(0, true);
  assert.equal(fleet.list[0].light, 1);
  assert.equal(fleet.list[0].flare, 1);
  fleet.set([]);
  fleet.step(1, true);
  assert.equal(fleet.list.length, 0);
}

// Never more than the water can hold.
{
  const fleet = createFleet();
  fleet.set(Array.from({ length: 40 }, (_, i) => [`t${i}`, 'working', false]));
  fleet.step(0);
  assert.equal(fleet.list.length, FLEET_MAX);
}

console.log('✓ fleet');
