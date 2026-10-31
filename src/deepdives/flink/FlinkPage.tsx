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

const LIMITS: [string, string, string][] = [
  ['Max parallelism', '128 default · 2^15 ceiling', 'Key groups are the unit of state partitioning, and this is how many there are. Chosen on first run; the docs state there is no way to change it afterwards without discarding that operator’s state.'],
  ['Parallelism', '≤ max parallelism', 'A subtask owns whole key groups, so parallelism above the key-group count leaves the extra subtasks owning nothing at all.'],
  ['Checkpoint timeout', '10 min default', 'A checkpoint that does not finish is discarded. Under backpressure this measures barrier travel time, not state size.'],
  ['Tolerable failed checkpoints', '0 default', 'The single most consequential default on this page: one discarded checkpoint fails the whole job.'],
  ['Max concurrent checkpoints', '1 default', 'A checkpoint that overruns its interval delays the next rather than overlapping it, so slow checkpoints compound.'],
  ['RocksDB key / value size', '2^31 bytes each', 'Documented maximum per key and per value. A list-state accumulator that grows per event will find this eventually.'],
  ['Default state backend', 'HashMapStateBackend', 'On the JVM heap, bounded by RAM. Fast, and the reason many first production jobs die of an OOM rather than of slowness.'],
  ['Unaligned checkpoints', 'off by default', 'The switch that decouples checkpoint duration from throughput. Off is the right default for most jobs and the wrong one for any job under sustained backpressure.'],
]

