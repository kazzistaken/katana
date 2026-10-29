// The window's "working" states end when the background process goes away.
import assert from 'node:assert/strict';
import { createAgent } from '../src/renderer/js/agent.js';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;

function fakeApi() {
  const on = {};
  const hook = (name) => (fn) => (on[name] = fn);
  return {
    on,
    agent: {
      onBusy: hook('busy'),
      onMessage: hook('message'),
      onState: hook('state'),
      onReply: hook('reply'),
      ask: () => new Promise(() => {}), // the daemon took it, then went away
      state: async () => null,
      stop: () => {},
    },
    task: { onLost: hook('lost') },
  };
}

// Katana busy (Thinking…, the spinner) and a question asked: the daemon drops.
{
  const api = fakeApi();
  const agent = createAgent({ api, store: { receiveAgentMessage() {}, setAgentState() {} } });
  const seen = [];
  agent.on((event) => seen.push(event.type));
  api.on.busy({ busy: true, since: Date.now(), activity: 'read terminal' });
  assert.equal(agent.busy(), true);
  const answer = agent.ask('hello', { kind: 'voice' });
  api.on.lost({});
  assert.equal(agent.busy(), false, 'not thinking once she is gone');
  assert.equal(agent.activity(), '');
  assert.ok(seen.includes('busy'), 'the screen is told');
  const reply = await Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve('hung'), 50))]);
  assert.ok(reply?.error, 'the waiting question gets an answer (an error), not a hang');
}

console.log('busy ok');
