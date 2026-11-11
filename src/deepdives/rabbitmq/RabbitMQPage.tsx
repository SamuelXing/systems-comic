import { Link } from 'react-router-dom'
import SiteNav from '../../components/SiteNav'
import SiteFooter from '../../components/SiteFooter'
import IdeaStrip from '../../components/IdeaStrip'
import TracePlayer from '../../components/TracePlayer'
import MetricRunbook from '../../components/MetricRunbook'
import { Sandbox } from '../ModulePanel'
import HardwareEnvelope from './HardwareEnvelope'
import { publishTrace, beamTrace, estateTrace } from './traces'
import { computeScaleOut, scaleOutInputs } from './scaleout'
import { METRICS, cascadeTrace } from './ops'

const CHAPTERS = [
  { id: 'abstraction', n: 1, title: 'The core abstraction' },
  { id: 'anatomy', n: 2, title: 'Anatomy of the broker' },
  { id: 'hardware', n: 3, title: 'The hardware envelope' },
  { id: 'scale-up', n: 4, title: 'Scaling up' },
  { id: 'scale-out', n: 5, title: 'Scaling out' },
  { id: 'ops', n: 6, title: 'Operations: the pager view' },
  { id: 'bigfleet', n: 7, title: 'What a real estate looks like' },
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
  ['Throughput / queue', '~50k msg/s transient', 'One queue is one Erlang process, which runs on one core. Durability discounts this steeply: quorum queues reach a fraction of transient throughput.'],
  ['Scaling unit', 'more queues', 'Consumers on one queue share its single process. Past that ceiling only sharding, with a consistent-hash exchange, adds capacity.'],
  ['Backlog', 'RAM until paged', 'Messages wait in process heaps with per-message bookkeeping. A deep backlog first degrades the queue that holds it, then threatens the node.'],
  ['Memory alarm', '40% of RAM', 'The watermark. Crossing it blocks every publishing connection across the cluster, which makes it the most important line in RabbitMQ operations.'],
  ['Durability', 'majority fsync', 'A quorum queue confirms a message after a Raft majority has persisted it. The guarantee is real, and it is priced per message in latency and disk.'],
  ['Message lifetime', 'deleted on ack', 'A message is a task rather than a record: consumed once, then gone. There is no replay and no second reader; streams exist for that.'],
  ['Connections & channels', 'stateful, costly', 'Each needs a multi-round-trip handshake and a broker-side process. Long-lived connections are mandatory; churn is a denial of service you run against yourself.'],
]

