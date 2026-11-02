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
  ['Writable primaries', '1', 'There is no native multi-master mode: every write passes through one machine. This is the deepest limit in the stack. The ladder in Chapter 5 postpones it; only sharding removes it.'],
  ['Connections', '1 OS process each', 'The default max_connections is 100, and a few hundred active backends saturate even a large machine. A pooler such as PgBouncer is standard equipment rather than an optimisation.'],
  ['Commit latency', '1 WAL fsync (~50 µs–1 ms)', 'The floor under every write, set by the disk: tens of microseconds on local NVMe, about a millisecond on a network volume. Synchronous replication adds a network round trip on top.'],
  ['UPDATE cost', 'new version + index entries', 'Because rows are not overwritten, an update is an insert plus a deferred delete, and it touches every index on the table unless the HOT optimisation applies.'],
  ['Transaction IDs', '32-bit, circular', 'Vacuum must freeze old tuples before the counter wraps, or the database refuses writes. Wraparound is the hardest failure on this page.'],
  ['Physical replicas', 'byte-identical, read-only', 'Streaming replication copies the entire cluster, requires the same major version, and cannot subscribe to a subset of it. Logical replication is the selective alternative.'],
  ['Working set', 'must roughly fit in RAM', 'Across shared_buffers and the OS cache together. When the hot data no longer fits, every miss becomes a random read, and throughput drops sharply rather than gradually.'],
]

