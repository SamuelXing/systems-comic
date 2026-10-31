import type { ComputeResult, InputDef, Values } from '../types'
import { fmt } from '../format'
import { LAD } from '../ladder'

/* The scale-out sandbox for a stateful streaming job.
   ============================================================
   Flink's scaling question is not "how many events per second" —
   that one is usually answered by adding slots. It is:

     can this job still take a snapshot, and can it come back?

   Both reduce to STATE PER SUBTASK, which is why that is the
   number every meter here is derived from. And sitting over all
   of it is the one limit you cannot fix later: max parallelism
   is chosen on first run and, per the production-readiness docs,
   there is "no way to change the maximum parallelism of an
   operator after a job has started without discarding that
   operator's state."
   ============================================================ */

/** Parallelism is a count of slots — powers of two, because that is how
 *  people actually set it and how key groups divide evenly. */
const PAR = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]

/** Key groups. Starts at the documented default of 128 and tops out at the
 *  documented hard ceiling of 2^15. */
const KEY_GROUPS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]

/** Checkpoint intervals people actually configure, in seconds. */
const INTERVAL = [5, 10, 30, 60, 120, 300, 600]

/** The documented default checkpoint timeout: 10 minutes. */
const TIMEOUT_S = 600

/** A restart longer than this stops being a blip and becomes an incident.
 *  Not a Flink constant — a judgement, and the page says so. */
const RESTART_BUDGET_S = 300

export const scaleOutInputs: InputDef[] = [
  { id: 'rate', label: 'Event rate', steps: LAD.rate, val: 2e5, hint: 'Peak events per second into the job.', fmt: (v) => fmt.compact(v) + '/s' },
  { id: 'par', label: 'Parallelism', steps: PAR, val: 32, hint: 'Parallel subtasks — and the number of slots the job occupies.', fmt: (v) => '×' + fmt.int(v) },
  { id: 'maxPar', label: 'Max parallelism (key groups)', steps: KEY_GROUPS, val: 128, hint: 'The hard ceiling. Chosen on first run; changing it discards state.', fmt: (v) => fmt.int(v) },
  { id: 'state', label: 'Total job state', steps: LAD.gb, val: 500, hint: 'Everything the job remembers, across all subtasks.', fmt: (v) => fmt.int(v) + ' GB' },
  { id: 'interval', label: 'Checkpoint interval', steps: INTERVAL, val: 60, hint: 'How often a snapshot is taken. Also your exactly-once output latency.', fmt: (v) => (v >= 60 ? v / 60 + ' min' : v + ' s') },
  { id: 'delta', label: 'State changed per interval', steps: LAD.pct, val: 10, hint: 'Share of state touched between checkpoints. 100% means full checkpoints.', fmt: (v) => v + '%' },
  { id: 'upload', label: 'Per-subtask upload', steps: LAD.mbs, val: 100, hint: 'Bandwidth one subtask gets to the checkpoint store.', fmt: (v) => fmt.mbs(v) },
]

