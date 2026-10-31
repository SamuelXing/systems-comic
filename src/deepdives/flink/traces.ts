import type { TraceSpec } from '../../components/TracePlayer'
import { VIZ } from '../../styles/viz'

/* ============================================================
   Flink anatomy traces.

   Colour grammar, and it is load-bearing on this page: operators
   are BLUE because they are compute and hold nothing durable;
   RocksDB is GREEN because it is the store; records in flight are
   VIOLET; the broker outside the job is AMBER; and RED marks the
   one thing that is actually broken. On the cascade that matters
   more than usual — the whole point of chapter 6 is that five red
   dashboards have one red cause.

   Geometry: nodes stop short of their zone edge so the corridor
   between zones carries anything that would otherwise clip a box.
   ============================================================ */
const C = {
  op: VIZ.blue,
  store: VIZ.green,
  data: VIZ.violet,
  broker: VIZ.amber,
  bad: VIZ.red,
}

/** Chapter 2, trace 1 — one record, source to sink, and every place
 *  the engine either avoids a copy or is forced to make one. */
export const recordTrace: TraceSpec = {
  title: 'One record, from a Kafka partition to a committed sink',
  aspect: 0.52,
  zones: [
    { label: 'The log', x: 2, y: 5, w: 16, h: 42 },
    { label: 'TaskManager A', x: 21, y: 5, w: 36, h: 42 },
    { label: 'TaskManager B', x: 61, y: 5, w: 36, h: 42 },
  ],
  nodes: [
    { id: 'kafka', x: 4, y: 20, w: 13, h: 11, label: 'Kafka', sub: 'partition 3', color: C.broker },
    { id: 'src', x: 24, y: 12, w: 30, h: 9, label: 'Source', sub: 'offset 8,412', color: C.op },
    { id: 'chain', x: 24, y: 26, w: 30, h: 9, label: 'map → filter', sub: 'same thread', color: C.op },
    { id: 'win', x: 64, y: 12, w: 30, h: 9, label: 'keyBy → window', sub: 'one key group', color: C.op },
    { id: 'rocks', x: 64, y: 25, w: 30, h: 9, label: 'RocksDB', sub: 'local disk', color: C.store },
    { id: 'sink', x: 64, y: 37, w: 30, h: 9, label: 'Sink · two-phase', sub: 'commits later', color: C.op },
  ],
  steps: [
    {
      title: 'The source is a running task, not a poll loop you wrote',
      prose:
        'The job is a <b>long-lived physical pipeline</b>, deployed once and left running. The source task owns Kafka partition 3 and holds its offset as <em>Flink state</em>, not as a Kafka consumer-group commit — which is the first thing that surprises people. The offset and the downstream aggregates have to move together or exactly-once is a slogan, so Flink keeps both in the same snapshot and treats the broker as a replayable log rather than a cursor.',
      focus: ['kafka', 'src'],
      particles: [{ from: 'kafka', to: 'src', color: C.data }],
    },
    {
      title: 'Chained operators are a function call, and that is the whole optimisation',
      prose:
        'The <code>map</code> and <code>filter</code> are <b>chained</b> into the source task: same thread, same JVM, no serialization, no buffer, no network. The record is passed as an object reference. <em>This is why operator chaining is the first thing you check when a job is slower than it should be</em> — a chain broken by a rebalance or a mismatched parallelism turns a function call into a serialize-copy-deserialize round trip, and nothing in the API shouts when that happens.',
      focus: ['src', 'chain'],
      particles: [{ from: 'src', to: 'chain', color: C.data }],
    },
    {
      title: 'keyBy is a network shuffle, and it is where the record stops being free',
      prose:
        'A <code>keyBy</code> is not a grouping annotation — it is an <b>all-to-all exchange</b>. The record is serialized, hashed to a key group, written into a network buffer bound for whichever subtask owns that group, and shipped. Every key goes to exactly one subtask, forever, which is what makes the state partitionable and also what makes a hot key unfixable by adding machines: <em>one key is one subtask, and no amount of parallelism splits it.</em>',
      focus: ['chain', 'win'],
      particles: [{ from: 'chain', to: 'win', color: C.data, via: [{ x: 58.5, y: 31 }, { x: 58.5, y: 17 }] }],
    },
    {
      title: 'The window reads and writes state, and the backend decides what that costs',
      prose:
        'The operator looks up this key&rsquo;s accumulator, folds the record in, and writes it back. On the default <b>HashMapStateBackend</b> that is a Java object on the heap — a pointer dereference. On <b>RocksDB</b> it is a serialize, a disk-backed lookup, a deserialize and a write; the documentation puts this at <em>&ldquo;an order of magnitude slower than the memory state backends.&rdquo;</em> You buy that cost for one reason: heap state is bounded by RAM, and RocksDB state is bounded by disk.',
      focus: ['win', 'rocks'],
      particles: [
        { from: 'win', to: 'rocks', color: C.data },
        { from: 'rocks', to: 'win', color: C.store },
      ],
    },
    {
      title: 'The sink does not commit — not yet',
      prose:
        'A two-phase-commit sink <b>writes the data but withholds the commit</b>, holding a pending transaction. It commits only when a checkpoint completes, because that is the only moment the whole pipeline agrees on what has been processed. <em>So end-to-end exactly-once has a latency floor, and that floor is your checkpoint interval.</em> A job checkpointing every minute publishes visible results every minute, whatever its per-record latency says.',
      focus: ['win', 'sink'],
      /* Round the right-hand corridor: win and sink are stacked with RocksDB
         between them, so the straight line goes through a node it has nothing
         to do with. The lint catches this; the eye does not. */
      particles: [{ from: 'win', to: 'sink', color: C.data, via: [{ x: 95.5, y: 16.5 }, { x: 95.5, y: 41.5 }] }],
    },
    {
      title: 'What the whole path has in common',
      prose:
        'Three of those five steps were free and two were not, and the expensive two are the ones that cross a boundary: <b>the shuffle crosses machines, the state access crosses the serialization barrier.</b> Every tuning decision on this page is about one of those two. Chaining removes the first where it can; the state backend choice prices the second; and the next trace is about what happens to both of them when the pipeline cannot keep up.',
      focus: ['src', 'chain', 'win', 'rocks', 'sink'],
      particles: [],
    },
  ],
}

