import { Link } from 'react-router-dom'
import SiteNav from '../../components/SiteNav'
import SiteFooter from '../../components/SiteFooter'
import IdeaStrip from '../../components/IdeaStrip'
import TracePlayer from '../../components/TracePlayer'
import MetricRunbook from '../../components/MetricRunbook'
import { Sandbox } from '../ModulePanel'
import HardwareEnvelope from './HardwareEnvelope'
import { queryTrace, mvccTrace, fleetTrace } from './traces'
import { computeScaleOut, scaleOutInputs } from './scaleout'
import { METRICS, cascadeTrace } from './ops'

const CHAPTERS = [
  { id: 'abstraction', n: 1, title: 'The core abstraction' },
  { id: 'anatomy', n: 2, title: 'Anatomy of the primary' },
  { id: 'hardware', n: 3, title: 'The hardware envelope' },
  { id: 'scale-up', n: 4, title: 'Scaling up' },
  { id: 'scale-out', n: 5, title: 'Scaling out' },
  { id: 'ops', n: 6, title: 'Operations: the pager view' },
  { id: 'bigfleet', n: 7, title: 'What a large fleet looks like' },
  { id: 'boundaries', n: 8, title: 'Boundaries & failures' },
  { id: 'sources', n: 9, title: 'Primary sources' },
]

const LIMITS: [string, string, string][] = [
  ['Writable primaries', '1', 'No native multi-master. Every write funnels through one box — the deepest wall in the stack. The ladder postpones it; only sharding escapes it.'],
  ['Connections', '1 OS process each', 'Default max_connections = 100; a few hundred active backends saturate a big box. PgBouncer is standard equipment, not an optimization.'],
  ['Commit latency', '1 WAL fsync (~0.1–1 ms)', 'The floor under every write. Synchronous replication adds a network RTT on top of it.'],
  ['UPDATE cost', 'new version + index entries', 'MVCC write amplification: an update is an insert plus deferred cleanup, and touches every index unless HOT applies.'],
  ['Transaction IDs', '32-bit, circular', 'Vacuum must freeze old tuples or the database refuses writes — wraparound is the hardest failure on this page.'],
  ['Physical replicas', 'byte-identical, read-only', 'Streaming replication copies the whole cluster, same major version, no partial subscriptions. Logical replication is the selective escape hatch.'],
  ['Working set', 'must ~fit in RAM', 'shared_buffers + OS cache. When the hot set spills, every miss is a random read — a cliff, not a slope.'],
]

