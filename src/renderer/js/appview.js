import { el, icons, truncate } from './util.js';

/**
 * The app viewer (main appview.js runs what's in it): your app, or a web
 * page, filling the main area like a browser. A slim bar along the top
 * stays put: Back on the left, then what runs, its windows, Restart, Stop
 * or Run. No console and no errors here: the app's errors are kept
 * quietly with the task (apperrors.js) and asked about later.
 *
 * The picture is the window's own, streamed (Windows window capture);
 * your mouse and keys over it go back to the window, in its pixels.
 * Dialogs and popups are drawn over their window where the app put them.
 */

const OUTPUT_MAX = 256 * 1024;
// Colours and cursor moves from the app's console: kept as plain text (for agents).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function createAppPane({ api, onBack, onChange }) {
  /** task id → { state, output } */
  const runs = new Map();
  let taskId = '';
  let visible = false;
  /** hwnd → { stream, video, box, win } */
  const streams = new Map();

  /* ------------------------------- parts ------------------------------- */

  const button = (label, icon, onclick, extra = {}) =>
    el('button', { class: 'app-dock-btn', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, el('span', { class: 'app-dock-icon', html: icon }));
  const backBtn = el(
    'button',
    { class: 'app-back', type: 'button', title: 'Back to the task', onclick: () => onBack?.() },
    el('span', { class: 'app-dock-icon', html: icons.back }),
    el('span', { text: 'Back' })
  );
  const dot = el('span', { class: 'status-dot app-dot', 'aria-hidden': 'true' });
  const label = el('span', { class: 'app-dock-label' });
  const tabs = el('div', { class: 'app-tabs', role: 'tablist' });
  const restartBtn = button('Restart', icons.restart, () => restart());
  const stopBtn = button('Stop', icons.stop, () => stop());
  const runBtn = button('Run', icons.play, () => start());
  const dock = el(
    'div',
    { class: 'app-dock', role: 'toolbar', 'aria-label': 'App viewer' },
    backBtn,
    dot,
    label,
    tabs,
    el('span', { class: 'app-dock-gap' }),
    restartBtn,
    stopBtn,
    runBtn
  );

  const screen = el('div', { class: 'app-screen' });
  const note = el('div', { class: 'app-note', role: 'status' });
  const stage = el('div', { class: 'app-stage', tabindex: '0', 'aria-label': 'Running app' }, screen, note);
  const element = el('div', { class: 'app-pane', hidden: true }, dock, stage);

  const run = () => runs.get(taskId);
  const live = (s) => s && (s.status === 'starting' || s.status === 'running');
  const entry = (id) => {
    if (!runs.has(id)) runs.set(id, { state: null, output: '' });
    return runs.get(id);
  };

  /* ------------------------------- state ------------------------------- */

  api.appview.onState((state) => {
    if (!state) return;
    entry(state.taskId).state = state;
    if (state.taskId === taskId) render();
    onChange?.(state.taskId);
  });

  api.appview.onOutput(({ taskId: id, text }) => {
    const e = entry(id);
    e.output = (e.output + text.replace(ANSI, '')).slice(-OUTPUT_MAX);
  });

  function render() {
    const s = run()?.state;
    const status = s?.status || 'exited';
    dot.className = `status-dot app-dot${status === 'starting' ? ' is-working' : status === 'running' ? ' is-live' : ''}`;
    label.textContent = s ? s.label : 'Not running';
    label.title = s ? `${s.page || s.label}\n${s.cwd}` : '';
    restartBtn.hidden = !s;
    stopBtn.hidden = !live(s);
    runBtn.hidden = live(s);

    const tops = (s?.windows || []).filter((w) => w.kind === 'top');
    tabs.replaceChildren(
      ...(tops.length > 1
        ? tops.map((w) =>
            el('button', {
              class: `app-tab${w.hwnd === s.current ? ' is-on' : ''}`,
              type: 'button',
              role: 'tab',
              'aria-selected': String(w.hwnd === s.current),
              title: w.title,
              text: truncate(w.title || 'Window', 22),
              onclick: () => api.appview.select(taskId, w.hwnd),
            })
          )
        : [])
    );

    // Only where it is, never what went wrong (that waits for your next message).
    let message = '';
    if (!s || status === 'exited' || status === 'failed') message = 'Not running.';
    else if (status === 'starting') message = 'Starting…';
    else if (s.popped) message = 'It’s in its own window.';
    else if (!tops.length) message = 'Running, with no window open.';
    note.textContent = message;
    note.hidden = !message;
    layout();
  }

  /* ------------------------------ picture ------------------------------ */

  /** What's drawn: the current window and the dialogs and popups over it. */
  function shownWindows() {
    const s = run()?.state;
    if (!visible || !s || !live(s) || s.popped) return [];
    const top = s.windows.find((w) => w.hwnd === s.current && w.kind === 'top');
    if (!top) return [];
    return [top, ...s.windows.filter((w) => w.kind === 'layer' && w.owner === top.hwnd)];
  }

  function layout() {
    const wanted = shownWindows();
    const keep = new Set(wanted.map((w) => w.hwnd));
    for (const hwnd of [...streams.keys()]) if (!keep.has(hwnd)) endStream(hwnd);
    if (!wanted.length) {
      screen.replaceChildren();
      screen.hidden = true;
      return;
    }
    screen.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const [top] = wanted;
    // The window at its own size (CSS px), smaller if it doesn't fit.
    const natural = { width: top.client.width / dpr, height: top.client.height / dpr };
    const room = { width: stage.clientWidth, height: stage.clientHeight };
    const scale = Math.min(1, room.width / natural.width || 1, room.height / natural.height || 1);
    screen.style.width = `${natural.width * scale}px`;
    screen.style.height = `${natural.height * scale}px`;
    const nodes = wanted.map((w) => {
      const node = streamFor(w);
      const width = (w.client.width / dpr) * scale;
      const height = (w.client.height / dpr) * scale;
      node.box.style.width = `${width}px`;
      node.box.style.height = `${height}px`;
      node.box.style.left = w === top ? '0' : `${((w.at?.x || 0) / dpr) * scale}px`;
      node.box.style.top = w === top ? '0' : `${((w.at?.y || 0) / dpr) * scale}px`;
      // The capture is the whole frame: show only the client area.
      node.video.style.width = `${width / w.crop.width}px`;
      node.video.style.height = `${height / w.crop.height}px`;
      node.video.style.left = `${(-w.crop.x * width) / w.crop.width}px`;
      node.video.style.top = `${(-w.crop.y * height) / w.crop.height}px`;
      node.win = w;
      return node.box;
    });
    screen.replaceChildren(...nodes);
  }

  function streamFor(win) {
    let node = streams.get(win.hwnd);
    if (node) return node;
    const video = el('video', { class: 'app-video', muted: true, autoplay: true, playsinline: true });
    const box = el('div', { class: `app-window${win.kind === 'layer' ? ' is-layer' : ''}`, 'data-hwnd': String(win.hwnd) }, video);
    node = { video, box, stream: null, win };
    streams.set(win.hwnd, node);
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: `window:${win.hwnd}:0`, maxFrameRate: 60, maxWidth: 7680, maxHeight: 4320 } },
      })
      .then((stream) => {
        if (streams.get(win.hwnd) !== node) return stream.getTracks().forEach((t) => t.stop());
        node.stream = stream;
        video.srcObject = stream;
        video.play().catch(() => {});
      })
      .catch((error) => console.warn('[appview] capture', win.hwnd, error?.message || error));
    return node;
  }

  function endStream(hwnd) {
    const node = streams.get(hwnd);
    streams.delete(hwnd);
    node?.stream?.getTracks().forEach((t) => t.stop());
    node?.box.remove();
  }

  // The pane's size is the app window's size.
  let sizeTimer = 0;
  const sizer = new ResizeObserver(() => {
    layout();
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(sendSize, 60);
  });
  sizer.observe(stage);
  function sendSize() {
    if (!visible || !taskId || !stage.clientWidth) return;
    api.appview.pane(taskId, stage.clientWidth, stage.clientHeight, window.devicePixelRatio || 1);
  }

  /* ------------------------------- input ------------------------------- */

  let queue = [];
  let queueFor = 0;
  let frame = 0;
  let drag = null;

  /** Where a pointer event lands: which window, at which of its pixels. */
  function hit(event, node = null) {
    const target = node || [...streams.values()].reverse().find((n) => inside(n.box, event)) || null;
    if (!target) return null;
    const rect = target.box.getBoundingClientRect();
    const { width, height } = target.win.client;
    return { node: target, hwnd: target.win.hwnd, x: ((event.clientX - rect.left) / rect.width) * width, y: ((event.clientY - rect.top) / rect.height) * height };
  }

  function inside(box, event) {
    const r = box.getBoundingClientRect();
    return event.clientX >= r.left && event.clientX < r.right && event.clientY >= r.top && event.clientY < r.bottom;
  }

  const mods = (event) => ({ ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey });

  function queueInput(hwnd, item, { now = false } = {}) {
    if (queueFor && queueFor !== hwnd) flush();
    queueFor = hwnd;
    // Only the last move between frames matters.
    if (item.type === 'move' && queue.at(-1)?.type === 'move') queue[queue.length - 1] = item;
    else queue.push(item);
    if (now) flush();
    else if (!frame) frame = requestAnimationFrame(flush);
  }

  function flush() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (queue.length && taskId) api.appview.input(taskId, queueFor, queue);
    queue = [];
    queueFor = 0;
  }

  stage.addEventListener('mousedown', (event) => {
    stage.focus({ preventScroll: true });
    const at = hit(event);
    if (!at) return;
    event.preventDefault();
    drag = at.node;
    queueInput(at.hwnd, { type: 'down', x: at.x, y: at.y, button: event.button, buttons: event.buttons, detail: event.detail, ...mods(event) }, { now: true });
    window.addEventListener('mousemove', dragMove, true);
    window.addEventListener('mouseup', dragEnd, true);
  });

  function dragMove(event) {
    const at = drag && hit(event, drag);
    if (at) queueInput(at.hwnd, { type: 'move', x: at.x, y: at.y, buttons: event.buttons, ...mods(event) });
  }

  function dragEnd(event) {
    const at = drag && hit(event, drag);
    if (at) queueInput(at.hwnd, { type: 'up', x: at.x, y: at.y, button: event.button, buttons: event.buttons, ...mods(event) }, { now: true });
    if (!event.buttons) {
      drag = null;
      window.removeEventListener('mousemove', dragMove, true);
      window.removeEventListener('mouseup', dragEnd, true);
    }
  }

  stage.addEventListener('mousemove', (event) => {
    if (drag) return;
    const at = hit(event);
    if (at) queueInput(at.hwnd, { type: 'move', x: at.x, y: at.y, buttons: event.buttons, ...mods(event) });
  });

  stage.addEventListener(
    'wheel',
    (event) => {
      const at = hit(event);
      if (!at) return;
      event.preventDefault();
      queueInput(at.hwnd, { type: 'wheel', x: at.x, y: at.y, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, buttons: event.buttons, ...mods(event) });
    },
    { passive: false }
  );

  stage.addEventListener('contextmenu', (event) => event.preventDefault());

  // Keys go to the app while the pane has focus (click it); Katana's own shortcuts wait.
  const keyTarget = () => run()?.state?.current || 0;
  for (const type of ['keydown', 'keyup']) {
    stage.addEventListener(type, (event) => {
      const hwnd = keyTarget();
      if (!hwnd || !live(run()?.state)) return;
      // Reload (F5) and full screen (F11) stay Katana's (main catches them first anyway).
      if (event.key === 'F5' || event.key === 'F11') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.isComposing) return;
      queueInput(hwnd, { type: 'key', down: type === 'keydown', code: event.code, key: event.key, repeat: event.repeat, ...mods(event) }, { now: true });
    });
  }

  /* ------------------------------ controls ----------------------------- */

  /** What the task last ran here, to run again: { cwd, command, page }. */
  const last = new Map();

  async function start(id = taskId, what = last.get(id) || {}) {
    if (!id) return { error: 'Which task?' };
    last.set(id, what);
    const reply = await api.appview.start(id, what.cwd, what.command || '', what.page || '');
    if (reply?.error) {
      // Kept with the task's errors (main logs it); here it's only not running.
      if (id === taskId) render();
      return reply;
    }
    remember(reply);
    return reply;
  }

  function remember(state) {
    if (!state?.taskId) return;
    entry(state.taskId).state = state;
    if (state.taskId === taskId) render();
  }

  async function stop(id = taskId) {
    if (id) remember(await api.appview.stop(id));
  }

  async function restart() {
    if (!taskId) return;
    const reply = await api.appview.restart(taskId);
    if (!reply?.error) remember(reply);
  }

  async function drop(id) {
    runs.delete(id);
    last.delete(id);
    await api.appview.drop(id);
    if (id === taskId) render();
  }

  return {
    element,
    /** Shows a task's app (its run, if it has one). */
    async show(task) {
      const changed = task.id !== taskId;
      taskId = task.id;
      visible = true;
      element.hidden = false;
      if (!last.has(task.id)) last.set(task.id, { cwd: task.cwd });
      if (changed || !run()?.state) {
        const [state, output] = await Promise.all([api.appview.state(taskId), api.appview.output(taskId)]);
        if (state) Object.assign(entry(taskId), { state, output: output.replace(ANSI, '') });
      }
      render();
      sendSize();
      stage.focus({ preventScroll: true });
    },
    hide() {
      visible = false;
      element.hidden = true;
      layout();
    },
    /** Runs the app in a task's folder (`command`, else package.json decides), or shows a web page (`page`); `cwd`: a hierarchy worker's worktree instead. */
    run: (task, { command = '', page = '', cwd = '' } = {}) => start(task.id, { cwd: cwd || task.cwd, command, page }),
    /** After the page's file changed: shown again. */
    reload: (id) => api.appview.reload(id),
    stop,
    drop,
    has: (id) => Boolean(runs.get(id)?.state),
    isLive: (id) => live(runs.get(id)?.state),
    isPage: (id) => Boolean(runs.get(id)?.state?.page),
    state: (id) => runs.get(id)?.state || null,
    output: (id) => runs.get(id)?.output || '',
    focus: () => stage.focus({ preventScroll: true }),
  };
}
