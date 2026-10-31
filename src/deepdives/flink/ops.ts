import type { TraceSpec } from '../../components/TracePlayer'
import type { MetricCard } from '../../components/MetricRunbook'
import { VIZ } from '../../styles/viz'

/* ============================================================
   Flink in production — the 3am view.

   The organising claim of this file: almost every Flink incident
   is ONE slow thing, and the dashboard shows you five red panels
   that are all consequences of it. The cascade below is built
   entirely out of documented defaults — nothing here requires a
   misconfiguration, which is why so many teams meet it.
   ============================================================ */

/** The restart loop. Read it backwards and there is one cause. */
export const cascadeTrace: TraceSpec = {
  title: 'One slow sink, five red dashboards, and a job that will not stay up',
  aspect: 0.52,
  zones: [
    { label: 'The pipeline', x: 2, y: 5, w: 44, h: 42 },
    { label: 'What the pager sees', x: 50, y: 5, w: 46, h: 42 },
  ],
  nodes: [
    { id: 'sink', x: 5, y: 11, w: 38, h: 9, label: 'Sink · slow', sub: 'the only fault', color: VIZ.red },
    { id: 'ops', x: 5, y: 23, w: 38, h: 9, label: 'Operators', sub: 'backpressured', color: VIZ.blue },
    { id: 'src', x: 5, y: 35, w: 38, h: 9, label: 'Sources', sub: 'lag climbing', color: VIZ.blue },
    { id: 'ck', x: 54, y: 11, w: 38, h: 9, label: 'Checkpoint', sub: 'duration climbing', color: VIZ.amber },
    { id: 'fail', x: 54, y: 23, w: 38, h: 9, label: 'Job failed', sub: 'tolerable = 0', color: VIZ.red },
    { id: 'rs', x: 54, y: 35, w: 38, h: 9, label: 'Restart + replay', sub: 'further behind', color: VIZ.amber },
  ],
  steps: [
    {
      title: '00:00 — a downstream API gets slower. Nothing alerts.',
      prose:
        'The sink writes to a service that has just started taking 40 ms instead of 8 ms. No threshold is crossed, no page fires, and the Flink job is still correct — it is simply unable to drain as fast as it fills. <b>This is the only thing that is actually broken in the entire incident.</b> Everything after this point is the system behaving exactly as documented.',
      focus: ['sink'],
      particles: [],
    },
    {
      title: '00:02 — backpressure walks upstream, one hop at a time',
      prose:
        'The sink stops requesting buffers; its upstream operator fills its output queue and stops consuming; <em>its</em> upstream does the same. Within seconds the whole graph is throttled to the speed of the slowest stage. <b>This is Flink working properly</b> — the alternative is unbounded buffering and an OOM. <code>backPressuredTimeMsPerSecond</code> is now high across most tasks, which tells you everything is slow and nothing about which thing is the cause.',
      focus: ['sink', 'ops'],
      particles: [{ from: 'sink', to: 'ops', color: VIZ.red }],
    },
    {
      title: '00:03 — the sources stop reading, and consumer lag becomes the headline',
      prose:
        'The source tasks are throttled too, so Kafka lag starts climbing and <em>that</em> is the graph somebody screenshots into the incident channel. It is a real symptom and a terrible place to start debugging: lag is the last link in the chain, furthest from the cause. <b>The task to look for is the one that is busy while its downstream is not backpressured</b> — that is the bottom of the backpressure, and the fault is just below it.',
      focus: ['ops', 'src'],
      particles: [{ from: 'ops', to: 'src', color: VIZ.red }],
    },
    {
      title: '00:06 — checkpoints start taking minutes instead of seconds',
      prose:
        'Barriers travel inside the data, so now they are queued behind everything else. Alignment time grows, <code>checkpointStartDelayNanos</code> grows, and <code>lastCheckpointDuration</code> climbs even though the amount of state has not changed at all. <b>This is the moment the incident becomes a Flink incident rather than a slow-API incident</b>, and it is also the moment most people start suspecting the state backend, which is innocent.',
      focus: ['ops', 'ck'],
      particles: [{ from: 'ops', to: 'ck', color: VIZ.red, via: [{ x: 48, y: 27.5 }, { x: 48, y: 15.5 }] }],
    },
    {
      title: '00:16 — the checkpoint hits the 10-minute timeout, and the job dies',
      prose:
        'The checkpoint exceeds the default timeout and is discarded. <code>execution.checkpointing.tolerable-failed-checkpoints</code> defaults to <b>0</b>, so one discarded checkpoint fails the job outright. <em>A job that was merely slow is now a job that is down</em>, and the thing that killed it was a timeout defending against a problem it could not fix.',
      focus: ['ck', 'fail'],
      particles: [{ from: 'ck', to: 'fail', color: VIZ.red }],
    },
    {
      title: '00:17 — the restart makes it worse, which is the cruel part',
      prose:
        'The job restarts, every subtask downloads its state, and processing resumes <b>from the last successful checkpoint</b> — which was taken before all of this started. So it must now reprocess the backlog it accumulated <em>and</em> the new arrivals, through a sink that is still slow. The queue is longer than it was at 00:00. If nothing changes, the next checkpoint also times out.',
      focus: ['fail', 'rs'],
      particles: [{ from: 'fail', to: 'rs', color: VIZ.red }],
    },
    {
      title: '00:24 — and around again. Read it backwards.',
      prose:
        'Restart, replay, fall further behind, time out, fail. The dashboard is five red panels — lag, backpressure, checkpoint duration, failed checkpoints, restart count — and <b>every one of them is downstream of a sink that went from 8 ms to 40 ms.</b> <em>The move is never to tune the checkpoint.</em> It is to raise <code>tolerable-failed-checkpoints</code> so a slow minute cannot kill the job, turn on unaligned checkpoints so barriers stop queueing, and then go fix the API.',
      focus: ['rs', 'src', 'sink'],
      particles: [{ from: 'rs', to: 'src', color: VIZ.red }],
    },
  ],
}

