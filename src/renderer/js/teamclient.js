/**
 * Hierarchy mode, as this window sees it. A task in hierarchy mode is run
 * by a team that lives in katanad (src/daemon/team.js): its own session is
 * the Leader; Workers 1-4 and Verifiers 1-2 are sessions of their own
 * (`<task>--w1` …), started when the leader gives them work. The daemon
 * says where each stands (team:state); this keeps the latest per task and
 * catches up after a reload (sync).
 *
 * A team view: { taskId, git, base, waiting, members: [{ key, id, label,
 * role, state: idle|working|done|failed, needs, subtask, branch, attempt,
 * verdict, merged, note, since, target }], log: [{ at, key, text, kind }] }.
 */

export const LEADER = { key: 'leader', label: 'Leader', role: 'leader' };

// The leader's team tools, as what it is doing.
const DOING = {
  team_assign: 'Assigning work',
  team_status: 'Checking on the team',
  team_collect: 'Waiting for the team',
  team_verify: 'Sending work to a verifier',
  team_send_back: 'Sending work back for fixes',
  team_merge: 'Merging a worker’s branch',
  team_verdict: 'Giving its verdict',
};

/** A tool in use, in a few words: a team tool by what it does, else its description or name and target. */
export function doing(tool) {
  if (!tool) return '';
  const name = String(tool.name || '').replace(/^mcp__katana-team__/, '');
  if (DOING[name]) return DOING[name];
  return tool.desc || `${tool.name} ${String(tool.detail || '').split(/[\\/]/).pop()}`.trim();
}

export function createTeamClient({ api }) {
  const teams = new Map();
  const listeners = new Set();

  function apply(view) {
    if (!view?.taskId) return;
    if (view.gone) teams.delete(view.taskId);
    else teams.set(view.taskId, view);
    for (const fn of listeners) {
      try {
        fn(view.taskId);
      } catch (error) {
        console.error('[team] listener failed', error);
      }
    }
  }

  api.team?.onState((view) => apply(view));

  return {
    get: (taskId) => teams.get(taskId) || null,
    /** A member of a task's team by its session id (`<task>--w1`), or null. */
    member(id) {
      const match = /^(.+)--([wv][1-4])$/.exec(String(id || ''));
      return match ? teams.get(match[1])?.members.find((m) => m.key === match[2]) || null : null;
    },
    /** Anyone on the team working (the task shows as working while its leader waits for them). */
    busy: (taskId) => Boolean(teams.get(taskId)?.members.some((m) => m.state === 'working')),
    /** Who is working, in a few words ("Worker 1, Verifier 2"). */
    working: (taskId) => (teams.get(taskId)?.members || []).filter((m) => m.state === 'working').map((m) => m.label),
    async sync() {
      const list = await api.team?.snapshot().catch(() => []);
      for (const view of list || []) apply(view);
    },
    /** Switch a task between 'single' and 'hierarchy' in the daemon: { ok, unmerged, closed } or { error }. */
    setMode: (taskId, mode) => api.team.mode(taskId, mode),
    stop: (taskId, forget = false) => api.team?.stop(taskId, forget),
    /** For look tests: draw a team as if the daemon said so. */
    apply,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
