import { Link } from 'react-router-dom'
import SiteNav from '../../components/SiteNav'
import SiteFooter from '../../components/SiteFooter'
import IdeaStrip from '../../components/IdeaStrip'
import TracePlayer from '../../components/TracePlayer'
import MetricRunbook from '../../components/MetricRunbook'
import ClusterZoom from './ClusterZoom'
import { Sandbox } from '../ModulePanel'
import HardwareEnvelope from './HardwareEnvelope'
import { produceTrace, consumeTrace } from './traces'
import { computeScaleOut, scaleOutInputs } from './scaleout'
import { METRICS, cascadeTrace } from './ops'

const CHAPTERS = [
  { id: 'abstraction', n: 1, title: 'The core abstraction' },
  { id: 'anatomy', n: 2, title: 'Anatomy of a broker' },
  { id: 'hardware', n: 3, title: 'The hardware envelope' },
  { id: 'scale-up', n: 4, title: 'Scaling up' },
  { id: 'scale-out', n: 5, title: 'Scaling out' },
  { id: 'ops', n: 6, title: 'Operations: the pager view' },
  { id: 'bigcluster', n: 7, title: 'What a large cluster looks like' },
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
  ['Throughput / partition', '~10 MB/s (order of magnitude)', 'One partition is one leader append path on one broker. Load is spread by adding partitions, not by making one faster.'],
  ['Consumers / group', '≤ partition count', 'The hard cap on parallelism within a group. Consumers beyond it sit idle.'],
  ['Partitions / cluster', 'hundreds of thousands+ (KRaft)', 'The KRaft quorum lifted the ZooKeeper-era ceiling, but each partition still costs file handles, memory and rebalance time.'],
  ['Ordering', 'Per-partition only', 'Global ordering requires a single partition, which limits the topic to one consumer. Order by key instead.'],
  ['Rebalancing', 'Seconds of pause', 'When consumers join or leave, partition ownership is reshuffled. Cooperative and static membership reduce the pause but do not remove it.'],
  ['Replication', '×RF disk & network', 'acks=all waits for the in-sync replicas. A replication factor of 3 triples storage and more than doubles inter-broker traffic.'],
  ['fsync', 'Off by default', 'Durability comes from replication rather than from flushing. Losing power to every replica at once, in one data centre, is the accepted residual risk.'],
]

