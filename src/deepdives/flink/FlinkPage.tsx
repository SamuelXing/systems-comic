import { Link } from 'react-router-dom'
import SiteNav from '../../components/SiteNav'
import SiteFooter from '../../components/SiteFooter'
import IdeaStrip from '../../components/IdeaStrip'
import TracePlayer from '../../components/TracePlayer'
import MetricRunbook from '../../components/MetricRunbook'
import { Sandbox } from '../ModulePanel'
import HardwareEnvelope from './HardwareEnvelope'
import { recordTrace, alignmentTrace, fleetTrace } from './traces'
import { computeScaleOut, scaleOutInputs } from './scaleout'
import { METRICS, cascadeTrace } from './ops'

const CHAPTERS = [
  { id: 'abstraction', n: 1, title: 'The core abstraction' },
  { id: 'anatomy', n: 2, title: 'Anatomy of a running job' },
  { id: 'hardware', n: 3, title: 'The hardware envelope' },
  { id: 'scale-up', n: 4, title: 'Scaling up' },
  { id: 'scale-out', n: 5, title: 'Scaling out' },
  { id: 'ops', n: 6, title: 'Operations: the pager view' },
  { id: 'bigfleet', n: 7, title: 'What a large deployment looks like' },
  { id: 'boundaries', n: 8, title: 'Boundaries & failures' },
  { id: 'sources', n: 9, title: 'Primary sources' },
]

const CH_ID: Record<number, string> = Object.fromEntries(CHAPTERS.map((c) => [c.n, c.id]))

/* Turn "Chapter N" inside a plain string into an in-page link to that chapter. */
function withChapterLinks(text: string): React.ReactNode[] {
  return text.split(/(Chapter \d(?!\d))/).map((part, i) => {
    const m = /^Chapter (\d)$/.exec(part)
    return m ? <a key={i} href={'#' + CH_ID[Number(m[1])]}>{part}</a> : part
  })
}

const LIMITS: [string, string, string][] = [
  ['Max parallelism', '128 default · 2^15 ceiling', 'Key groups are the unit of state partitioning, and this is how many there are. It is chosen on the first run, and the documentation states that it cannot be changed afterwards without discarding that operator\u2019s state.'],
  ['Parallelism', '≤ max parallelism', 'A subtask owns whole key groups, so parallelism above the key-group count leaves the extra subtasks owning nothing.'],
  ['Checkpoint timeout', '10 min default', 'A checkpoint that does not finish in time is discarded. Under backpressure this measures how long barriers take to travel, not how much state there is.'],
  ['Tolerable failed checkpoints', '0 default', 'The most consequential default on this page: a single discarded checkpoint fails the whole job.'],
  ['Max concurrent checkpoints', '1 default', 'A checkpoint that overruns its interval delays the next one rather than overlapping it, so slow checkpoints compound.'],
  ['RocksDB key / value size', '2^31 bytes each', 'The documented maximum per key and per value. A list-state accumulator that grows with every event will reach it eventually.'],
  ['Default state backend', 'HashMapStateBackend', 'State lives on the JVM heap and is bounded by RAM. It is fast, and it is the reason many first production jobs die of an OutOfMemoryError rather than of slowness.'],
  ['Unaligned checkpoints', 'off by default', 'The switch that decouples checkpoint duration from throughput. Off is the right default for most jobs, and the wrong one for any job under sustained backpressure.'],
]