export const METRICS: MetricCard[] = [
  {
    metric: 'Backpressure & busy time',
    jmx: 'backPressuredTimeMsPerSecond · busyTimeMsPerSecond · idleTimeMsPerSecond',
    severity: 'page',
    healthy: 'Backpressured time near zero. Busy well under 1000 ms/s on every task, with real idle time — a pipeline with no idle anywhere has no headroom for a burst.',
    means:
      'Milliseconds per second each task spent unable to emit because its downstream would not take the data. It is the single most diagnostic number in Flink, and it is directional: backpressure propagates upstream, so the pattern across the graph points at the culprit.',
    breaks:
      'Sustained backpressure stalls barriers, which inflates checkpoint duration, which hits the timeout, which fails the job. The whole chapter 6 cascade starts here — this metric is the fuse, and it is usually alight for minutes before anything pages.',
    causes: [
      'A slow external sink — a database, an API, an index (by far the most common)',
      'Data skew: one key group doing most of the work while its peers idle',
      'A state access that got expensive — RocksDB compaction, or state that outgrew the block cache',
      'Under-parallelised operator after a traffic increase nobody re-sized for',
      'A GC pause pattern on one TaskManager, making one subtask intermittently stop',
    ],
    respond: [
      'Find the <b>deepest</b> busy task whose own downstream is NOT backpressured — that is the bottom of the chain and the actual bottleneck',
      'Check whether it is skew before you scale: compare per-subtask records-in across the operator. Scaling does nothing for one hot key',
      'If it is an external sink, fix or buffer the sink; raising parallelism just sends more concurrent requests at something already struggling',
      'Only then consider parallelism — and remember it is capped by max parallelism, which you cannot change without dropping state',
    ],
    tie: 'The alignment trace in chapter 2 is this metric, drawn.',
  },
  {
    metric: 'Checkpoint duration',
    jmx: 'lastCheckpointDuration · checkpointStartDelayNanos',
    severity: 'page',
    healthy: 'Stable and a small fraction of the checkpoint interval. If a checkpoint takes longer than the gap between checkpoints, the job is effectively checkpointing continuously.',
    means:
      'How long the last complete snapshot took. The trap is that this number is <em>not</em> primarily about state size — under backpressure it measures how long barriers took to travel, which is a throughput problem wearing a storage problem’s clothes.',
    breaks:
      'Crossing the 10-minute default timeout discards the checkpoint; with tolerable failures at 0 that kills the job. Before that, long checkpoints mean a long replay window on recovery and — for two-phase-commit sinks — visible output latency equal to the interval.',
    causes: [
      'Backpressure delaying barriers (check start delay and alignment first — this is the common case)',
      'State genuinely grew: a new key space, a window that stopped firing, a timer leak',
      'Full checkpoints where incremental would do (incremental requires RocksDB)',
      'Slow or throttled checkpoint storage — your object store is on this path',
    ],
    respond: [
      'Split the number: high start delay means backpressure, high async duration means state or storage',
      'Enable unaligned checkpoints if the cause is backpressure — duration becomes independent of throughput',
      'Enable incremental checkpoints on RocksDB if the cause is state volume',
      'Raise the interval before raising the timeout — a long interval is cheaper than a long replay',
    ],
    tie: 'Chapter 5’s sandbox puts duration against interval directly.',
  },
  {
    metric: 'Failed checkpoints',
    jmx: 'numberOfFailedCheckpoints · numberOfCompletedCheckpoints',
    severity: 'page',
    healthy: 'Zero, with completions advancing steadily on every interval.',
    means:
      'Checkpoints that timed out, were declined, or hit an error. Because the default tolerance is zero, this metric is less a health signal than a <b>countdown</b>: in a default configuration the first failure and the job restart are the same event.',
    breaks:
      'The job fails and replays from the last success. If failures are chronic, the last success keeps getting older and the replay on each restart gets longer — the job spends more of its life recovering than running.',
    causes: [
      'Timeout under backpressure (the cascade)',
      'Checkpoint storage unavailable, throttled, or out of quota',
      'A TaskManager lost mid-checkpoint',
      'Too many concurrent checkpoints against a store that cannot keep up',
    ],
    respond: [
      'Raise <code>tolerable-failed-checkpoints</code> above 0 — this one change converts a hard outage into a logged blip, and almost every production job should have done it',
      'Set a minimum pause between checkpoints so a slow one does not immediately trigger the next',
      'Then treat the underlying cause as the real incident; the tolerance only buys you time to do that',
    ],
    tie: 'Step 5 of the cascade — a documented default doing the killing.',
  },
  {
    metric: 'State size per subtask',
    jmx: 'lastCheckpointSize ÷ parallelism',
    severity: 'watch',
    healthy: 'Flat or growing in step with your key space. A metric that only ever rises is a leak, not a workload.',
    means:
      'The amount of state one parallel slice is responsible for. It sets checkpoint cost, and it sets recovery time — on restart, every subtask downloads its slice before processing resumes.',
    breaks:
      'Large per-subtask state makes every restart expensive, which makes every incident longer. Past the point where RocksDB cannot keep working data in its block cache, read latency degrades sharply and shows up as backpressure.',
    causes: [
      'Unbounded key space — session windows on a key that is effectively unique per event',
      'Timers or window state that never fires because watermarks stopped advancing',
      'No state TTL configured on state that logically expires',
      'Parallelism too low for the key space, concentrating state on few subtasks',
    ],
    respond: [
      'Set state TTL wherever the data has a natural lifetime — the cheapest fix there is',
      'Check watermark advance before blaming state size: stalled watermarks leak window state silently',
      'Raise parallelism to spread it — up to max parallelism, and no further',
      'Move to RocksDB with incremental checkpoints if you are on heap state and growing',
    ],
    tie: 'The number chapter 5’s sandbox is organised around.',
  },
  {
    metric: 'Restart count',
    jmx: 'numRestarts · runningTime',
    severity: 'page',
    healthy: 'Flat. A job that has not restarted in weeks is the normal, boring, correct state.',
    means:
      'How many times the job has gone back to a checkpoint since submission. Restarts are not free and they are not local — a pipelined region restart usually means the whole graph redeploys and re-downloads state.',
    breaks:
      'A restart loop is the worst Flink failure mode because it looks like activity. The job is up, tasks are running, metrics are flowing — and it is making no forward progress because it restarts before it can catch up.',
    causes: [
      'The checkpoint cascade (most common)',
      'A TaskManager being evicted or OOM-killed, often from an undersized heap or metaspace',
      'An exception in user code on a specific record — a poison message that recurs on every replay',
      'Cluster churn: spot reclaim, node drain, rolling upgrade',
    ],
    respond: [
      'Check whether progress is being made between restarts — if not, stop the loop before diagnosing it',
      'For a poison record, the loop will not break itself: find the offending event and handle it explicitly',
      'For checkpoint-driven loops, raise the failure tolerance first, then fix the bottleneck',
      'For infrastructure churn, give the restart strategy a backoff that outlasts a node rotation',
    ],
    tie: 'The outer loop of the chapter 6 cascade.',
  },
  {
    metric: 'Watermark lag',
    jmx: 'currentInputWatermark · currentOutputWatermark',
    severity: 'watch',
    healthy: 'Watermarks advancing steadily, a bounded distance behind wall-clock. Every source partition contributing.',
    means:
      'How far event time has advanced. Watermarks are what fire windows and expire state — so a watermark that stops advancing is a system that has quietly stopped producing results while still consuming records perfectly happily.',
    breaks:
      'A stalled watermark means windows never close: output dries up, and window state accumulates without bound until the job runs out of disk or memory. <b>It is the one failure here that does not look like a failure</b> — no errors, no backpressure, no restarts.',
    causes: [
      'An idle source partition holding the watermark back — the minimum across inputs is the watermark',
      'A partition with no data at all, which looks identical to one that is merely slow',
      'Idleness detection not configured on a source that legitimately goes quiet',
      'Clock skew or bad timestamps in a single upstream producer',
    ],
    respond: [
      'Compare watermark advance per subtask — the stalled one is the whole answer',
      'Configure source idleness so a quiet partition stops holding the line',
      'Alert on watermark lag directly; it is invisible in throughput metrics',
    ],
    tie: 'Why event time is not a preference — the papers book spends a chapter on it.',
  },
  {
    metric: 'Managed memory & RocksDB',
    jmx: 'taskmanager.memory.managed.fraction (0.4) · RocksDB block cache hit rate',
    severity: 'watch',
    healthy: 'Block cache absorbing the working set; compaction steady rather than bursty.',
    means:
      'Managed memory defaults to <b>0.4</b> of the TaskManager’s total process memory, and on a RocksDB job that is what the block cache and write buffers come out of. It is the dial between “state access is a memory lookup” and “state access is a disk read.”',
    breaks:
      'When the working set stops fitting, every state access becomes disk I/O, the operator slows, and the first symptom you see is backpressure — which sends you looking at parallelism instead of memory. Compaction storms do the same thing in bursts.',
    causes: [
      'State grew past the cache without the memory configuration changing',
      'Too many slots per TaskManager, each operator state sharing one managed pool',
      'Default configuration on a job that was always going to be state-heavy',
    ],
    respond: [
      'Raise managed memory fraction before raising parallelism when the symptom is state-access latency',
      'Fewer, larger slots concentrate memory where state lives; more, smaller ones spread it thin',
      'Check compaction metrics before concluding it is a capacity problem',
    ],
    tie: 'The envelope in chapter 3 makes this the binding meter more often than people expect.',
  },
]