export function computeScaleOut(v: Values): ComputeResult {
  const overCap = v.par > v.maxPar
  /* Subtasks cannot outnumber key groups: past the cap the extra subtasks get
     no key groups at all and sit idle, so effective parallelism clamps. */
  const effPar = Math.min(v.par, v.maxPar)

  const stateGBPerSubtask = v.state / effPar
  const stateMBPerSubtask = stateGBPerSubtask * 1024
  const ckptMB = stateMBPerSubtask * (v.delta / 100)
  const ckptSec = ckptMB / v.upload
  /* Recovery downloads the WHOLE slice, not the delta — incremental
     checkpoints make writing cheap and change nothing about reading. */
  const restoreSec = stateMBPerSubtask / v.upload
  const perSubtask = v.rate / effPar

  const intervalPct = (ckptSec / v.interval) * 100
  const timeoutPct = (ckptSec / TIMEOUT_S) * 100
  const capPct = (v.par / v.maxPar) * 100
  const restorePct = (restoreSec / RESTART_BUDGET_S) * 100

  const dur = (s: number) => (s >= 60 ? fmt.sig(s / 60) + ' min' : fmt.sig(s) + ' s')

  const meters = [
    {
      label: 'Parallelism vs key groups',
      valTxt: `×${fmt.int(v.par)} of ${fmt.int(v.maxPar)}`,
      pct: capPct,
      detail: overCap
        ? `Past the ceiling: ${fmt.int(v.par - v.maxPar)} subtasks get no key groups and process nothing. Key groups are the unit of state partitioning, so they are also the unit of parallelism.`
        : `Each subtask owns about ${fmt.int(v.maxPar / effPar)} key groups. This is the one number you cannot raise later without discarding state — pick it generously on day one.`,
    },
    {
      label: 'Checkpoint duration vs its own interval',
      valTxt: dur(ckptSec),
      pct: intervalPct,
      detail:
        intervalPct >= 100
          ? `A checkpoint takes longer than the gap between checkpoints — the job is snapshotting continuously and never gets a quiet moment.`
          : `${fmt.sig(ckptMB)} MB per subtask at ${fmt.mbs(v.upload)}, against a ${v.interval >= 60 ? v.interval / 60 + '-minute' : v.interval + '-second'} interval. Remember this interval is also your two-phase-commit output latency.`,
    },
    {
      label: 'Checkpoint duration vs the 10-minute timeout',
      valTxt: dur(ckptSec) + ' of 10 min',
      pct: timeoutPct,
      detail:
        timeoutPct >= 100
          ? `Over the documented default timeout. The checkpoint is discarded — and with tolerable-failed-checkpoints at its default of 0, that discards the job too.`
          : `Headroom against the default. Note this is the calm-weather number: under backpressure, barriers queue behind data and duration stops tracking state size at all.`,
    },
    {
      label: 'Restart: state download per subtask',
      valTxt: dur(restoreSec),
      pct: restorePct,
      detail: `${fmt.sig(stateGBPerSubtask)} GB must come back down before processing resumes, and a pipelined-region restart usually means every subtask does this at once. Judged here against a ${RESTART_BUDGET_S / 60}-minute budget, which is an opinion rather than a Flink constant.`,
    },
  ]

  let verdict: ComputeResult['verdict']
  if (overCap)
    verdict = {
      s: 'crit',
      t: `<b>Parallelism above max parallelism does nothing.</b> You have asked for ×${fmt.int(v.par)} against ${fmt.int(v.maxPar)} key groups, so ${fmt.int(v.par - v.maxPar)} subtasks own no keys and idle. Worse, the ceiling is not adjustable: the docs are explicit that there is no way to change max parallelism after a job has started <em>without discarding that operator's state</em>. <b>Raise it by restarting from a savepoint with a new max parallelism — and accept the state loss, or rebuild.</b>`,
    }
  else if (timeoutPct >= 100)
    verdict = {
      s: 'crit',
      t: `<b>The checkpoint cannot finish before the default timeout.</b> ${dur(ckptSec)} against a 10-minute limit, and <code>tolerable-failed-checkpoints</code> defaults to 0 — so this job fails on its first checkpoint and keeps failing. Raise parallelism to cut state per subtask, turn on incremental checkpoints so only the delta ships, or give the subtasks more upload bandwidth. <em>Raising the timeout treats the alarm, not the fire.</em>`,
    }
  else if (intervalPct >= 100)
    verdict = {
      s: 'crit',
      t: `<b>Checkpointing is continuous.</b> Each snapshot takes ${dur(ckptSec)} against a ${v.interval}-second interval, so the next one begins before the last has finished. The job spends its life writing state rather than processing. Lengthen the interval (and accept the output latency), cut state per subtask with more parallelism, or reduce how much state changes between snapshots.`,
    }
  else if (restorePct >= 100)
    verdict = {
      s: 'warn',
      t: `<b>Checkpointing is fine; recovery is the problem.</b> Writing ${dur(ckptSec)} is comfortable, but a restart has to pull ${fmt.sig(stateGBPerSubtask)} GB back into every subtask — ${dur(restoreSec)} before a single record moves. <em>Incremental checkpoints do not help here</em>: they make writes cheap and leave reads full-sized. More parallelism is the lever, because it divides the slice.`,
    }
  else if (capPct >= 75 || intervalPct >= 75 || timeoutPct >= 75)
    verdict = {
      s: 'warn',
      t: `<b>${capPct >= 75 ? 'Close to the key-group ceiling' : 'Checkpoints are using most of their window'}</b> (${Math.round(Math.max(capPct, intervalPct, timeoutPct))}%). ${capPct >= 75 ? 'Headroom here is not something you can add later — if this job is going to grow, the savepoint-and-rescale conversation is cheaper now than under load.' : 'This is the calm-weather figure; the first sustained backpressure will push barriers behind the data and inflate it further. Unaligned checkpoints are the switch that decouples the two.'}`,
    }
  else
    verdict = {
      s: 'good',
      t: `<b>Comfortable.</b> ${fmt.sig(stateGBPerSubtask)} GB per subtask, snapshots in ${dur(ckptSec)} against a ${v.interval}-second interval, and ${fmt.int(v.maxPar / effPar)} key groups per subtask of rescaling room. Each subtask is handling ${fmt.compact(perSubtask)} events/s. <em>The thing to watch from here is not throughput — it is whether state per subtask grows without anybody deciding that it should.</em>`,
    }

  return {
    tiles: [
      { k: 'State per subtask', v: fmt.sig(stateGBPerSubtask), u: 'GB — sets everything below' },
      { k: 'Checkpoint', v: dur(ckptSec), u: v.delta >= 100 ? 'full snapshot' : `${v.delta}% delta` },
      { k: 'Restart', v: dur(restoreSec), u: 'full download, always' },
      { k: 'Per subtask', v: fmt.compact(perSubtask), u: 'events/s' },
    ],
    meters,
    verdict,
  }
}