const FAILS: [string, string][] = [
  ['The checkpoint death spiral', 'A downstream service slows by 30 ms; backpressure stalls the barriers; checkpoints time out; the zero-tolerance default fails the job; the restart replays into a longer backlog and times out again. This is the whole of Chapter 6. Raise tolerable failed checkpoints above zero, turn on unaligned checkpoints, and then fix the sink.'],
  ['The hot key nothing splits', 'One key, such as a null user id, a default tenant or a bot, routes to one key group, which lives on one subtask for the life of the job. That subtask runs at 100% while fifteen peers sit idle, and raising parallelism changes nothing. The fix is upstream: salt the key, or pre-aggregate before the keyBy.'],
  ['The max-parallelism regret', 'The job shipped at the default of 128 and now needs 300-way parallelism. There is no online fix: either restart from a savepoint with a new max parallelism and rebuild the state, or stay at 128. Set this generously on the first day, since the metadata cost of a high ceiling is small and the cost of a low one is a migration.'],
  ['The silent watermark', 'One Kafka partition goes quiet. The watermark is the minimum across inputs, so it stops advancing, so windows never fire. Output dries up, window state grows without bound, and nothing alerts, because throughput, backpressure and checkpoints all look healthy. Configure source idleness, and alert on watermark lag directly.'],
  ['The half-empty OOM', 'A 32 GB TaskManager dies of an OutOfMemoryError while the heap graphs show plenty of room. Managed memory took 0.4 of the process before user code saw any of it, and on a heap-state job that slice sits idle while the heap starves. Read the memory split in Chapter 3 before buying a bigger machine.'],
  ['The broken chain', 'Someone adds a rebalance, or gives one operator a different parallelism, and a chain that was a function call becomes a serialise, send and deserialise round trip. Throughput drops several-fold with no error, no warning and no signal from the API. Check the execution plan, not the code.'],
  ['The poison record', 'An exception on one record fails the task; the job restarts from the checkpoint before that record; it reads the same record and fails again. This is a restart loop that no amount of capacity fixes. Catch and side-output records that cannot be deserialised, or the loop continues until a human reads a log.'],
  ['The savepoint nobody took', 'Checkpoint retention defaults to discarding checkpoints when a job is cancelled. A job is cancelled for a deploy, the checkpoints go with it, and the only way back is to rebuild the state from the source, if the source still has the data. Savepoints are the artifact you own; take one before every upgrade.'],
]