const FAILS: [string, string][] = [
  ['The checkpoint death spiral', 'A downstream service slows by 30 ms; backpressure stalls barriers; checkpoints time out; the zero-tolerance default fails the job; the restart replays into a longer backlog and times out again. The whole of Chapter 6. Raise tolerable failures above zero and turn on unaligned checkpoints — then go fix the sink.'],
  ['The hot key nothing splits', 'One key — a null user id, a default tenant, a bot — routes to one key group, which lives on one subtask, forever. That subtask is at 100% while fifteen peers idle, and raising parallelism changes nothing. The fix is upstream: salt the key, or pre-aggregate before the keyBy.'],
  ['The max-parallelism regret', 'The job shipped at the default 128 and now needs 300-way parallelism. There is no online fix: you restart from a savepoint with a new max parallelism and rebuild the state, or you live at 128. Set this generously on day one — the metadata cost of a high ceiling is small and the cost of a low one is a migration.'],
  ['The silent watermark', 'One Kafka partition goes quiet. The watermark is the minimum across inputs, so it stops advancing, so windows never fire. Output dries up, window state grows without bound, and nothing alerts because throughput, backpressure and checkpoints all look perfect. Configure source idleness, and alert on watermark lag directly.'],
  ['The half-empty OOM', 'A 32 GB TaskManager dies of an OutOfMemoryError with heap graphs showing plenty of room. Managed memory took 0.4 of the process before user code saw any of it, and on a heap-state job that slice sits idle while the heap starves. Read the memory split before buying a bigger box.'],
  ['The broken chain', 'Someone adds a rebalance, or sets a different parallelism on one operator, and a chain that was a function call becomes serialize-network-deserialize. Throughput drops several-fold with no error, no warning, and no API signal. Check the execution plan, not the code.'],
  ['The poison record', 'An exception on one record fails the task; the job restarts from the checkpoint before that record; it reads the same record; it fails again. A restart loop that no amount of capacity fixes. Catch and side-output the undeserialisable, or the loop runs until a human reads a log.'],
  ['The savepoint nobody took', 'Checkpoint retention defaults to discarding on cancel. A job is cancelled for a deploy, the checkpoints go with it, and the only way back is to rebuild state from the source — if the source still has the data. Savepoints are the artifact you own; take one before every upgrade.'],
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
            Flink&apos;s bet is that a streaming job is a <b>standing physical pipeline</b> — deployed
            once, running forever, holding state — and that the thing worth making recoverable is{' '}
            <em>the state</em>, not the computation. That single decision explains nearly everything
            about operating it: why checkpointing is the central mechanism rather than a background
            chore, why a slow sink can kill a healthy job, why one hot key is immune to every machine
            you add, and why the most important number you will ever choose is one you pick on day
            one and cannot change. This page is about <b>the machine, not the algorithm</b> — what it
            does with your job, and where it breaks at 3am.
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
              You write a dataflow — sources, transformations, sinks — and Flink compiles it into a{' '}
              <b>JobGraph</b> of operators, then deploys that graph as long-lived tasks across a fleet
              of TaskManagers. Nothing is scheduled per batch; the pipeline simply exists, and records
              move through it. Keyed state is partitioned by <b>key group</b>, each group owned by
              exactly one subtask, and the engine — not your code — is responsible for persisting it,
              restoring it, and moving it when you rescale.
            </p>
            <p>
              Put that beside the other two bets this site covers. The Kafka page&apos;s broker is{' '}
              <em>dumb</em>: it tracks nothing per consumer and pushes all the intelligence to clients.
              Spark&apos;s answer to failure is <em>recompute</em>: keep the recipe, throw away the
              dish, rebuild it from immutable inputs. Flink can do neither, because its operators hold
              mutable state that took hours of stream to accumulate and no amount of replay rebuilds
              cheaply. <b>So it has to snapshot a moving system without stopping it</b> — and that
              requirement, not throughput, is the origin of every constraint below.
            </p>
            <div className="note">
              <b>The algorithm has its own chapter.</b> How you photograph a distributed system that
              will not hold still is a genuinely beautiful result — a 1985 algorithm with its
              expensive half deleted — and it is read properly in{' '}
              <Link to="/papers/flink-snapshots">the papers book</Link>, alongside what it cost and
              what it threw away. This page assumes it works and asks the operator&apos;s question
              instead: <em>what does it do to your Tuesday?</em>
            </div>
          </Ch>

          <Ch id="anatomy" n={2} title="Anatomy of a running job">
            <p>
              Press play and follow one record from a Kafka partition to a committed sink — through
              the chain that costs nothing, the shuffle that costs a serialization, and the state
              access whose price depends entirely on a backend you chose months ago:
            </p>
            <TracePlayer spec={recordTrace} />
            <p>
              That was the happy path. The second trace is the mechanism that makes Flink strange, and
              the one that turns an ordinary slow afternoon into an outage — <b>barrier alignment</b>.
              It is worth watching to the end: the last step is the switch most production jobs
              should have flipped and have not.
            </p>
            <TracePlayer spec={alignmentTrace} />
            <h3>The background cast</h3>
            <p>
              Around the record path runs machinery you never wrote: the <b>JobManager</b> triggering
              checkpoints on a timer and deciding what restarts; <b>RocksDB compaction</b> rewriting
              SSTables under your state, in bursts, on the same disk; the <b>watermark generator</b>{' '}
              deciding when event time has advanced enough to fire a window; <b>network buffer pools</b>{' '}
              handing out and reclaiming the memory that backpressure is made of; and the{' '}
              <b>checkpoint storage client</b> streaming state to an object store whose p99 you do not
              control. Every one of them reappears by name in the Chapter 6 runbook.
            </p>
          </Ch>

          <Ch id="hardware" n={3} title="The hardware envelope">
            <p>
              A TaskManager does not hand its memory to your operators. Flink carves the process up by
              documented fractions first — managed memory, network memory, JVM overhead, metaspace —
              and your code runs in what is left. That split is the single most surprising thing about
              sizing these machines, and the widget prints it. Pick a shape, pick a backend, and push:
            </p>
            <HardwareEnvelope />
            <p className="fl-src-note">
              Every fraction is a documented default from the{' '}
              <a href="https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/config/" target="_blank" rel="noreferrer">
                configuration reference
              </a>{' '}
              — managed <code>0.4</code>, network <code>0.1</code> (min 64 MB), JVM overhead{' '}
              <code>0.1</code> (192 MB–1 GB), metaspace <code>256 MB</code>, and{' '}
              <code>taskmanager.numberOfTaskSlots</code> defaulting to <code>1</code>. The two
              per-record costs are marked as assumptions because only your job can supply them.
            </p>
          </Ch>

          <Ch id="scale-up" n={4} title="Scaling up — slots are cheap, keys are not">
            <p>
              A bigger TaskManager genuinely helps, and in a pleasingly direct way: more cores run more
              slots, more RAM means more managed memory for RocksDB&apos;s block cache, faster local
              NVMe cuts state-access latency, and a bigger NIC carries more shuffle. Unlike the Redis
              page&apos;s single thread, Flink spreads happily across a large machine — up to one
              structural caveat, and it is the same caveat every time.
            </p>
            <p>
              <b>A key lives on exactly one subtask.</b> Hash the key, land in a key group, and that
              group belongs to one parallel slice for the life of the job. A hot key is therefore
              immune to hardware: a 64-core box runs that key on one core, exactly as an 8-core box
              would. The fix is never downward into the machine, it is upward into the data — salt the
              key, pre-aggregate before the exchange, or accept the skew and size for it.
            </p>
            <p>
              The second caveat is blast radius, and it bites harder here than on most pages. When a
              subtask dies, Flink restarts its whole <b>pipelined region</b> — which, for any job with
              an all-to-all shuffle in it, means the entire graph. Pack sixteen slots onto one
              TaskManager and a single JVM failure takes sixteen slices of the pipeline with it, each
              of which must re-download its state before anything moves. <em>Modest machines, more of
              them</em> is the same answer the Kafka and Redis pages reached, arrived at from a
              completely different direction.
            </p>
          </Ch>

          <Ch id="scale-out" n={5} title="Scaling out — one number decides the rest">
            <p>
              Flink&apos;s scaling question is rarely &ldquo;can it handle the event rate&rdquo;; slots
              answer that. It is <b>can this job still take a snapshot, and can it come back</b> — and
              both reduce to <b>state per subtask</b>. Sitting over all of it is max parallelism, the
              one ceiling you choose on day one and cannot raise without throwing the state away:
            </p>
            <Sandbox content={{ inputs: scaleOutInputs, compute: computeScaleOut }} />
            <div className="boundary">
              <h3>The scaling ladder — apply in order</h3>
              <ol className="ladder">
                <li><b>Set max parallelism generously, once.</b> Before the first production run. The metadata cost of a high ceiling is small; the cost of a low one is a state migration under pressure.</li>
                <li><b>Raise tolerable failed checkpoints above zero.</b> One line of configuration that converts the most common Flink outage into a logged blip. Almost every production job should have done this already.</li>
                <li><b>Turn on incremental checkpoints</b> (RocksDB only) — ship the delta rather than the whole slice. Cuts write cost and changes recovery not at all.</li>
                <li><b>Turn on unaligned checkpoints</b> if backpressure is chronic. Duration stops tracking throughput; you pay in bytes to the state store.</li>
                <li><b>Raise parallelism</b> to divide state per subtask — the lever that improves checkpointing <em>and</em> recovery together, up to the key-group ceiling.</li>
                <li><b>Shrink the state itself</b> — TTL on anything with a natural lifetime, a narrower accumulator, a pre-aggregation. The only move that makes every other number smaller.</li>
                <li><b>Split the job.</b> Two pipelines with independent checkpoints and independent blast radii beat one that restarts everything whenever any part of it stumbles.</li>
              </ol>
            </div>
          </Ch>

          <Ch id="ops" n={6} title="Operations: the pager view">
            <p>
              The defining Flink incident is not a crash and not a slowdown. It is a <b>restart loop
              assembled entirely out of documented defaults</b>, in which the job repeatedly fails for
              a reason that is three steps removed from the only thing actually broken. Play it, then
              keep the runbook:
            </p>
            <TracePlayer spec={cascadeTrace} />
            <h3>The metrics that matter — a runbook</h3>
            <p>
              Tap any metric for the full card: what healthy looks like, what a spike means, what
              breaks next, likely causes ranked common-to-rare, and what you actually do — safest
              action first.
            </p>
            <MetricRunbook cards={METRICS} />
            <div className="note">
              <b>The operating mindset.</b> Backpressure is the master signal and it is{' '}
              <em>directional</em> — it propagates upstream, so the fault is always below the alarm.
              The one diagnostic habit worth building: find the deepest task that is busy while its own
              downstream is <em>not</em> backpressured. That is the bottom of the chain, and the broken
              thing is immediately under it. Everything else on the dashboard — lag, checkpoint
              duration, failed checkpoints, restart count — is a consequence, and tuning any of them
              treats the alarm rather than the fire.
            </div>
          </Ch>

          <Ch id="bigfleet" n={7} title="What a large deployment looks like">
            <p>
              Flink at the top end is not one enormous job; it is an estate of thousands of modest
              ones, each with its own checkpoint cadence and blast radius, sharing a fleet. The largest
              published numbers come from Alibaba&apos;s 2020 Double 11, and they are worth stating
              because they bound the argument: whatever your job is doing, the engine is not the thing
              that cannot scale.
            </p>
            <div className="bigfacts">
              <div className="bigfact"><div className="bf-v">4 billion</div><div className="bf-k">records per second</div><div className="bf-s">peak, Double 11 2020</div></div>
              <div className="bigfact"><div className="bf-v">7 TB/s</div><div className="bf-k">peak data volume</div><div className="bf-s">same event</div></div>
              <div className="bigfact"><div className="bf-v">1.5M+</div><div className="bf-k">CPUs</div><div className="bf-s">the platform behind it</div></div>
              <div className="bigfact"><div className="bf-v">35,000+</div><div className="bf-k">streaming jobs</div><div className="bf-s">not one big pipeline</div></div>
            </div>
            <p>
              Below, what is actually deployed when you deploy one job — the JobManager you must make
              redundant, the slots that are the real unit of capacity, the object store that is quietly
              on your critical path, and the difference between a checkpoint and a savepoint that
              matters exactly once, on the worst day:
            </p>
            <TracePlayer spec={fleetTrace} />
            <p className="fl-src-note">
              Peak figures from Alibaba Cloud&apos;s own write-up of{' '}
              <a href="https://www.alibabacloud.com/blog/four-billion-records-per-second-what-is-behind-alibaba-double-11---flink-stream-batch-unification-practice-during-double-11-for-the-very-first-time_596962" target="_blank" rel="noreferrer">
                Double 11 2020
              </a>
              . The original ABS paper&apos;s own evaluation is far smaller and more honest about
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
                    <td>{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="fails">
              {FAILS.map((f) => (
                <div className="fail" key={f[0]}>
                  <div className="fn">{f[0]}</div>
                  <p className="fd">{f[1]}</p>
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
                <p>Eight pages, one algorithm, one graph of results — the mechanism this whole page is organised around. The contribution is a <em>deletion</em>: Chandy-Lamport with the channel state removed, justified by a property dataflow graphs happen to have. Read it for how small a real contribution can be.</p>
              </div>
              <div className="src">
                <div className="s-k">The docs</div>
                <a href="https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpointing_under_backpressure/" target="_blank" rel="noreferrer">
                  Flink documentation — “Checkpointing under backpressure”
                </a>
                <p>Short, and the single most useful operational page Flink publishes. It states plainly that barrier propagation — not state size — dominates checkpoint time under load, and then gives you the two switches. If you read one link here, read this one before your first incident rather than during it.</p>
              </div>
              <div className="src">
                <div className="s-k">The checklist</div>
                <a href="https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/production_ready/" target="_blank" rel="noreferrer">
                  Flink documentation — the production readiness checklist
                </a>
                <p>Two items long and both are decisions you cannot take back: set operator UUIDs, and choose max parallelism deliberately. The sentence worth memorising is the one about there being no way to change max parallelism afterwards without discarding state.</p>
              </div>
              <div className="src">
                <div className="s-k">The war story</div>
                <a href="https://www.alibabacloud.com/blog/four-billion-records-per-second-what-is-behind-alibaba-double-11---flink-stream-batch-unification-practice-during-double-11-for-the-very-first-time_596962" target="_blank" rel="noreferrer">
                  Alibaba Cloud — four billion records per second at Double 11
                </a>
                <p>The scale ceiling, documented by the people who hit it. Read it less for the headline number than for the shape it implies: tens of thousands of separate jobs rather than one colossus, which is the architectural advice hiding inside a marketing post.</p>
              </div>
              <div className="src">
                <div className="s-k">The book</div>
                <a href="https://www.oreilly.com/library/view/streaming-systems/9781491983867/" target="_blank" rel="noreferrer">
                  Akidau, Chernyak &amp; Lax — “Streaming Systems”
                </a>
                <p>Not about Flink, and the right book anyway. Event time, watermarks, windowing and the question of when you are allowed to emit an answer — the conceptual layer underneath every windowing decision this page treats as given. The animations alone are worth the evening.</p>
              </div>
            </div>
          </Ch>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