const FAILS: [string, string][] = [
  ['Under-partitioned topic', 'A topic was created with 6 partitions and now needs 60 consumers. Raising the partition count changes which partition each key maps to and breaks per-key ordering, so the migration is painful. Partitions are cheap to over-provision at creation and expensive to add later.'],
  ['Consumer lag blowup', 'When consumers are slower than producers, lag grows without bound until it exceeds the retention period, at which point unread data is deleted. Alert on lag rather than on CPU.'],
  ['Page-cache pollution', 'A consumer backfilling from history reads cold segments from disk into the page cache, evicting the recent tail, so consumers that were being served from memory now hit disk too. Backfills should be isolated, or served through follower fetching or tiered storage.'],
  ['Rebalance storms', 'Unreliable consumers repeatedly join and leave the group, and each change pauses the whole group while partitions are reassigned. Session timeouts need tuning, and static membership removes the churn.'],
  ['Hot partition from skewed keys', 'One very large key dominates a single partition while the others sit idle. Compound keys spread it, and a hot key can also be routed separately.'],
  ['ISR shrink under load', 'A slow follower drops out of the in-sync replica set. With acks=all and min.insync.replicas set to 2, one further failure stops writes entirely. The under-replicated partitions metric is the warning.'],
  ['Unclean leader election', 'Electing a replica that was not in sync, after a failure, loses data that was already acknowledged. It is off by default and should stay off unless availability genuinely matters more than durability.'],
  ['Poison-pill message', 'A single message that cannot be processed stops its partition\u2019s offset from advancing. The remedy is a dead-letter topic and skipping the message with a log entry.'],
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

export default function KafkaPage() {
  return (
    <div className="dd-page fl-page">
      <SiteNav />
      <main className="wrap fl-wrap">
        <aside className="fl-toc">
          <div className="fl-toc-title">Kafka</div>
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
          <p className="h-kicker">Deep-dive · distributed log</p>
          <h1 className="title">Apache Kafka</h1>
          <p className="lede">
            Kafka is the result of taking one idea, <em>a replicated append-only log stored as
            ordinary files</em>, and declining to add anything that would compromise it. The
            properties Kafka is known for (throughput, replay, consumer groups, exactly-once
            delivery) and the limitations it is equally known for (partition counts, rebalances,
            the scope of ordering) all follow from that one decision. This page walks the system
            in the order you would want it explained: what one broker does with a request, what
            hardware that path consumes, and only then how it scales.
          </p>

          <IdeaStrip
            ideas={[
              { slug: 'partitioning', label: 'Consistent Hashing' },
              { slug: 'partition-key', label: 'Choosing the Partition Key' },
              { slug: 'replication-leader', label: 'Leader & Followers' },
              { slug: 'replication-quorum', label: 'Leaderless & Quorums' },
              { slug: 'stream-table', label: 'Stream–Table Duality' },
              { slug: 'backpressure', label: 'Backpressure' },
            ]}
          />

          <Ch id="abstraction" n={1} title="The core abstraction: the log">
            <p>
              Consider the problem Kafka was built for. Many services produce a stream of events,
              and many other services want to read those events, at different speeds, starting at
              different points, and sometimes again from the beginning after a bug. A traditional
              message queue handles this by tracking, for every message and every consumer,
              whether that message has been delivered and acknowledged, and by deleting the
              message once everyone has it. That bookkeeping costs the broker work per message
              per consumer, and once a message has been deleted it cannot be read again. A
              database handles it by indexing the events, which costs a random write per insert
              and a random read per lookup.
            </p>
            <p>
              Kafka takes a third approach. A <em>topic</em> is a named log, split into{' '}
              <em>partitions</em>. A partition is an ordered, immutable sequence of records to
              which the only possible write is an append. A reader&apos;s entire state is an{' '}
              <em>offset</em>: a number recording how far into the partition it has read. Records
              are not deleted when they are consumed. They are retained for a period of time, up
              to a size, or until superseded by a later record with the same key (compaction),
              and then removed.
            </p>
            <p>
              The consequence is that the broker keeps no state about its consumers at all; each
              consumer keeps track of itself. This is what makes everything else cheap. A queue,
              publish/subscribe fan-out, replaying history, the state of a stream processor, and
              change data capture from a database are all simply different offsets held by
              different readers over the same bytes. On disk, a partition is a directory of{' '}
              <em>segment files</em>, the newest of which (the active segment) receives appends,
              together with sparse index files. Deleting old data therefore means unlinking a
              file rather than compacting a B-tree.
            </p>
            <div className="note">
              <b>Why an append-only log?</b> Sequential I/O runs at hundreds of megabytes per
              second on almost any storage device, including spinning disks, whereas random I/O
              is orders of magnitude slower. By restricting its storage engine to appends and
              sequential scans, Kafka uses the fastest path every device has, and it can rely on
              the operating system&apos;s page cache instead of managing a buffer pool of its own.
              Jay Kreps&apos;s essay <em>The Log</em>, listed in <a href="#sources">Chapter 9</a>, is the canonical
              statement of this idea.
            </div>
          </Ch>

          <Ch id="anatomy" n={2} title="Anatomy of a single broker">
            <p>
              A broker is a surprisingly thin layer over the operating system. Network threads
              move bytes between sockets and queues, I/O threads append to files, and the OS page
              cache does almost all of the caching and buffering. The following trace follows one
              produce request with <code>acks=all</code> through that machinery.
            </p>
            <TracePlayer spec={produceTrace} />
            <p>
              The read path goes further still: on the common path, the broker never copies your
              data into its own memory at all.
            </p>
            <TracePlayer spec={consumeTrace} />
            <h3>The background cast</h3>
            <p>
              Around these two paths run the maintenance loops. <em>Log cleaner</em> threads
              perform compaction by key. The <em>retention</em> task deletes whole segments once
              they have aged out. <em>Replica fetchers</em> keep this broker&apos;s follower
              partitions in sync with their leaders on other brokers. And the{' '}
              <em>controller</em>, which since Kafka 4.0 is a KRaft quorum (a Raft-replicated
              metadata log, replacing ZooKeeper), assigns partition leadership and propagates
              cluster metadata. Note the symmetry: the cluster&apos;s own metadata is stored as a
              replicated log. It is logs all the way down.
            </p>
          </Ch>

          <Ch id="hardware" n={3} title="The hardware envelope">
            <p>
              Kafka&apos;s resource profile is unusual among data systems: brokers move bytes
              rather than compute on them, so CPU is seldom the binding resource (compression and
              TLS are the exceptions). Confluent&apos;s production baseline is revealing: 24 cores
              and 64 GB of RAM, of which only about 6 GB is JVM heap, with the rest deliberately
              left to the OS page cache; twelve 1 TB disks in RAID 10 or as separate data
              directories on XFS or ext4, chosen for sequential throughput rather than IOPS; and
              ordinary 1 to 10 GbE networking. Dedicated KRaft controllers are small machines (4
              cores, 4 GB, a 64 GB SSD), since they replicate metadata rather than data.
            </p>
            <p>
              The reason the network is usually the first limit reached is the arithmetic of
              replication. One megabyte per second of producer traffic becomes RF megabytes per
              second of disk writes across the cluster, and <code>(RF−1) + consumers</code>{' '}
              megabytes per second of egress from the leader. The envelope below lets you choose
              a broker shape and push the workload until one of its meters turns red.
            </p>
            <HardwareEnvelope />
            <p className="fl-src-note">
              Baseline figures from Confluent&apos;s{' '}
              <a href="https://docs.confluent.io/platform/current/kafka/deployment.html" target="_blank" rel="noreferrer">
                production deployment guide
              </a>
              .
            </p>
          </Ch>

          <Ch id="scale-up" n={4} title="Scaling up — what a bigger box buys">
            <p>
              Vertical scaling maps fairly directly onto the anatomy. A faster network interface
              (10, 25 or 100 GbE) raises the usual binding resource linearly. More disks, whether
              striped or as separate data directories, add sequential throughput and retention
              capacity. More memory widens the page-cache window, that is, how many minutes of
              recent data stay in memory for consumers and replication to read without touching
              disk. More cores matter only when compression, TLS or a very high partition count
              has made CPU the constraint.
            </p>
            <p>
              The diminishing returns are structural here too. A single partition&apos;s writes
              still pass through one leader&apos;s append path regardless of the hardware, so
              per-partition throughput has a ceiling roughly on the scale of one core. And one
              very large broker is a large unit of failure: when it dies, re-replicating terabytes
              takes hours and loads the surviving brokers heavily. Kafka&apos;s sweet spot is many
              moderately large brokers rather than a few enormous ones.
            </p>
          </Ch>

          <Ch id="scale-out" n={5} title="Scaling out — partitions, brokers, and the quorum">
            <p>
              Horizontal scaling has three independent dimensions. <em>Partitions</em> spread a
              topic&apos;s load across brokers and set the maximum number of consumers that can
              process it in parallel. This is the number that has to be chosen in advance,
              because raising it later changes which partition each key hashes to, and so breaks
              ordering per key. <em>Brokers</em> add network interfaces, disks and page cache, and
              partitions and their leadership are rebalanced across them. <em>Consumer groups</em>{' '}
              scale processing up to the partition count, coordinated through the rebalance
              protocol. The sandbox below is the classic partition arithmetic, and by now the
              reason for each ceiling should be clear.
            </p>
            <Sandbox content={{ inputs: scaleOutInputs, compute: computeScaleOut }} />
            <div className="boundary">
              <h3>The scaling ladder — apply in order</h3>
              <ol className="ladder">
                <li><b>Choose the partition count at topic creation,</b> for peak parallelism plus headroom. This is the decision that cannot be cheaply undone.</li>
                <li><b>Scale consumers</b> up to the partition count; processing power grows linearly until then.</li>
                <li><b>Add brokers</b> to grow aggregate network, disk and page cache, and rebalance partitions onto them.</li>
                <li><b>Choose keys</b> so that ordering holds where it is needed and load spreads where it is not.</li>
                <li><b>Watch consumer lag rather than CPU.</b> Lag is the signal that a limit has been reached.</li>
              </ol>
            </div>
          </Ch>

          <Ch id="ops" n={6} title="Operations: the pager view">
            <p>
              Everything so far has assumed that things go right. In production, one lives by a
              handful of metrics, and the skill is reading a spike backwards to its cause, because
              the number that pages you is usually several steps removed from what actually
              broke. The trace below follows the most common cascade; the runbook follows it.
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
              <b>The operating mindset.</b> The useful question is not whether a system will
              scale but how you will know when it breaks, and what you will do then. Alert on the
              leading indicators (disk utilisation, handler idle time, changes in the in-sync
              replica set) rather than only on the trailing symptom, p99 latency. And do not
              react to a single metric in isolation; the cascade is what is actually happening.
            </div>
          </Ch>

          <Ch id="bigcluster" n={7} title="What a large cluster actually looks like">
            <p>
              At the top end, Kafka runs at a scale that is hard to picture. LinkedIn, where Kafka
              was written, publishes its figures, and they change what a Kafka deployment even
              means:
            </p>
            <div className="bigfacts">
              <div className="bigfact"><div className="bf-v">7T</div><div className="bf-k">messages / day</div><div className="bf-s">across the whole ecosystem</div></div>
              <div className="bigfact"><div className="bf-v">100+</div><div className="bf-k">clusters</div><div className="bf-s">not one giant cluster</div></div>
              <div className="bigfact"><div className="bf-v">4,000+</div><div className="bf-k">brokers</div><div className="bf-s">~40 per cluster on average</div></div>
              <div className="bigfact"><div className="bf-v">100k+</div><div className="bf-k">topics</div><div className="bf-s">multi-tenant</div></div>
              <div className="bigfact"><div className="bf-v">7M</div><div className="bf-k">partitions</div><div className="bf-s">~1,750 per broker</div></div>
            </div>
            <p>
              The most important thing in that table is that nobody runs one enormous cluster.
              More than a hundred clusters of about forty brokers each is a deliberate hierarchy
              of failure domains. The view below zooms from regions down into a single broker. At
              the rack-awareness step, fail a zone to see why the layout has the shape it does.
            </p>
            <ClusterZoom />
            <h3>The techniques that do not show up in the picture</h3>
            <ul className="clean">
              <li><b>Tiered storage (KIP-405).</b> Cold log segments are moved to object storage such as S3 or GCS, so that brokers keep only the recent tail on local disk, and the disk-capacity limit from <a href="#hardware">Chapter 3</a> stops being the constraint.</li>
              <li><b>Target about 80% of sustained maximum.</b> The headroom is what absorbs a broker loss, or a recovering replica writing at full speed, without pushing a surviving broker past its own limit.</li>
              <li><b>KRaft in place of ZooKeeper.</b> The metadata quorum from <a href="#anatomy">Chapter 2</a> replaced ZooKeeper precisely to lift the per-cluster partition ceiling, which used to force even more fragmentation than the table shows.</li>
            </ul>
            <p className="fl-src-note">
              Figures:{' '}
              <a href="https://blog.bytebytego.com/p/how-linkedin-customizes-its-7-trillion" target="_blank" rel="noreferrer">LinkedIn&apos;s 7-trillion-message ecosystem</a>{' '}and{' '}
              <a href="https://aws.amazon.com/blogs/big-data/best-practices-for-right-sizing-your-apache-kafka-clusters-to-optimize-performance-and-cost/" target="_blank" rel="noreferrer">AWS right-sizing guidance</a>.
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
                <a href="https://notes.stephenholiday.com/Kafka.pdf" target="_blank" rel="noreferrer">
                  Kreps, Narkhede &amp; Rao — “Kafka: a Distributed Messaging System for Log Processing” (NetDB ’11)
                </a>
                <p>The original LinkedIn paper. Short and readable; section 3 describes the storage and efficiency design (sequential I/O, the page cache, sendfile) that the traces above animate.</p>
              </div>
              <div className="src">
                <div className="s-k">The essay</div>
                <a href="https://www.oreilly.com/library/view/i-heart-logs/9781491909379/" target="_blank" rel="noreferrer">
                  Jay Kreps — “I Heart Logs” (O’Reilly, 2014)
                </a>
                <p>The philosophical companion: why the log is the unifying abstraction behind replication, messaging and stream processing. This is the book form of the 2013 essay, which LinkedIn has since taken down. It is arguably the best systems essay of its decade, and now readable only as a book.</p>
              </div>
              <div className="src">
                <div className="s-k">The design docs</div>
                <a href="https://kafka.apache.org/documentation/#design" target="_blank" rel="noreferrer">
                  Apache Kafka documentation — §4 “Design”
                </a>
                <p>Unusually good official documentation: persistence, efficiency, the ISR model and its comparison with quorum replication. Section 4.7 is the part most worth reading.</p>
              </div>
              <div className="src">
                <div className="s-k">The metadata revolution</div>
                <a href="https://cwiki.apache.org/confluence/display/KAFKA/KIP-500%3A+Replace+ZooKeeper+with+a+Self-Managed+Metadata+Quorum" target="_blank" rel="noreferrer">
                  KIP-500 — Replace ZooKeeper with a self-managed metadata quorum (KRaft)
                </a>
                <p>Why external coordination had to go, and how a Raft-replicated metadata log lifted the partition-count ceiling. Worth reading alongside the Raft paper once the consensus deep-dive exists.</p>
              </div>
              <div className="src">
                <div className="s-k">The clever bit</div>
                <a href="https://www.confluent.io/blog/apache-kafka-purgatory-hierarchical-timing-wheels/" target="_blank" rel="noreferrer">
                  “Apache Kafka, Purgatory, and Hierarchical Timing Wheels” (Confluent)
                </a>
                <p>How hundreds of thousands of parked requests (acks=all produces, long-poll fetches) are managed in constant time. This is the data structure behind step 6 of the produce trace and step 2 of the fetch trace.</p>
              </div>
            </div>
          </Ch>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