const FAILS: [string, string][] = [
  ['Connection storm', 'A deploy restarts the whole app fleet; every pod reconnects at once and the primary drowns in fork() and auth before serving a single query. Pool at the infrastructure level and cap total connections.'],
  ['The forgotten transaction', 'One idle-in-transaction backend pins the xmin horizon: vacuum silently frees nothing, bloat compounds, p99 creeps for days. Set idle_in_transaction_session_timeout — this class of incident is fully preventable.'],
  ['Replication slot left behind', 'A decommissioned replica or dead CDC pipeline leaves a slot; the primary faithfully retains WAL for a reader that will never come until the disk fills and it PANICs. Set max_slot_wal_keep_size.'],
  ['XID wraparound shutdown', 'Autovacuum starved for months on one huge table; the age counter crosses the line and Postgres stops accepting writes mid-business-day, then needs hours of vacuum to reopen. Alert on age(datfrozenxid) — it gives weeks of warning.'],
  ['The 3am plan flip', 'Stats drift past a threshold and the planner flips a hot query from index scan to seq scan. The query that ran in 2 ms all year now takes 40 s and saturates I/O for everyone. ANALYZE is the one-command fix — if you think to look at the plan.'],
  ['Read-your-writes surprise', 'A user posts a comment, the next page load reads a lagging replica, the comment is gone. Session stickiness or LSN-tracking (“wait until replica reaches my write”) — it must be designed, not patched.'],
  ['Checkpoint storm', 'A bulk load fills max_wal_size early, forcing back-to-back checkpoints; full-page writes multiply WAL, which forces more checkpoints. Write latency sawtooths. Raise max_wal_size and spread the flush.'],
  ['The sharding cliff', 'Sharding is deferred until the primary is on fire, then executed under duress — schema changes frozen, joins broken in production. Notion picked its shard key years of growth ahead of the wall. That is the lesson.'],
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

export default function PostgresPage() {
  return (
    <div className="dd-page fl-page">
      <SiteNav />
      <main className="wrap fl-wrap">
        <aside className="fl-toc">
          <div className="fl-toc-title">PostgreSQL</div>
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
          <p className="h-kicker">Deep-dive · relational database</p>
          <h1 className="title">PostgreSQL</h1>
          <p className="lede">
            This page looks at PostgreSQL as an example of a database that runs on a single
            machine and makes two promises. The first is <em>durability</em>: once it has told
            you that a transaction is committed, that transaction will not be lost, even if the
            power fails a moment later. The second is <em>isolation</em>: while one transaction
            is modifying a row, other transactions reading that row should not see a partially
            applied change. Almost everything that is interesting about Postgres follows from
            the particular way it keeps those two promises, namely a write-ahead log and
            multi-version concurrency control. We will first follow a single UPDATE through one
            backend process, then look at the hardware that path consumes, and only then turn
            to replication and scaling.
          </p>

          <IdeaStrip
            ideas={[
              { slug: 'replication-leader', label: 'Leader & Followers' },
              { slug: 'replication-lag', label: 'Replication Lag' },
            ]}
          />

          <Ch id="abstraction" n={1} title="The core abstraction: the transaction">
            <p>
              Let&apos;s start with durability. A disk is written in blocks of a few kilobytes,
              and a power failure can occur at any moment, including halfway through writing a
              block. Suppose Postgres wrote your change directly into the page of the table that
              contains the row. If the power failed during that write, the page on disk would
              contain some bytes from before the change and some from after it, and on restart
              there would be no way of telling which were which. This is known as a{' '}
              <em>torn page</em>.
            </p>
            <p>
              The approach Postgres takes, like most databases designed since the 1980s, is to
              first append a compact description of the change to a sequential log file, and to
              wait for that append to reach the disk (an <code>fsync</code>) before reporting the
              transaction as committed. The table page itself is written to disk later, whenever
              convenient. If the system crashes in between, recovery reads the log and reapplies
              whatever the pages on disk are missing. This log is the <em>write-ahead log</em>{' '}
              (WAL), and the rule that gives it its name is simply that the log record must reach
              disk before the page does.
            </p>
            <p>
              The WAL turns out to be useful for more than crash recovery. A replica is just
              another machine that receives the same log and replays it against its own copy of
              the files, and a backup is just an archived copy of the log together with a
              snapshot of the files. We will see both in Chapter 5 and Chapter 7.
            </p>
            <p>
              Now consider isolation. Suppose transaction A is in the middle of updating a row
              when transaction B wants to read it. The simplest answer is to make B wait until A
              has finished, by having A hold a lock on the row. That is how System R and the
              early commercial databases worked. The trouble is that a long-running read, such as
              a report that scans a large table, then blocks every write to the rows it touches
              for as long as it runs.
            </p>
            <p>
              The alternative is to keep the old version of the row available while the new one
              is being written, so that B can read the old version without waiting. There are two
              places one can keep it. Oracle and MySQL&apos;s InnoDB overwrite the row in place
              and copy the previous version into a separate <em>undo</em> area, from which a
              reader that needs it can reconstruct what it should see. Postgres instead leaves
              the old version where it is and writes the new version alongside it, in the same
              table, with each version carrying the ID of the transaction that created it and the
              ID of the transaction that superseded it. Every reader then decides for itself, by
              comparing those IDs with its own snapshot, which version it is allowed to see. This
              technique is known as <em>multi-version concurrency control</em> (MVCC), and we
              will look at it closely in Chapter 2.
            </p>
            <p>
              Both choices have costs. With an undo area, a reader that needs an old version has
              to follow a chain of undo records, and the undo area itself must be managed. With
              Postgres&apos;s approach, reading the current version is cheap, but the table
              gradually fills with versions that no transaction can see any more, and a separate
              process, called <em>vacuum</em>, has to find and remove them. A great deal of what
              goes wrong in production Postgres installations turns out to be some variation of
              vacuum falling behind, which is why Chapter 6 spends so much time on it.
            </p>
            <p>
              One further design decision affects the operational chapters. Postgres handles each
              client connection in a separate operating system process rather than a thread. This
              dates from 1986, when threads were not portable across Unix variants, and the
              project kept it because a crash in one backend cannot corrupt the memory of
              another. The downside is that each connection costs several megabytes of memory and
              a scheduler entry even when idle, so a connection pooler such as PgBouncer is found
              in front of almost every production deployment.
            </p>
            <div className="note">
              <b>A familiar idea.</b> The WAL is the same idea as the append-only log at the heart
              of Kafka, applied to 8 KB pages rather than to messages. Chapter 7 of the Kafka
              deep-dive argues that such a log is the fundamental abstraction of distributed data
              systems; Postgres is a good example of the same idea on a single node.
            </div>
          </Ch>

          <Ch id="anatomy" n={2} title="Anatomy of the primary">
            <p>
              A running Postgres server consists of a number of operating system processes that
              share a region of memory. One process, called a <em>backend</em>, is dedicated to
              each client connection and executes that client&apos;s queries. The remaining
              processes perform maintenance work in the background: writing dirty pages to disk,
              streaming the log to replicas, and so on. The following trace follows a single{' '}
              <code>UPDATE</code> from the moment it arrives as text until the fsync that makes
              it durable.
            </p>
            <TracePlayer spec={queryTrace} />
            <p>
              The trace above shows what happens while the UPDATE is running. What is perhaps
              more surprising is what it leaves behind. Since Postgres does not overwrite rows in
              place, every UPDATE leaves a superseded version in the table, and a background
              process must later decide when that version can be removed. In our experience this
              lifecycle is the single most important thing to understand about operating
              Postgres, so the next trace follows one row through it.
            </p>
            <TracePlayer spec={mvccTrace} />
            <h3>The background cast</h3>
            <p>
              Each of the background processes exists because some piece of work was taken out
              of the path of client queries, so that clients would not have to wait for it. The{' '}
              <em>checkpointer</em> periodically writes all dirty pages to the data files, which
              bounds the amount of log that recovery has to replay after a crash. The{' '}
              <em>background writer</em> writes out pages ahead of demand, so that a backend
              seldom has to evict a page itself. The <em>WAL writer</em> flushes the WAL buffers
              between commits. <em>Autovacuum</em> workers remove dead row versions and freeze old
              ones. <em>WAL sender</em> processes stream the log to replicas. Finally, the{' '}
              <em>statistics collector</em> maintains the counts on which the query
              planner&apos;s estimates depend. Each of these can fall behind under load, and
              Chapter 6 describes what that looks like in each case.
            </p>
          </Ch>

          <Ch id="hardware" n={3} title="The hardware envelope">
            <p>
              Postgres&apos;s resource profile inverts Kafka&apos;s. Kafka moves bytes and barely
              computes; Postgres <b>computes on every row</b> — parsing, planning, index descent,
              visibility checks — so CPU matters. But the two numbers that actually define a
              primary&apos;s envelope are quieter: <b>does the working set fit in RAM</b>, and{' '}
              <b>how fast can one disk fsync the WAL</b>. RAM misses turn reads into random I/O
              (a cliff, not a slope), and WAL-flush latency is the floor under every commit.
              Pick a shape and push the workload until a meter goes red:
            </p>
            <HardwareEnvelope />
            <p className="fl-src-note">
              Rules of thumb: <code>shared_buffers</code> ≈ 25% of RAM with the OS cache doing the
              rest (PostgreSQL wiki,{' '}
              <a href="https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server" target="_blank" rel="noreferrer">
                Tuning Your PostgreSQL Server
              </a>
              ); per-query CPU costs are order-of-magnitude for tuned OLTP.
            </p>
          </Ch>

          <Ch id="scale-up" n={4} title="Scaling up — what a bigger box buys">
            <p>
              Vertical scaling maps cleanly onto the anatomy. <b>More RAM</b> is the headline
              purchase: it widens the working-set window, and its returns are step-shaped — going
              from &ldquo;hot set spills&rdquo; to &ldquo;hot set fits&rdquo; can be worth 10×,
              while RAM beyond the working set buys almost nothing. <b>Faster NVMe</b> lowers the
              WAL-fsync floor under every commit and absorbs the random reads of cache misses.{' '}
              <b>More cores</b> raise concurrent query throughput and feed parallel scans —
              though a single query&apos;s latency barely moves, and past ~32 cores contention on
              shared structures (lock manager, WAL insertion) eats into the gains.
            </p>
            <p>
              The diminishing returns are structural, and worth naming: every commit still
              serializes through <b>one WAL stream</b> on one disk; vacuum debt grows with write
              rate no matter the hardware; and one giant primary is one giant blast radius —
              failover, re-replication, and restores all scale with its size. Postgres rewards a{' '}
              <em>strong</em> primary, but past a point the money buys risk, not headroom. That
              point is where Chapter 5 begins.
            </p>
          </Ch>

          <Ch id="scale-out" n={5} title="Scaling out — the read/write asymmetry">
            <p>
              Horizontal Postgres is a story of one asymmetry: <b>reads scale out, writes do
              not</b>. Replicas replay the WAL and serve reads near-linearly — but every replica
              replays <em>every write</em>, so replicas add zero write capacity. Meanwhile the
              scaled-out app tier multiplies connections against a database that spends a process
              on each. The sandbox below is the whole game: push the sliders and watch which wall
              you hit first:
            </p>
            <Sandbox content={{ inputs: scaleOutInputs, compute: computeScaleOut }} />
            <div className="boundary">
              <h3>The scaling ladder — apply in order</h3>
              <ol className="ladder">
                <li><b>Pool connections</b> (PgBouncer, transaction mode) — collapse the app fleet&apos;s thousands onto a few dozen backends. Cheapest, do it first.</li>
                <li><b>Cache in front</b> (Redis, app-level) so repeat reads never reach the database at all — the highest-leverage move in the stack.</li>
                <li><b>Add read replicas</b> and route reads to them; make the app lag-literate (read-your-writes to the primary).</li>
                <li><b>Scale the primary up</b> — RAM to fit the working set, NVMe for the WAL floor. Simple, effective, bounded.</li>
                <li><b>Partition</b> big tables (by time or tenant) so indexes, scans, and vacuum each touch less; detach old ranges instead of DELETE-ing them.</li>
                <li><b>Shard</b> across independent clusters only when one primary&apos;s writes are truly exhausted — it costs cross-shard transactions and joins, forever.</li>
              </ol>
            </div>
          </Ch>

          <Ch id="ops" n={6} title="Operations: the pager view">
            <p>
              Everything above assumed things go right. In production, the defining Postgres
              incidents are <b>slow-motion</b> — debt that compounds for days before the first
              alert. The cascade below is the canonical one, and the reason experienced operators
              page on causes, not symptoms. Play it, then keep the runbook:
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
              <b>The operating mindset.</b> Postgres rarely fails suddenly; it fails on a{' '}
              <em>schedule you can read</em> — vacuum debt, XID age, WAL retention, working-set
              growth are all visible weeks ahead. Page on the leading indicators (oldest
              transaction, slot retention, freeze age), set the two timeouts that make whole
              incident classes impossible, and treat p99 as the question, never the answer.
            </div>
          </Ch>

          <Ch id="bigfleet" n={7} title="What a large Postgres fleet actually looks like">
            <p>
              The surprise at the top end is how far <b>one primary</b> goes. Notion ran the
              entire product on a single Postgres instance for five years; Instagram, Basecamp,
              and Stack Overflow&apos;s class of workload all lived on &ldquo;one strong box plus
              replicas&rdquo; far past the point folklore says is possible. When Notion finally
              sharded, the shape of the solution became the industry&apos;s reference:
            </p>
            <div className="bigfacts">
              <div className="bigfact"><div className="bf-v">5 yrs</div><div className="bf-k">on one instance</div><div className="bf-s">before sharding was forced</div></div>
              <div className="bigfact"><div className="bf-v">480</div><div className="bf-k">logical shards</div><div className="bf-s">schemas, keyed by team_id</div></div>
              <div className="bigfact"><div className="bf-v">32 → 96</div><div className="bf-k">physical hosts</div><div className="bf-s">2021 shard-out, tripled in 2023</div></div>
              <div className="bigfact"><div className="bf-v">15 → 5</div><div className="bf-k">schemas per host</div><div className="bf-s">re-sharding = moving schemas</div></div>
            </div>
            <p>
              The key design move: <b>far more logical shards than machines</b>. Splitting data
              into 480 schemas across 32 hosts meant &ldquo;scaling out&rdquo; later was{' '}
              <em>moving schemas between machines</em>, not re-splitting data — the painful
              decision was made once. Below, the topology those articles describe, walked end to
              end — and note how much of it is just the WAL from Chapter 2, pointed at different
              consumers:
            </p>
            <TracePlayer spec={fleetTrace} />
            <p className="fl-src-note">
              Figures:{' '}
              <a href="https://www.notion.so/blog/sharding-postgres-at-notion" target="_blank" rel="noreferrer">Notion — Herding elephants: sharding Postgres</a>{' '}and{' '}
              <a href="https://www.notion.so/blog/the-great-re-shard" target="_blank" rel="noreferrer">The Great Re-shard</a>.
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
                <a href="https://dsf.berkeley.edu/papers/ERL-M85-95.pdf" target="_blank" rel="noreferrer">
                  Stonebraker &amp; Rowe — “The Design of POSTGRES” (Berkeley, 1986)
                </a>
                <p>The original design document. The no-overwrite storage manager it proposes — old versions kept, a “vacuum cleaner” process to sweep them — is MVCC and vacuum, forty years early. Read §5 and recognize Chapter 2.</p>
              </div>
              <div className="src">
                <div className="s-k">The book</div>
                <a href="https://www.interdb.jp/pg/" target="_blank" rel="noreferrer">
                  Hironobu Suzuki — “The Internals of PostgreSQL”
                </a>
                <p>Free, current, and the best systems-internals text on any database. Chapters 5–9 (concurrency control, vacuum, buffer manager, WAL) are this page&apos;s Chapter 2 with the diagrams at full resolution.</p>
              </div>
              <div className="src">
                <div className="s-k">The docs</div>
                <a href="https://www.postgresql.org/docs/current/mvcc.html" target="_blank" rel="noreferrer">
                  PostgreSQL manual — Chapter 13, “Concurrency Control”
                </a>
                <p>Snapshot semantics, isolation levels, and locking, stated precisely by the people who wrote it. Pair with the “Routine Vacuuming” section — the most operationally important pages in the manual.</p>
              </div>
              <div className="src">
                <div className="s-k">The war story</div>
                <a href="https://www.notion.so/blog/sharding-postgres-at-notion" target="_blank" rel="noreferrer">
                  Notion — “Herding elephants: lessons learned from sharding Postgres”
                </a>
                <p>The modern reference for escaping the single-primary wall deliberately: choosing team_id, 480 logical shards, double-writes, and the audited cutover. The sequel, “The Great Re-shard,” shows why logical-over-physical pays off.</p>
              </div>
              <div className="src">
                <div className="s-k">The adversarial read</div>
                <a href="https://www.uber.com/blog/postgres-to-mysql-migration/" target="_blank" rel="noreferrer">
                  Uber — “Why Uber Engineering Switched from Postgres to MySQL” (2016)
                </a>
                <p>The sharpest public critique of the architecture you just learned: MVCC write amplification, per-version index entries, replication byte-coupling. Read it with the community rebuttals and you&apos;ll understand both systems better than either post alone.</p>
              </div>
            </div>
          </Ch>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