function Ch({ id, n, title, children }: { id: string; n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="chapter" id={id}>
      <div className="ch-head">
        <span className="ch-num">{n}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
}

export default function FlinkPage() {
  return (
    <div className="dd-page fl-page">
      <SiteNav />
      <main className="wrap fl-wrap">
        <aside className="fl-toc">
          <div className="fl-toc-title">Apache Flink</div>
          {CHAPTERS.map((c) => (
            <a key={c.id} href={'#' + c.id}>
              <span>{c.n}</span> {c.title}
            </a>
          ))}
          <Link className="fl-toc-back" to="/ddia/components">
            ← All components
          </Link>
        </aside>

        <div className="fl-body">
          <p className="h-kicker">Deep-dive · stream processor</p>
          <h1 className="title">Apache Flink</h1>
          <p className="lede">
            Flink&apos;s defining decision is that a streaming job is a <em>standing pipeline</em>,
            deployed once and left running, holding state as it goes, and that what needs to be
            made recoverable is that state rather than the computation. That decision explains
            most of what matters when operating it: why checkpointing is the central mechanism
            rather than a background chore, why a slow sink can bring down a healthy job, why one
            hot key is unaffected by any machine you add, and why the most consequential number
            you will choose is one you set on the first day and cannot change afterwards. This
            page is about the machine rather than the algorithm: what it does with your job, and
            where it breaks.
          </p>

          <IdeaStrip
            ideas={[
              { slug: 'backpressure', label: 'Backpressure' },
              { slug: 'exactly-once', label: 'Exactly-Once' },
              { slug: 'stream-table', label: 'Stream–Table Duality' },
            ]}
          />

          <Ch id="abstraction" n={1} title="The core abstraction: state the engine owns">
            <p>
              Consider what a stream processor has to do. Events arrive continuously, and the job
              maintains some running computation over them: a count per user over the last hour,
              a join between two streams, a running average. That computation has <em>state</em>,
              which can take hours of events to build up, and the machines running it will fail
              from time to time. The question is what happens to the state when they do.
            </p>
            <p>
              There are two established answers, and this site has a page on each. The{' '}
              <Link to="/ddia/components/kafka">Kafka</Link> broker keeps no state about its
              consumers at all, so the broker never has to recover any; the intelligence, and the
              state, live in the clients, and recovering them is the client&apos;s problem.
              Spark&apos;s answer is to recompute: keep the recipe, discard the result, and
              rebuild it from immutable inputs. Neither fits here. Flink&apos;s operators hold
              mutable state that took hours of stream to accumulate, and no amount of replay
              rebuilds that cheaply. So Flink takes a third course: the engine itself owns the
              state, and periodically takes a consistent snapshot of a system that is still
              running. That requirement, rather than throughput, is the origin of every
              constraint on this page.
            </p>
            <p>
              In practice, you write a dataflow of sources, transformations and sinks, and Flink
              compiles it into a <em>JobGraph</em> of operators, then deploys that graph as
              long-lived tasks across a fleet of TaskManagers. Nothing is scheduled per batch;
              the pipeline simply exists, and records move through it. Keyed state is partitioned
              into <em>key groups</em>, each owned by exactly one subtask, and the engine rather
              than your code is responsible for persisting that state, restoring it after a
              failure, and moving it when the job is rescaled.
            </p>
            <div className="note">
              <b>The algorithm has its own chapter.</b> How to photograph a distributed system
              that will not hold still is a genuinely elegant result, a 1985 algorithm with its
              expensive half removed, and it is read properly in{' '}
              <Link to="/papers/flink-snapshots">the papers book</Link>, together with what it
              cost and what it gave up. This page assumes that it works and asks the
              operator&apos;s question instead: what does it do to your job on an ordinary day?
            </div>
          </Ch>

          <Ch id="anatomy" n={2} title="Anatomy of a running job">
            <p>
              Press play and follow one record from a Kafka partition to a committed sink: through
              the chain of operators that costs nothing, the shuffle that costs a serialisation,
              and the state access whose price depends entirely on a backend you chose months
              ago.
            </p>
            <TracePlayer spec={recordTrace} />
            <p>
              That was the ordinary path. The second trace shows the mechanism that makes Flink
              unusual, and the one that turns an ordinary slow afternoon into an outage:{' '}
              <em>barrier alignment</em>. It is worth watching to the end, because the last step
              is a configuration switch that most production jobs should have turned on and have
              not.
            </p>
            <TracePlayer spec={alignmentTrace} />
            <h3>The background cast</h3>
            <p>
              Around the record path runs machinery you did not write. The <em>JobManager</em>{' '}
              triggers checkpoints on a timer and decides what restarts after a failure. RocksDB
              compaction rewrites SSTables beneath your state, in bursts, on the same disk. The
              watermark generator decides when event time has advanced far enough to fire a
              window. Network buffer pools hand out and reclaim the memory that backpressure is
              made of. And the checkpoint storage client streams state to an object store whose
              tail latency you do not control. Each of these reappears by name in the{' '}
              <a href="#ops">Chapter 6</a> runbook.
            </p>
          </Ch>

          <Ch id="hardware" n={3} title="The hardware envelope">
            <p>
              A TaskManager does not hand its memory to your operators. Flink first divides the
              process according to documented fractions, into managed memory, network memory,
              JVM overhead and metaspace, and your code runs in whatever remains. That split is
              the most surprising thing about sizing these machines, and the widget below prints
              it. Pick a shape and a state backend, and push the workload until a meter turns
              red.
            </p>
            <HardwareEnvelope />
            <p className="fl-src-note">
              Every fraction is a documented default from the{' '}
              <a href="https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/config/" target="_blank" rel="noreferrer">
                configuration reference
              </a>
              : managed <code>0.4</code>, network <code>0.1</code> (at least 64 MB), JVM overhead{' '}
              <code>0.1</code> (between 192 MB and 1 GB), metaspace <code>256 MB</code>, and{' '}
              <code>taskmanager.numberOfTaskSlots</code> defaulting to <code>1</code>. The two
              per-record costs are marked as assumptions because only your job can supply them.
            </p>
          </Ch>

          <Ch id="scale-up" n={4} title="Scaling up — slots are cheap, keys are not">
            <p>
              A bigger TaskManager genuinely helps, and in a fairly direct way: more cores run
              more slots, more memory means more managed memory for RocksDB&apos;s block cache,
              faster local NVMe reduces state-access latency, and a larger network interface
              carries more shuffle traffic. Unlike <Link to="/ddia/components/redis">Redis</Link>,
              which is bound to a single thread, Flink spreads comfortably across a large
              machine. There is one structural caveat, and it is the same one every time.
            </p>
            <p>
              A key lives on exactly one subtask. The key is hashed to a key group, and that group
              belongs to one parallel slice of the job for as long as the job runs. A hot key is
              therefore unaffected by hardware: a 64-core machine runs that key on one core,
              exactly as an 8-core machine would. The remedy is never in the machine but in the
              data: salt the key, pre-aggregate before the exchange, or accept the skew and size
              for it.
            </p>
            <p>
              The second caveat is the size of a failure, and it matters more here than on most
              pages. When a subtask dies, Flink restarts its whole <em>pipelined region</em>,
              which for any job containing an all-to-all shuffle means the entire graph. Pack
              sixteen slots onto one TaskManager and a single JVM failure takes sixteen slices of
              the pipeline with it, each of which must download its state again before anything
              moves. Modest machines, and more of them, is the same conclusion the Kafka and Redis
              pages reached, arrived at from a different direction.
            </p>
          </Ch>

          <Ch id="scale-out" n={5} title="Scaling out — one number decides the rest">
            <p>
              Flink&apos;s scaling question is rarely whether it can handle the event rate; slots
              answer that. The question is whether the job can still take a snapshot, and whether
              it can come back after a failure, and both reduce to the amount of{' '}
              <em>state per subtask</em>. Above all of it sits max parallelism, the one ceiling
              chosen on the first day that cannot be raised without discarding the state.
            </p>
            <Sandbox content={{ inputs: scaleOutInputs, compute: computeScaleOut }} />
            <div className="boundary">
              <h3>The scaling ladder — apply in order</h3>
              <ol className="ladder">
                <li><b>Set max parallelism generously, once,</b> before the first production run. The metadata cost of a high ceiling is small; the cost of a low one is a state migration under pressure.</li>
                <li><b>Raise tolerable failed checkpoints above zero.</b> One line of configuration converts the most common Flink outage into a logged blip. Almost every production job should have done this already.</li>
                <li><b>Turn on incremental checkpoints</b> (RocksDB only), so that each checkpoint ships the delta rather than the whole slice. This reduces write cost and leaves recovery unchanged.</li>
                <li><b>Turn on unaligned checkpoints</b> if backpressure is chronic. Checkpoint duration then stops tracking throughput; the price is more bytes to the state store.</li>
                <li><b>Raise parallelism</b> to divide state per subtask. This is the one lever that improves checkpointing and recovery together, up to the key-group ceiling.</li>
                <li><b>Shrink the state itself:</b> a TTL on anything with a natural lifetime, a narrower accumulator, a pre-aggregation. This is the only move that makes every other number smaller.</li>
                <li><b>Split the job.</b> Two pipelines with independent checkpoints and independent failure domains are better than one that restarts everything whenever any part of it stumbles.</li>
              </ol>
            </div>
          </Ch>

          <Ch id="ops" n={6} title="Operations: the pager view">
            <p>
              The defining Flink incident is neither a crash nor a slowdown. It is a restart loop
              assembled entirely out of documented defaults, in which the job repeatedly fails for
              a reason three steps removed from the only thing that is actually broken. Play it,
              and then keep the runbook that follows.
            </p>
            <TracePlayer spec={cascadeTrace} />
            <h3>The metrics that matter — a runbook</h3>
            <p>
              Select any metric to see its full card: what a healthy value looks like, what a
              change in it means, what breaks next, the likely causes from most to least common,
              and what to do about it, starting with the safest action.
            </p>
            <MetricRunbook cards={METRICS} />
            <div className="note">
              <b>The operating mindset.</b> Backpressure is the master signal, and it has a
              direction: it propagates upstream, so the fault is always downstream of the alarm.
              The one diagnostic habit worth building is to find the deepest task that is busy
              while its own downstream is not backpressured. That is the bottom of the chain, and
              the broken thing is immediately below it. Everything else on the dashboard, lag,
              checkpoint duration, failed checkpoints, restart count, is a consequence, and tuning
              any of them treats the alarm rather than the fault.
            </div>
          </Ch>

          <Ch id="bigfleet" n={7} title="What a large deployment looks like">
            <p>
              Flink at the top end is not one enormous job but an estate of thousands of modest
              ones, each with its own checkpoint cadence and its own failure domain, sharing a
              fleet. The largest published figures come from Alibaba&apos;s Double 11 in 2020,
              and they are worth stating because they bound the argument: whatever your job is
              doing, the engine is not the thing that fails to scale.
            </p>
            <div className="bigfacts">
              <div className="bigfact"><div className="bf-v">4 billion</div><div className="bf-k">records per second</div><div className="bf-s">peak, Double 11 2020</div></div>
              <div className="bigfact"><div className="bf-v">7 TB/s</div><div className="bf-k">peak data volume</div><div className="bf-s">same event</div></div>
              <div className="bigfact"><div className="bf-v">1.5M+</div><div className="bf-k">CPUs</div><div className="bf-s">the platform behind it</div></div>
              <div className="bigfact"><div className="bf-v">35,000+</div><div className="bf-k">streaming jobs</div><div className="bf-s">not one big pipeline</div></div>
            </div>
            <p>
              The trace below shows what is actually deployed when you deploy one job: the
              JobManager that has to be made redundant, the slots that are the real unit of
              capacity, the object store that is quietly on the critical path, and the difference
              between a checkpoint and a savepoint, which matters exactly once, on the worst day.
            </p>
            <TracePlayer spec={fleetTrace} />
            <p className="fl-src-note">
              Peak figures from Alibaba Cloud&apos;s own account of{' '}
              <a href="https://www.alibabacloud.com/blog/four-billion-records-per-second-what-is-behind-alibaba-double-11---flink-stream-batch-unification-practice-during-double-11-for-the-very-first-time_596962" target="_blank" rel="noreferrer">
                Double 11 2020
              </a>
              . The original ABS paper&apos;s evaluation is far smaller and more explicit about
              method: 1 billion records through 6 operators and 3 full shuffles, on up to 40 EC2{' '}
              <code>m3.medium</code> instances, showing linear scaling from 5 to 40 nodes.
            </p>
          </Ch>

          <Ch id="boundaries" n={8} title="Boundaries & failure modes">
            <table className="tbl">
              <thead>
                <tr><th>Limit</th><th>Rough value</th><th>Why it matters</th></tr>
              </thead>
              <tbody>
                {LIMITS.map((r) => (
                  <tr key={r[0]}>
                    <td>{r[0]}</td>
                    <td><code>{r[1]}</code></td>
                    <td>{withChapterLinks(r[2])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="fails">
              {FAILS.map((f) => (
                <div className="fail" key={f[0]}>
                  <div className="fn">{f[0]}</div>
                  <p className="fd">{withChapterLinks(f[1])}</p>
                </div>
              ))}
            </div>
          </Ch>

          <Ch id="sources" n={9} title="Primary sources — read the real thing">
            <div className="srcs">
              <div className="src">
                <div className="s-k">The paper</div>
                <a href="https://arxiv.org/abs/1506.08603" target="_blank" rel="noreferrer">
                  Carbone et al. — “Lightweight Asynchronous Snapshots for Distributed Dataflows” (2015)
                </a>
                <p>Eight pages, one algorithm, one graph of results: the mechanism this whole page is organised around. The contribution is a <em>deletion</em>, Chandy-Lamport with the channel state removed, justified by a property that dataflow graphs happen to have. Read it to see how small a genuine contribution can be.</p>
              </div>
              <div className="src">
                <div className="s-k">The docs</div>
                <a href="https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpointing_under_backpressure/" target="_blank" rel="noreferrer">
                  Flink documentation — “Checkpointing under backpressure”
                </a>
                <p>Short, and the most useful operational page Flink publishes. It states plainly that barrier propagation, not state size, dominates checkpoint time under load, and then gives you the two switches. If you read one link on this page, read this one before your first incident rather than during it.</p>
              </div>
              <div className="src">
                <div className="s-k">The checklist</div>
                <a href="https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/production_ready/" target="_blank" rel="noreferrer">
                  Flink documentation — the production readiness checklist
                </a>
                <p>Two items long, and both are decisions you cannot take back: set operator UUIDs, and choose max parallelism deliberately. The sentence worth remembering is the one stating that max parallelism cannot be changed afterwards without discarding state.</p>
              </div>
              <div className="src">
                <div className="s-k">The war story</div>
                <a href="https://www.alibabacloud.com/blog/four-billion-records-per-second-what-is-behind-alibaba-double-11---flink-stream-batch-unification-practice-during-double-11-for-the-very-first-time_596962" target="_blank" rel="noreferrer">
                  Alibaba Cloud — four billion records per second at Double 11
                </a>
                <p>The scale ceiling, documented by the people who reached it. Read it less for the headline number than for the shape it implies: tens of thousands of separate jobs rather than one colossus, which is architectural advice hiding inside a marketing post.</p>
              </div>
              <div className="src">
                <div className="s-k">The book</div>
                <a href="https://www.oreilly.com/library/view/streaming-systems/9781491983867/" target="_blank" rel="noreferrer">
                  Akidau, Chernyak &amp; Lax — “Streaming Systems”
                </a>
                <p>Not about Flink, and the right book anyway. Event time, watermarks, windowing and the question of when you are allowed to emit an answer: the conceptual layer beneath every windowing decision this page treats as given. The animations alone are worth an evening.</p>
              </div>
            </div>
          </Ch>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