const FAILS: [string, string][] = [
  ['The slow-consumer freeze', 'A consumer deploy hangs; depth grows; the watermark trips; every publisher in the company blocks. This is the full Chapter 6 cascade. Alert on the depth trend and on consumer utilisation, and give every queue a bulkhead.'],
  ['The single fat queue', 'All traffic passes through one queue, which caps the system at one core while sixteen consumers sit idle, and the postmortem blames RabbitMQ performance. Shard before the ceiling, not after it.'],
  ['Poison requeue loop', 'A malformed message fails, is requeued, and comes back forever, so one core burns on a task that cannot succeed while real work queues behind it. A retry cap and a dead-letter exchange belong on every queue.'],
  ['The prefetch hoarder', 'One consumer with unlimited prefetch takes the entire backlog; its peers starve; its memory balloons; and when it dies, everything is redelivered at once. Set prefetch everywhere; unlimited is never correct.'],
  ['Memory-alarm gridlock', 'Team A\u2019s backlog freezes team B\u2019s publishers, who retry harder, holding connections open and keeping the pressure on. Per-vhost limits and max-length turn a company-wide freeze back into one team\u2019s bad day.'],
  ['Connection-per-message churn', 'An integration opens a connection, publishes once, and closes it, thousands of times a second. The node spends itself on handshakes and throughput collapses while every queue is empty. Fix the client, not the broker.'],
  ['The partition surprise', 'A network blip splits the cluster, and pause_minority correctly halts the minority side, but nobody knew which services were connected to it. Know your partition-handling mode before the partition does.'],
  ['The queue as a database', 'Using the backlog as storage, on the theory that consumers will catch up eventually, parks the system permanently next to the watermark. RabbitMQ is a conveyor; if data must rest, it belongs in a log such as Kafka or a store such as Postgres.'],
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

export default function RabbitMQPage() {
  return (
    <div className="dd-page fl-page">
      <SiteNav />
      <main className="wrap fl-wrap">
        <aside className="fl-toc">
          <div className="fl-toc-title">RabbitMQ</div>
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
          <p className="h-kicker">Deep-dive · message broker</p>
          <h1 className="title">RabbitMQ</h1>
          <p className="lede">
            RabbitMQ makes the opposite decision from Kafka, and made it a decade earlier: the
            intelligence lives in the <em>broker</em>. Routing, delivery tracking, per-message
            acknowledgement, retries and dead-lettering are all the broker&apos;s job, so that
            clients stay simple and a message behaves like a task rather than like an entry in a
            log. Each of its strengths (routing topologies, backpressure, work distribution) and
            each of its constraints (the one-core queue, the memory watermark, the absence of
            replay) follows from that one choice. This page walks the system in the order you
            would want it explained: what the broker does with one message, what hardware that
            consumes, and only then how it scales.
          </p>

          <IdeaStrip
            ideas={[
              { slug: 'backpressure', label: 'Backpressure' },
              { slug: 'stream-table', label: 'Stream–Table Duality' },
            ]}
          />

          <Ch id="abstraction" n={1} title="The core abstraction: the smart broker">
            <p>
              Consider the problem a message broker was invented for. One service has a piece of
              work that another should do: send this email, charge this card, resize this image.
              The producer does not want to know which service will do it, how many instances
              there are, or whether any of them is running right now. It does want each task done
              once, retried if the worker fails midway, and set aside for a human if it keeps
              failing.
            </p>
            <p>
              There are two obvious ways to get this without a broker. A table in a database
              works as a queue: workers poll it, lock a row, do the work and delete the row. That
              costs a poll loop per worker and lock contention under load, and fan-out to several
              consumers means several tables. <Link to="/ddia/components/kafka">Kafka&apos;s
              log</Link> keeps the broker simple by making each consumer track its own position,
              which gives replay and enormous throughput, but it has no notion of an individual
              message being done, retried, or routed to one queue rather than another.
            </p>
            <p>
              The AMQP model that RabbitMQ implements is three objects and a contract. Producers
              publish to <em>exchanges</em>, which are named routers. An exchange matches its{' '}
              <em>bindings</em>, which are routing rules, to deliver a copy of the message into
              one or more <em>queues</em>. Queues push messages to consumers, and a consumer must{' '}
              <em>acknowledge</em> each message, at which point it is deleted. The broker owns the
              whole lifecycle: it knows every delivery that has not yet been acknowledged,
              redelivers after a failure, expires, dead-letters and prioritizes. A message is a
              unit of work with a chain of custody, and the broker is the custodian.
            </p>
            <p>
              The cost of keeping the intelligence in the broker is paid per message: routing
              computation, delivery state, and acknowledgement bookkeeping for every one. That
              price sets every ceiling in <a href="#hardware">Chapter 3</a>. What it buys is a set of semantics a log
              cannot express: deliver this message to these queues, retry it three times, then
              park it for a human.
            </p>
            <div className="note">
              <b>The lineage.</b> Kafka is built on the log, Postgres on the write-ahead log and
              MVCC, Redis on RAM and a single thread. RabbitMQ is built on the{' '}
              <em>actor model</em>: every queue, channel and connection is an isolated Erlang
              process that communicates by passing messages. The broker for messages is itself
              made of message passing, and its scaling law, which the second trace in <a href="#anatomy">Chapter 2</a>
              shows, follows directly from that.
            </div>
          </Ch>

          <Ch id="anatomy" n={2} title="Anatomy of the broker">
            <p>
              Press play and follow one message from <code>basic.publish</code> to the
              acknowledgement that deletes it, through the exchange, the binding trie, the queue
              process and the prefetch window.
            </p>
            <TracePlayer spec={publishTrace} />
            <p>
              The trace above is the ordinary path through one queue. The second trace shows the
              most consequential fact about the system, what a queue actually is, and what
              happens on the day the consumers slow down.
            </p>
            <TracePlayer spec={beamTrace} />
            <h3>The background cast</h3>
            <p>
              Around the message path runs the maintenance machinery. The management and metrics
              database aggregates statistics from every process, and its user interface is the
              operations console of <a href="#ops">Chapter 6</a>. Raft ticks keep the members of each quorum queue
              in step. The message store compacts its segment files. Erlang&apos;s garbage
              collector runs per process, collecting each actor&apos;s heap independently. And
              cluster heartbeats watch for network partitions. Each of these reappears by name in
              the runbook.
            </p>
          </Ch>

          <Ch id="hardware" n={3} title="The hardware envelope">
            <p>
              RabbitMQ&apos;s envelope has two sides. Across queues, it scales like an ordinary
              multicore system, because the BEAM spreads processes over every core. Within a
              queue, it behaves like <Link to="/ddia/components/redis">Redis</Link>: one process,
              one core, a hard ceiling. And above both sits a line no other system on this site
              has, the <em>watermark</em>, which is the memory level at which the node stops every
              publisher on every node of the cluster. Pick a shape and push the workload until a
              meter turns red.
            </p>
            <HardwareEnvelope />
            <p className="fl-src-note">
              Ceilings are order-of-magnitude figures for small messages. The 40% watermark
              default and the alarm behaviour are from the{' '}
              <a href="https://www.rabbitmq.com/docs/memory" target="_blank" rel="noreferrer">
                memory documentation
              </a>
              .
            </p>
          </Ch>

          <Ch id="scale-up" n={4} title="Scaling up — cores help, with a catch">
            <p>
              Unlike Redis, a bigger machine genuinely helps, provided the number of queues
              cooperates. More cores run more queue processes in parallel; a node with 16 cores
              and 200 queues uses all of them. More memory moves the watermark up, which buys
              tolerance for bursts and larger in-flight windows. Faster NVMe directly reduces
              confirm latency for durable and quorum traffic, since a majority fsync sits on the
              write path of every confirmed publish.
            </p>
            <p>
              The caveats are structural. A single hot queue gains nothing from any of this,
              because its ceiling is one process on one core whatever the machine. Memory spent
              tolerating deeper backlogs is spent enabling the anti-pattern: the system is
              designed for empty queues, and hardware that lets debt accumulate quietly only
              moves the cliff further out. And bigger nodes mean larger failures, with more queue
              leaders failing over at once and longer quorum re-synchronisation. The conclusion
              in <a href="#bigfleet">Chapter 7</a> is the same one the Kafka and Redis pages reached: modest nodes, more
              of them, with leaders spread across them.
            </p>
          </Ch>

          <Ch id="scale-out" n={5} title="Scaling out — two ceilings, one backlog">
            <p>
              Every RabbitMQ capacity question reduces to two independent ceilings. The
              queue&apos;s ceiling is one core per queue, and it is raised by sharding into more
              queues. The fleet&apos;s ceiling is the number of consumers multiplied by the
              per-message handler time, and it is raised by adding consumers or by making
              handlers faster. Whichever binds first, the symptom is the same, a growing{' '}
              <em>backlog</em>, and <a href="#anatomy">Chapter 2</a> showed where a backlog leads. The sandbox puts both
              ceilings under your control.
            </p>
            <Sandbox content={{ inputs: scaleOutInputs, compute: computeScaleOut }} />
            <div className="boundary">
              <h3>The scaling ladder — apply in order</h3>
              <ol className="ladder">
                <li><b>Keep queues empty.</b> Depth is debt. Give every queue a max-length and a TTL so that the debt is bounded by design.</li>
                <li><b>Tune prefetch and handlers.</b> Prefetch should be roughly the rate multiplied by the round-trip time, and a 5 ms handler is worth more than ten new consumers. This is the cheapest capacity there is.</li>
                <li><b>Add consumers,</b> up to the queue&apos;s own ceiling. This is the easy direction, for as long as it lasts.</li>
                <li><b>Shard into more queues,</b> with a consistent-hash exchange. This is the real unit of broker scaling, across cores and across nodes.</li>
                <li><b>Add nodes,</b> and spread the quorum leaders so that every node carries its share.</li>
                <li><b>Split the estate:</b> a vhost per team with limits, separate clusters per class of workload, and streams or Kafka for the firehoses.</li>
              </ol>
            </div>
          </Ch>

          <Ch id="ops" n={6} title="Operations: the pager view">
            <p>
              The defining RabbitMQ incident is not a crash; the broker is notably hard to kill.
              It is a <em>freeze</em>, in which the broker protects itself, exactly as documented,
              from a backlog that somebody else created. The cascade below is the one every
              RabbitMQ operator eventually meets. Play it, and then keep the runbook that follows.
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
              <b>The operating mindset.</b> Queue depth is the master signal, and everything else
              orbits it. Alert on the two leading indicators, the depth trend and consumer
              utilisation; put bulkheads in place so that no single queue can reach the
              watermark; and when the freeze comes anyway, remember that the broker is almost
              never the broken thing. Look at the consumers first.
            </div>
          </Ch>

          <Ch id="bigfleet" n={7} title="What a real messaging estate looks like">
            <p>
              Production RabbitMQ rarely looks like one large cluster. It looks like an{' '}
              <em>estate</em>: several bounded clusters of three or five nodes each, a vhost per
              team with limits, a dead-letter topology beside every work queue, asynchronous
              federation between data centres, and, in mature installations, an explicit boundary
              at which log-shaped traffic is handed to streams or to Kafka. The numbers that
              define the shape:
            </p>
            <div className="bigfacts">
              <div className="bigfact"><div className="bf-v">1M+/s</div><div className="bf-k">messages per second</div><div className="bf-s">the classic 30-node benchmark (2013)</div></div>
              <div className="bigfact"><div className="bf-v">3 · 5</div><div className="bf-k">quorum replicas</div><div className="bf-s">majority fsync per confirm</div></div>
              <div className="bigfact"><div className="bf-v">40%</div><div className="bf-k">of RAM</div><div className="bf-s">the watermark where publishers freeze</div></div>
              <div className="bigfact"><div className="bf-v">2–5×</div><div className="bf-k">throughput cost</div><div className="bf-s">transient → fully durable quorum</div></div>
            </div>
            <p>
              The trace below walks that estate from end to end: connections, quorum writes, the
              dead-letter parking lot, bulkheads, federation, and the handoff. Many of its steps
              are the lesson the Kafka and Redis pages taught in their own seventh chapters: many
              bounded clusters, loosely coupled, with the size of a failure decided in advance.
            </p>
            <TracePlayer spec={estateTrace} />
            <p className="fl-src-note">
              Figures: the{' '}
              <a href="https://tanzu.vmware.com/content/blog/rabbitmq-hits-one-million-messages-per-second-on-google-compute-engine" target="_blank" rel="noreferrer">
                1M msg/s Google Compute Engine benchmark
              </a>{' '}
              (2013) and the{' '}
              <a href="https://www.rabbitmq.com/docs/quorum-queues" target="_blank" rel="noreferrer">quorum queues documentation</a>.
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
                <div className="s-k">The model</div>
                <a href="https://www.rabbitmq.com/tutorials/amqp-concepts" target="_blank" rel="noreferrer">
                  RabbitMQ documentation — “AMQP 0-9-1 Model Explained”
                </a>
                <p>Exchanges, bindings, queues, acknowledgements, prefetch: <a href="#abstraction">Chapter 1</a> and the publish trace, stated precisely. One of the best conceptual documents any messaging system has produced.</p>
              </div>
              <div className="src">
                <div className="s-k">The paper</div>
                <a href="https://raft.github.io/raft.pdf" target="_blank" rel="noreferrer">
                  Ongaro &amp; Ousterhout — “In Search of an Understandable Consensus Algorithm” (Raft, 2014)
                </a>
                <p>Quorum queues are Raft groups, and this paper is their specification. Reading it now pays twice, since it is also the foundation of the planned etcd deep-dive and of Kafka&apos;s KRaft.</p>
              </div>
              <div className="src">
                <div className="s-k">The deep read</div>
                <a href="https://jack-vanlightly.com/blog/2018/6/29/quorum-queues-making-rabbitmq-more-competitive" target="_blank" rel="noreferrer">
                  Jack Vanlightly — the quorum queues &amp; RabbitMQ internals series
                </a>
                <p>The most rigorous public writing on RabbitMQ&apos;s replication, fsync behaviour and failure modes, by an engineer who later helped build it. Start anywhere, and read all of it.</p>
              </div>
              <div className="src">
                <div className="s-k">The comparison</div>
                <a href="https://jack-vanlightly.com/blog/2017/12/4/rabbitmq-vs-kafka-part-1-messaging-topologies" target="_blank" rel="noreferrer">
                  Jack Vanlightly — “RabbitMQ vs Kafka” series
                </a>
                <p>The definitive treatment of the smart-broker versus dumb-broker trade this page opened with, topology by topology and guarantee by guarantee, including the failure cases most comparisons leave out.</p>
              </div>
              <div className="src">
                <div className="s-k">The ops bible</div>
                <a href="https://www.rabbitmq.com/docs/alarms" target="_blank" rel="noreferrer">
                  RabbitMQ documentation — memory &amp; disk alarms
                </a>
                <p>The watermark, the blocking behaviour and paging: the <a href="#ops">Chapter 6</a> cascade in the vendor&apos;s own words. It is short, and every on-call engineer should have read it before the first freeze rather than after.</p>
              </div>
            </div>
          </Ch>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