const FAILS: [string, string][] = [
  ['Connection storm', 'A deploy restarts the whole application fleet, every instance reconnects at once, and the primary spends its time forking processes and authenticating them before it can serve a query. Pooling at the infrastructure level, with a cap on total connections, prevents this.'],
  ['The forgotten transaction', 'One backend left idle in a transaction pins the xmin horizon, so vacuum runs but frees nothing, bloat accumulates, and p99 latency rises over days. Setting idle_in_transaction_session_timeout removes this class of incident entirely.'],
  ['Replication slot left behind', 'A decommissioned replica or an abandoned change-data-capture pipeline leaves its replication slot in place. The primary dutifully retains WAL for a reader that will never return, until the disk fills and the server panics. max_slot_wal_keep_size bounds the damage.'],
  ['XID wraparound shutdown', 'Autovacuum is starved for months on one very large table, the transaction ID age crosses the limit, and Postgres stops accepting writes in the middle of the business day. Reopening requires hours of vacuuming. Alerting on age(datfrozenxid) gives weeks of warning.'],
  ['The 3am plan flip', 'Statistics drift past a threshold and the planner switches a hot query from an index scan to a sequential scan. A query that took 2 ms for a year now takes 40 s and saturates the disk for everyone else. ANALYZE fixes it in one command, provided someone thinks to look at the plan.'],
  ['Read-your-writes surprise', 'A user posts a comment, the next page load is served by a lagging replica, and the comment appears to have vanished. The remedy is session stickiness, or recording the LSN of the user\u2019s last write and waiting for the replica to reach it. It has to be designed in; it cannot be patched on afterwards.'],
  ['Checkpoint storm', 'A bulk load fills max_wal_size early, forcing checkpoints back to back. Each checkpoint re-enables full-page writes, which multiplies the WAL volume, which forces the next checkpoint sooner. Write latency takes on a sawtooth shape. Raising max_wal_size and spreading the flush breaks the loop.'],
  ['The sharding cliff', 'Sharding is deferred until the primary is already overloaded, and then carried out under pressure, with schema changes frozen and joins breaking in production. Notion chose its shard key years of growth before it was needed. That is the lesson.'],
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
              The resource profile of Postgres is in some ways the opposite of Kafka&apos;s.
              Kafka moves bytes and does very little computation on them; Postgres does work on
              every row it touches, parsing and planning the query, descending indexes and
              checking the visibility of each tuple, so CPU does matter. However, the two
              numbers that most often decide whether a primary is comfortable or in trouble are
              quieter ones: whether the <em>working set</em> fits in memory, and how quickly the
              disk can fsync the WAL. If the working set no longer fits, each miss becomes a
              random read, and throughput falls off sharply rather than degrading gradually. The
              WAL flush latency, as we saw in Chapter 2, is the floor under every commit. The
              envelope below lets you pick a machine shape and push the workload until one of
              its meters turns red.
            </p>
            <HardwareEnvelope />
            <p className="fl-src-note">
              Rules of thumb: <code>shared_buffers</code> at about 25% of RAM, with the operating
              system&apos;s page cache holding the rest (PostgreSQL wiki,{' '}
              <a href="https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server" target="_blank" rel="noreferrer">
                Tuning Your PostgreSQL Server
              </a>
              ). The per-query CPU costs are order-of-magnitude figures for a tuned OLTP workload.
            </p>
          </Ch>

          <Ch id="scale-up" n={4} title="Scaling up — what a bigger box buys">
            <p>
              Vertical scaling maps fairly directly onto the anatomy in Chapter 2. More memory is
              usually the most valuable purchase, because it widens the range of workloads whose
              working set fits. Its returns are step-shaped rather than linear: going from a
              working set that spills out of memory to one that fits can improve throughput by
              an order of magnitude, whereas memory beyond the working set buys very little. A
              faster NVMe drive lowers the WAL flush latency under every commit and absorbs the
              random reads caused by cache misses. More cores raise the number of queries that
              can run concurrently and allow parallel scans, although the latency of a single
              query barely changes, and beyond roughly 32 cores contention on shared structures
              such as the lock manager and WAL insertion begins to eat into the gains.
            </p>
            <p>
              The diminishing returns are structural, and it is worth being clear about why.
              Every commit still passes through a single WAL stream on a single disk, however
              fast that disk is. The vacuum work described in Chapter 2 grows with the write
              rate regardless of the hardware. And one very large primary is one very large unit
              of failure: failover, re-replication and restore all take time proportional to its
              size. Postgres rewards a strong primary, but past a certain point additional money
              buys risk rather than headroom. That point is where Chapter 5 begins.
            </p>
          </Ch>

          <Ch id="scale-out" n={5} title="Scaling out — the read/write asymmetry">
            <p>
              Scaling Postgres horizontally is largely a story about one asymmetry: reads can be
              spread across machines, but writes cannot. A replica replays the WAL and can serve
              read queries, so adding replicas increases read capacity almost linearly. However,
              every replica has to replay every write in order to stay current, so replicas add
              no write capacity at all; each write still has to be applied on the primary first.
              Meanwhile, an application tier that has itself been scaled out opens more and more
              connections to a database that dedicates a process to each one. The sandbox below
              lets you vary these quantities and see which limit you reach first.
            </p>
            <Sandbox content={{ inputs: scaleOutInputs, compute: computeScaleOut }} />
            <div className="boundary">
              <h3>The scaling ladder — apply in order</h3>
              <ol className="ladder">
                <li><b>Pool connections.</b> Put PgBouncer in transaction mode between the application and the database, so that thousands of application connections share a few dozen backends. This is the cheapest step, and it should be taken first.</li>
                <li><b>Cache in front.</b> Serve repeated reads from Redis or an application-level cache, so that they never reach the database. Of all the steps here, this one usually removes the most load for the least effort.</li>
                <li><b>Add read replicas</b> and route read queries to them. The application then has to take replication lag into account: a user who has just written must read from the primary.</li>
                <li><b>Scale the primary up:</b> enough memory for the working set, and NVMe storage for the WAL. This is simple and effective, but bounded, as Chapter 4 explained.</li>
                <li><b>Partition</b> large tables, by time or by tenant, so that each index, scan and vacuum pass touches less data. Old ranges can then be detached instead of deleted row by row.</li>
                <li><b>Shard</b> across independent clusters, but only once one primary&apos;s write capacity is genuinely exhausted. From then on, transactions and joins across shards are no longer available.</li>
              </ol>
            </div>
          </Ch>

          <Ch id="ops" n={6} title="Operations: the pager view">
            <p>
              Everything so far has assumed that things go right. In production, the Postgres
              incidents that matter are rarely sudden. They are usually the result of some debt
              that has been accumulating for days before the first alert, and by the time a
              symptom is visible the cause is several steps removed from it. The trace below
              follows the most common of these cascades, and it is the reason experienced
              operators alert on causes rather than on symptoms. Play it, and then keep the
              runbook that follows.
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
              <b>The operating mindset.</b> Postgres seldom fails without warning. Vacuum debt,
              transaction ID age, WAL retention and working-set growth are all visible weeks in
              advance to anyone who looks. The practical consequences are to alert on the
              leading indicators (the oldest open transaction, slot retention, freeze age)
              rather than on latency alone, to set the two timeouts that make whole classes of
              incident impossible, and to treat a p99 alert as a question about which of the
              others has moved, not as an answer.
            </div>
          </Ch>

          <Ch id="bigfleet" n={7} title="What a large Postgres fleet actually looks like">
            <p>
              The surprising thing at the top end is how far a single primary goes. Notion ran
              its entire product on one Postgres instance for five years. Instagram, Basecamp
              and Stack Overflow all ran workloads of a similar class on one large machine with
              replicas for much longer than folklore suggests is possible. When Notion did
              eventually shard, the shape of its solution became the reference that others
              copied:
            </p>
            <div className="bigfacts">
              <div className="bigfact"><div className="bf-v">5 yrs</div><div className="bf-k">on one instance</div><div className="bf-s">before sharding was forced</div></div>
              <div className="bigfact"><div className="bf-v">480</div><div className="bf-k">logical shards</div><div className="bf-s">schemas, keyed by team_id</div></div>
              <div className="bigfact"><div className="bf-v">32 → 96</div><div className="bf-k">physical hosts</div><div className="bf-s">2021 shard-out, tripled in 2023</div></div>
              <div className="bigfact"><div className="bf-v">15 → 5</div><div className="bf-k">schemas per host</div><div className="bf-s">re-sharding = moving schemas</div></div>
            </div>
            <p>
              The key decision was to create far more <em>logical</em> shards than physical
              machines. Splitting the data into 480 schemas spread over 32 hosts meant that
              scaling out later consisted of moving schemas between machines, rather than
              splitting the data again. The difficult decision, which rows belong together, was
              made once. The trace below walks the topology those two articles describe from end
              to end. Notice how much of it is simply the WAL from Chapter 2, delivered to
              different consumers.
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
                <p>The original design document. The no-overwrite storage manager it proposes, with old versions retained and a &ldquo;vacuum cleaner&rdquo; process to remove them, is the MVCC and vacuum of Chapter 2, described forty years earlier. Section 5 is the one to read.</p>
              </div>
              <div className="src">
                <div className="s-k">The book</div>
                <a href="https://www.interdb.jp/pg/" target="_blank" rel="noreferrer">
                  Hironobu Suzuki — “The Internals of PostgreSQL”
                </a>
                <p>Free, current, and probably the best internals text written about any database. Its chapters 5 to 9, on concurrency control, vacuum, the buffer manager and the WAL, cover the same ground as Chapter 2 of this page with the diagrams at full resolution.</p>
              </div>
              <div className="src">
                <div className="s-k">The docs</div>
                <a href="https://www.postgresql.org/docs/current/mvcc.html" target="_blank" rel="noreferrer">
                  PostgreSQL manual — Chapter 13, “Concurrency Control”
                </a>
                <p>Snapshot semantics, isolation levels and locking, stated precisely by the people who implemented them. Read it together with the &ldquo;Routine Vacuuming&rdquo; section, which is the most operationally important part of the manual.</p>
              </div>
              <div className="src">
                <div className="s-k">The war story</div>
                <a href="https://www.notion.so/blog/sharding-postgres-at-notion" target="_blank" rel="noreferrer">
                  Notion — “Herding elephants: lessons learned from sharding Postgres”
                </a>
                <p>The modern reference for leaving a single primary deliberately: the choice of team_id as the shard key, the 480 logical shards, double writes during the migration, and the audited cutover. The sequel, &ldquo;The Great Re-shard,&rdquo; shows why having more logical shards than machines paid off.</p>
              </div>
              <div className="src">
                <div className="s-k">The adversarial read</div>
                <a href="https://www.uber.com/blog/postgres-to-mysql-migration/" target="_blank" rel="noreferrer">
                  Uber — “Why Uber Engineering Switched from Postgres to MySQL” (2016)
                </a>
                <p>The sharpest public critique of the architecture described on this page: MVCC write amplification, an index entry per row version, and replication that ships physical bytes. Read it alongside the community responses, and you will understand both systems better than either article alone conveys.</p>
              </div>
            </div>
          </Ch>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