/** Chapter 2, trace 2 — the strangest mechanism in the system, and the
 *  one that turns a slow sink into a dead job: barrier alignment. */
export const alignmentTrace: TraceSpec = {
  title: 'Barrier alignment, and why a slow input stops a fast one',
  aspect: 0.52,
  zones: [
    { label: 'Two input channels', x: 2, y: 5, w: 44, h: 42 },
    { label: 'The operator', x: 50, y: 5, w: 46, h: 42 },
  ],
  nodes: [
    { id: 'fast', x: 5, y: 11, w: 38, h: 10, label: 'Input A · fast', sub: 'barrier arrived', color: C.op },
    { id: 'slow', x: 5, y: 30, w: 38, h: 10, label: 'Input B · backed up', sub: 'barrier far behind', color: C.bad },
    { id: 'op', x: 54, y: 12, w: 38, h: 10, label: 'Window operator', sub: 'waiting, idle', color: C.op },
    { id: 'snap', x: 54, y: 32, w: 38, h: 10, label: 'Snapshot', sub: 'cannot start yet', color: C.store },
  ],
  steps: [
    {
      title: 'A barrier is a record — that is the trick and the trap',
      prose:
        'To checkpoint without stopping, Flink injects <b>barriers into the data stream itself</b> and lets them flow with the records. Nothing is paused and no clock is consulted, which is the elegance. The consequence is the trap: <em>a barrier moves at exactly the speed of the data in front of it.</em> Barriers are not control messages on a side channel — they queue like everything else.',
      focus: ['fast', 'slow'],
      particles: [],
    },
    {
      title: 'The fast input delivers its barrier, and is immediately punished for it',
      prose:
        'Input A&rsquo;s barrier arrives first. The operator now knows checkpoint <i>n</i> has begun on that channel, and to keep the snapshot consistent it must not fold any post-barrier record from A into the state it is about to capture. So it <b>blocks channel A</b> and buffers everything arriving on it. The faster an input is, the more of it piles up while it waits.',
      focus: ['fast', 'op'],
      particles: [{ from: 'fast', to: 'op', color: C.data }],
    },
    {
      title: 'The slow input is where the time actually goes',
      prose:
        'Input B is backpressured — a slow sink downstream, a hot key, a GC pause, it does not matter which. Its barrier is sitting behind every record already queued ahead of it. The docs are blunt about what dominates here: <em>&ldquo;the dominant factor in the end-to-end time of a checkpoint can be the time to propagate checkpoint barriers to all operators/subtasks.&rdquo;</em> <b>Checkpoint duration has stopped being a function of how much state you have.</b>',
      focus: ['slow', 'op'],
      particles: [{ from: 'slow', to: 'op', color: C.bad }],
    },
    {
      title: 'Alignment time is the operator doing nothing, on purpose',
      prose:
        'Between A&rsquo;s barrier and B&rsquo;s, this operator processes nothing from A and holds whatever arrives. That gap is the <b>alignment time</b> metric, and it is pure stall. Worse, it is contagious: an operator that is not consuming is an operator applying backpressure to <em>its</em> upstream, so a single slow channel deep in the graph reaches back toward the sources one hop at a time.',
      focus: ['op', 'snap'],
      particles: [],
    },
    {
      title: 'Now check the defaults, because they are not on your side',
      prose:
        'A checkpoint that takes too long is discarded at the <b>10-minute default timeout</b>. And <code>tolerable-failed-checkpoints</code> defaults to <b>0</b> — so the <em>first</em> checkpoint that misses kills the job. The job restarts, replays from the last successful checkpoint, and arrives into a pipeline that is further behind than when it started. <b>That is the loop in chapter 6, and it is assembled entirely out of documented defaults.</b>',
      focus: ['op', 'snap'],
      particles: [{ from: 'op', to: 'snap', color: C.bad }],
    },
    {
      title: 'Unaligned checkpoints: let the barrier jump the queue',
      prose:
        'The escape hatch inverts the rule. With unaligned checkpoints the barrier <b>overtakes the buffered records</b>, and the in-flight data it jumped over is written into the snapshot instead — so the checkpoint captures the queue as well as the state. The docs put the win plainly: checkpoint duration <em>&ldquo;becomes independent of the current throughput.&rdquo;</em> The bill is equally plain: more bytes to the state store, on every checkpoint, forever. <b>It is off by default, and under sustained backpressure it is usually the right switch.</b>',
      focus: ['fast', 'slow', 'op', 'snap'],
      particles: [
        { from: 'slow', to: 'snap', color: C.data },
        { from: 'op', to: 'snap', color: C.store },
      ],
    },
  ],
}

/** Chapter 7 — a real deployment, and the pieces that are not the job. */
export const fleetTrace: TraceSpec = {
  title: 'What is actually deployed when you deploy one job',
  aspect: 0.52,
  zones: [
    { label: 'Control', x: 2, y: 5, w: 28, h: 42 },
    { label: 'The fleet', x: 33, y: 5, w: 31, h: 42 },
    { label: 'Durable', x: 67, y: 5, w: 30, h: 42 },
  ],
  nodes: [
    { id: 'jm', x: 4, y: 11, w: 24, h: 10, label: 'JobManager', sub: 'one, and HA', color: C.broker },
    { id: 'zk', x: 4, y: 30, w: 24, h: 10, label: 'ZooKeeper / k8s', sub: 'leader election', color: C.broker },
    { id: 'tm1', x: 36, y: 10, w: 25, h: 9, label: 'TaskManager', sub: '4 slots', color: C.op },
    { id: 'tm2', x: 36, y: 22, w: 25, h: 9, label: 'TaskManager', sub: '4 slots', color: C.op },
    { id: 'tm3', x: 36, y: 34, w: 25, h: 9, label: 'TaskManager', sub: '4 slots', color: C.op },
    { id: 'ckpt', x: 70, y: 11, w: 25, h: 10, label: 'Checkpoints', sub: 'S3 / HDFS', color: C.store },
    { id: 'save', x: 70, y: 30, w: 25, h: 10, label: 'Savepoints', sub: 'you own these', color: C.store },
  ],
  steps: [
    {
      title: 'One JobManager, and it is the thing you make redundant first',
      prose:
        'The JobManager holds the execution graph, triggers checkpoints, and decides what restarts. It is <b>a single point of coordination</b>, which is why a production deployment always runs it with high availability — standby JobManagers plus ZooKeeper or the Kubernetes API for leader election and metadata. Without HA, losing it loses the running job and every checkpoint pointer it was holding.',
      focus: ['jm', 'zk'],
      particles: [{ from: 'jm', to: 'zk', color: C.data }],
    },
    {
      title: 'TaskManagers are slots, and a slot is a slice of the machine',
      prose:
        'Each TaskManager offers a fixed number of <b>task slots</b> — <code>taskmanager.numberOfTaskSlots</code>, which defaults to <b>1</b> and is almost always raised. A slot takes one parallel slice of the whole pipeline, so slots are the unit you count: <em>a job of parallelism 12 needs 12 slots somewhere in the fleet</em>, and whether they sit on three machines or twelve changes the blast radius rather than the capacity.',
      focus: ['tm1', 'tm2', 'tm3'],
      particles: [
        { from: 'jm', to: 'tm1', color: C.data },
        { from: 'jm', to: 'tm2', color: C.data },
        { from: 'jm', to: 'tm3', color: C.data },
      ],
    },
    {
      title: 'The checkpoint store is where the job actually lives',
      prose:
        'Every TaskManager writes its slice of state to shared durable storage on each checkpoint. <b>This is the only copy that survives the fleet</b> — RocksDB on local disk is a working cache, not a home. The practical consequence is that your object store is on the critical path of a system you think of as in-memory, and its p99 write latency lands directly in your checkpoint duration.',
      focus: ['tm1', 'tm2', 'tm3', 'ckpt'],
      particles: [
        { from: 'tm1', to: 'ckpt', color: C.store },
        { from: 'tm2', to: 'ckpt', color: C.store },
        { from: 'tm3', to: 'ckpt', color: C.store },
      ],
    },
    {
      title: 'Savepoints are the ones with your name on them',
      prose:
        'A checkpoint is the engine&rsquo;s own recovery artifact, owned by the engine and cleaned up by it — the default retention discards them when the job stops. A <b>savepoint</b> is the operator-triggered equivalent you keep: for upgrades, for rescaling, for rolling back a bad deploy. <em>The difference is ownership, and the day you need one is not the day to find out you had none.</em>',
      focus: ['tm1', 'save'],
      particles: [{ from: 'tm1', to: 'save', color: C.store }],
    },
    {
      title: 'And the thing that restarts is bigger than the thing that broke',
      prose:
        'When one subtask dies, Flink restarts its whole <b>pipelined region</b> — for a job with an all-to-all shuffle, that is usually the entire graph. Every task redeploys, every slot re-downloads its state from the checkpoint store, and the job replays from the last successful checkpoint. <em>Recovery time is dominated by state download, not by the failure itself</em>, which is why state size per subtask is the number chapter 5 puts under your fingers.',
      focus: ['ckpt', 'tm1', 'tm2', 'tm3'],
      particles: [
        { from: 'ckpt', to: 'tm1', color: C.bad },
        { from: 'ckpt', to: 'tm2', color: C.bad },
        { from: 'ckpt', to: 'tm3', color: C.bad },
      ],
    },
  ],
}
