import type { TraceSpec } from '../../components/TracePlayer'
import { VIZ } from '../../styles/viz'

/* Colors: client blue, query machinery amber, buffer pool / heap green,
   WAL & replication violet, vacuum & danger red. */
const C = {
  client: VIZ.blue,
  machine: VIZ.amber,
  buf: VIZ.green,
  wal: VIZ.violet,
  vac: VIZ.red,
}

export const queryTrace: TraceSpec = {
  title: 'Trace one UPDATE — from SQL text to fsync',
  aspect: 0.5,
  zones: [
    { label: 'Client', x: 2, y: 4, w: 21, h: 42 },
    { label: 'Backend process & shared memory', x: 27, y: 4, w: 45, h: 42 },
    { label: 'Disk', x: 76, y: 4, w: 22, h: 42 },
  ],
  nodes: [
    { id: 'app', x: 4.5, y: 9, w: 16, h: 7, label: 'Your app', sub: 'BEGIN … COMMIT', color: C.client },
    { id: 'pool', x: 4.5, y: 33, w: 16, h: 8, label: 'PgBouncer', sub: 'transaction pooling', color: C.client },
    { id: 'parser', x: 29.5, y: 8, w: 17, h: 8, label: 'Parser + rewriter', sub: 'SQL → query tree', color: C.machine },
    { id: 'planner', x: 51, y: 8, w: 18, h: 8, label: 'Planner', sub: 'cost model × statistics', color: C.machine },
    { id: 'exec', x: 29.5, y: 21, w: 17, h: 8, label: 'Executor', sub: 'pull-based plan tree', color: C.machine },
    { id: 'shbuf', x: 51, y: 21, w: 18, h: 9, label: 'Shared buffers', sub: 'heap + index pages', color: C.buf },
    { id: 'walbuf', x: 37, y: 35, w: 18, h: 7.5, label: 'WAL buffers', sub: 'redo records', color: C.wal },
    { id: 'repl', x: 78, y: 8, w: 18, h: 8, label: 'walsender → replicas', sub: 'streaming WAL', color: C.wal },
    { id: 'heap', x: 78, y: 21, w: 18, h: 9, label: 'Heap & index files', sub: 'written lazily, later', color: C.buf },
    { id: 'waldisk', x: 78, y: 35, w: 18, h: 7.5, label: 'pg_wal', sub: 'fsync = the commit', color: C.wal },
  ],
  steps: [
    {
      title: 'One connection = one process',
      prose:
        'Postgres answers every connection with a whole OS process. The postmaster forks one, and it is yours until you disconnect. The design dates from 1986, when threads were not portable, and it stuck because a backend that crashes takes down only itself. The cost is real. A backend holds a few megabytes before it has done any work, plus <code>work_mem</code> for every sort and hash, plus a slot in the kernel scheduler. A thousand idle connections is a thousand processes. So nearly every production deployment puts <b>PgBouncer</b> in front, which lends a few dozen real backends to thousands of app connections, one transaction at a time.',
      focus: ['app', 'pool'],
      particles: [
        { from: 'app', to: 'pool', color: C.client },
        { from: 'pool', to: 'parser', color: C.client, via: [{ x: 25, y: 37 }, { x: 25, y: 12 }] },
      ],
    },
    {
      title: 'Parse and rewrite',
      prose:
        'The parser turns the SQL text into a tree. The analyzer then has to find out what <code>accounts</code> and <code>balance</code> are, and the answer lives in the <b>system catalogs</b>, which are themselves ordinary tables. The rewriter expands views and rules on the way through. None of this touches your data. It does touch the catalogs, so each backend keeps a cache of them, which is one more reason a fresh connection is slower than a pooled one that has been warm for an hour.',
      focus: ['parser'],
      particles: [{ from: 'parser', to: 'planner', color: C.machine }],
    },
    {
      title: 'Plan — the cost-based gamble',
      prose:
        'There are many ways to run one query: scan the whole table or walk an index, join in this order or that, hash or merge or nested loop. The planner cannot try them all, so it prices them. The prices come from statistics that <code>ANALYZE</code> gathered earlier: row counts, histograms of values, how well the physical order matches the key. It picks the cheapest <em>estimate</em>, and everything downstream trusts that guess. When the statistics go stale the planner is confidently wrong, and a query that took 2 ms all year takes 40 seconds one night. Chapter 8 calls that the <b>plan flip</b>.',
      focus: ['planner'],
      particles: [{ from: 'planner', to: 'exec', color: C.machine }],
    },
    {
      title: 'Execute — walk the index to the heap',
      prose:
        'The executor runs the plan as a tree of iterators, each node asking its children for the next row. For our UPDATE that means descending the B-tree index to a heap address, then asking the buffer manager for that 8 KB page. If the page is in <code>shared_buffers</code>, the lookup costs nanoseconds. If not, it comes from the OS page cache or from disk, and some other page is evicted to make room. Postgres leans on the OS cache on purpose, which is why <b>shared_buffers</b> is set near a quarter of RAM rather than all of it. Any higher and the same page is cached twice, and the OS knows better what else the machine needs the memory for.',
      focus: ['exec', 'shbuf'],
      particles: [{ from: 'exec', to: 'shbuf', color: C.buf }],
    },
    {
      title: 'MVCC: an UPDATE never updates',
      prose:
        'Now the choice that shapes the whole system. A reader may be looking at this row right now. Overwrite it in place and that reader sees half an old row and half a new one. Postgres could make the reader wait for a lock, as the first relational databases did. Or it could keep the old version somewhere. It keeps the old version <em>right where it is</em>: a second copy of the row is written beside it, stamped <code>xmin</code> = our transaction id, and the old copy is stamped <code>xmax</code> = our id, meaning “superseded by 205.” Both now sit on disk. A reader with an older snapshot keeps the old one and never takes a lock. The bill: every UPDATE is physically an insert plus a delete that <b>someone else must finish</b>. That someone is vacuum, and the next trace is about it.',
      focus: ['exec', 'shbuf'],
      particles: [{ from: 'exec', to: 'shbuf', color: C.vac, count: 2 }],
    },
    {
      title: 'WAL first — always',
      prose:
        'Before the dirtied page can go anywhere near the disk, the change is written as a <b>redo record</b> into the WAL buffers: “page X, offset Y, these bytes.” That order is the rule the name describes. Write the description first, the page later. The reason is in the disk itself: a page is 8 KB, a power cut can land mid-write, and a half-written page tells you nothing about what it used to hold. A log entry is small, appended, and either present or not. The log is the truth and the data files are a lagging copy of it. Kafka built a whole system on the same idea, aimed outward at messages instead of inward at pages.',
      focus: ['exec', 'walbuf'],
      particles: [{ from: 'exec', to: 'walbuf', color: C.wal }],
    },
    {
      title: 'COMMIT = one sequential fsync',
      prose:
        'At COMMIT the WAL buffers are flushed and fsync’d to <code>pg_wal</code>. This is the only disk write in the whole path that anything waits for. Commit latency is therefore WAL flush latency: around 50 µs on a local NVMe, a millisecond or two on a cloud network volume, ten on a spinning disk. Commits that arrive together share one flush, which the code calls <b>group commit</b>, so throughput grows even though every commit waits. The transaction is now durable. The heap page it changed still exists only in memory.',
      focus: ['walbuf', 'waldisk'],
      particles: [{ from: 'walbuf', to: 'waldisk', color: C.wal }],
    },
    {
      title: 'The WAL fans out',
      prose:
        'The bytes just fsync’d are streamed by walsender processes to every replica. A replica is not kept in sync by some separate protocol. It simply <em>runs the same log</em>, a little later, against its own copy of the files. By default that is asynchronous and the replica trails by milliseconds. Put a standby in <code>synchronous_standby_names</code> and COMMIT also waits for its acknowledgement, which buys zero data loss on failover at the price of one network round trip on every write.',
      focus: ['waldisk', 'repl'],
      particles: [{ from: 'waldisk', to: 'repl', color: C.wal, via: [{ x: 74.5, y: 38.75 }, { x: 74.5, y: 12 }] }],
    },
    {
      title: 'Ack — and the debt left behind',
      prose:
        'The client gets its COMMIT. The synchronous cost of the whole trip was one sequential fsync. The dirty heap and index pages stay in shared buffers until the <b>checkpointer</b> writes them out, spread over minutes on purpose so the disk never sees a burst. If the machine dies before then, recovery replays the WAL from the last checkpoint and rebuilds every page. One consequence worth knowing: the first change to each page after a checkpoint copies the entire 8 KB page into the WAL, so a torn page can be rebuilt from scratch. That is why WAL volume jumps right after every checkpoint.',
      focus: ['shbuf', 'heap', 'app'],
      particles: [
        { from: 'shbuf', to: 'heap', color: C.buf },
        { from: 'exec', to: 'app', color: C.client, via: [{ x: 25, y: 25 }, { x: 25, y: 12.5 }] },
      ],
    },
  ],
}

export const mvccTrace: TraceSpec = {
  title: 'The life of a row — MVCC, HOT, and vacuum',
  aspect: 0.5,
  zones: [
    { label: 'Transactions', x: 2, y: 4, w: 21, h: 42 },
    { label: 'One heap page (8 KB)', x: 27, y: 4, w: 45, h: 42 },
    { label: 'Around the table', x: 76, y: 4, w: 22, h: 42 },
  ],
  nodes: [
    { id: 'wtx', x: 4.5, y: 9, w: 16, h: 8.5, label: 'Writer (xid 205)', sub: 'UPDATE users SET …', color: C.client },
    { id: 'rtx', x: 4.5, y: 27, w: 16, h: 8.5, label: 'Reader', sub: 'snapshot @ xid 190', color: C.client },
    { id: 'v1', x: 29.5, y: 8, w: 17, h: 9, label: 'Version 1', sub: 'xmin 100 · xmax 205', color: C.wal },
    { id: 'v2', x: 51, y: 8, w: 18, h: 9, label: 'Version 2', sub: 'xmin 205 · xmax ∅', color: C.wal },
    { id: 'lp', x: 29.5, y: 21, w: 17, h: 7.5, label: 'Line pointers', sub: 'what indexes point at', color: C.machine },
    { id: 'free', x: 51, y: 21, w: 18, h: 7.5, label: 'Free space', sub: 'fillfactor headroom', color: C.buf },
    { id: 'idx', x: 78, y: 8, w: 18, h: 8, label: 'B-tree index', sub: 'key → (page, slot)', color: C.machine },
    { id: 'av', x: 78, y: 21, w: 18, h: 8, label: 'Autovacuum', sub: 'workers, cost-limited', color: C.vac },
    { id: 'vm', x: 78, y: 34, w: 18, h: 8, label: 'VM + FSM', sub: 'all-visible map · free space', color: C.buf },
  ],
  steps: [
    {
      title: 'A row is born',
      prose:
        'Transaction 100 inserts the row. A tuple lands on a heap page stamped <code>xmin&nbsp;100</code>, “created by 100.” Nothing on the page says who is allowed to see it. That question is answered later, at read time, by comparing the stamps against the reader’s snapshot and the commit log in <code>pg_xact</code>. Visibility is <b>computed on every read</b>, never stored.',
      focus: ['wtx', 'v1'],
      particles: [{ from: 'wtx', to: 'v1', color: C.client }],
    },
    {
      title: 'A reader takes a snapshot',
      prose:
        'A reader starts and is handed a <b>snapshot</b>: the set of transaction ids that had committed at that instant. From now on it sees the database as of that moment, whatever writers do, and it holds no lock to get that. Readers never block writers and writers never block readers. What pays for it is the old row versions, which have to stay on disk as long as any snapshot might still want them.',
      focus: ['rtx', 'v1'],
      particles: [{ from: 'rtx', to: 'v1', color: C.client, via: [{ x: 25, y: 31.25 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'UPDATE = insert a rival version',
      prose:
        'Transaction 205 updates the row. <b>Version 2</b> goes elsewhere on the page with <code>xmin 205</code>. Version 1 gets <code>xmax 205</code>. If an <em>indexed</em> column changed, every index on the table needs a new entry pointing at Version 2, because an index points at a physical location and the new version lives at a new one. One logical UPDATE became a heap insert plus N index inserts. Uber’s critique of Postgres, linked in Chapter 9, is mostly about this multiplication.',
      focus: ['wtx', 'v2', 'idx'],
      particles: [
        { from: 'wtx', to: 'v2', color: C.vac, via: [{ x: 12.5, y: 2 }, { x: 60, y: 2 }] },
        { from: 'v2', to: 'idx', color: C.machine },
      ],
    },
    {
      title: 'Two truths at once',
      prose:
        'Both versions are on the page. Our reader’s snapshot predates 205, so it resolves to <b>Version 1</b>. A transaction that starts now resolves to Version 2. Neither is wrong. They answer different questions: <em>as of when?</em> This is what lets a long <code>pg_dump</code> or an hour-long report run against a busy OLTP database without anyone waiting. The next step is the bill for it.',
      focus: ['v1', 'v2', 'rtx'],
      particles: [{ from: 'rtx', to: 'v1', color: C.client, via: [{ x: 25, y: 31.25 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'The dead pile up',
      prose:
        'Once no live snapshot can still see Version 1, it is <b>dead</b>. It still occupies page space and index entries, and nothing reclaims it inline, because deletes and updates only ever add. How far back the cleanup may reach is set by the oldest snapshot in the whole system, the <em>xmin horizon</em>. One session that ran <code>BEGIN</code> and then went idle pins dead versions in every table on the cluster. Hold onto that. It is the root of the cascade in Chapter 6.',
      focus: ['v1', 'rtx'],
    },
    {
      title: 'HOT — the mercy optimization',
      prose:
        'There is a mercy case. If no indexed column changed and the page has room, Postgres does a <b>Heap-Only Tuple</b> update: Version 2 goes on the <em>same page</em>, chained from Version 1, and no index is touched. The indexes still point at the original line pointer, and a reader follows the chain. That is why tables are created with <code>fillfactor</code> headroom, and why “don’t index a column you update constantly” is a design rule rather than folklore.',
      focus: ['lp', 'v1', 'v2'],
      particles: [
        { from: 'lp', to: 'v1', color: C.machine },
        { from: 'v1', to: 'v2', color: C.wal },
      ],
    },
    {
      title: 'Autovacuum sweeps',
      prose:
        'Autovacuum workers wake when a table’s dead-tuple count crosses a threshold. A worker scans the table, throttled so it does not flatten your I/O, removes dead versions and their index entries, records the freed room in the <b>free space map</b>, and marks pages with no dead tuples as all-visible in the visibility map, which is what makes index-only scans possible. Notice what it does not do. The file almost never shrinks. Space is recycled for the next insert, not handed back to the OS.',
      focus: ['av', 'v1', 'vm', 'free'],
      particles: [
        { from: 'av', to: 'v1', color: C.vac, via: [{ x: 74, y: 19 }, { x: 48.75, y: 19 }] },
        { from: 'av', to: 'vm', color: C.buf },
      ],
    },
    {
      title: 'The doomsday counter',
      prose:
        'Transaction ids are <b>32-bit</b> and compared in a circle. To transaction 3 billion, transaction 100 looks like the <em>future</em>, so an old row never touched again would one day vanish from every query. Vacuum prevents this by freezing old tuples, which marks them visible to everyone, forever. If freezing falls about 2 billion transactions behind, Postgres warns, and roughly 3 million short of the wrap it refuses new writes rather than lose your data. Every serious shop watches <code>age(datfrozenxid)</code>. Chapter 6 shows the alert.',
      focus: ['av'],
      particles: [{ from: 'av', to: 'v2', color: C.vac }],
    },
  ],
}

/* ---- Chapter 7: a production fleet, walked end to end ---- */
export const fleetTrace: TraceSpec = {
  title: 'A production Postgres fleet — follow the WAL',
  aspect: 0.5,
  zones: [
    { label: 'App tier', x: 2, y: 4, w: 21, h: 42 },
    { label: 'One cluster — the write path', x: 27, y: 4, w: 45, h: 42 },
    { label: 'Beyond one cluster', x: 76, y: 4, w: 22, h: 42 },
  ],
  nodes: [
    { id: 'fleet', x: 4.5, y: 8, w: 16, h: 8, label: 'App fleet', sub: 'hundreds of pods', color: C.client },
    { id: 'pgb', x: 4.5, y: 23, w: 16, h: 8, label: 'PgBouncer tier', sub: 'transaction pooling', color: C.client },
    { id: 'primary', x: 29.5, y: 8, w: 17, h: 9, label: 'Primary', sub: 'all writes', color: C.wal },
    { id: 'sync', x: 51, y: 8, w: 18, h: 9, label: 'Sync standby', sub: 'acks every commit', color: C.wal },
    { id: 'async', x: 29.5, y: 23, w: 17, h: 9, label: 'Async replicas', sub: 'reads · ms behind', color: C.wal },
    { id: 'arch', x: 51, y: 23, w: 18, h: 9, label: 'WAL archive (S3)', sub: 'pgBackRest / WAL-G', color: C.buf },
    { id: 'pitr', x: 51, y: 36, w: 18, h: 7, label: 'PITR restore', sub: 'replay to any second', color: C.buf },
    { id: 'router', x: 78, y: 8, w: 18, h: 8, label: 'Shard router', sub: 'hash(team_id)', color: C.machine },
    { id: 's1', x: 78, y: 21, w: 18, h: 7, label: 'Shard 1', sub: 'full primary + replicas', color: C.wal },
    { id: 's2', x: 78, y: 31.5, w: 18, h: 7, label: 'Shard N', sub: 'independent blast radius', color: C.wal },
  ],
  steps: [
    {
      title: 'Fan-in through the pooler',
      prose:
        'Hundreds of app instances × per-pod pools = thousands of client connections — pointed not at Postgres but at a <b>PgBouncer tier</b>, which multiplexes them onto a few dozen real backends per database. This is the first thing every production Postgres story has in common: nobody at scale connects apps straight to the primary.',
      focus: ['fleet', 'pgb'],
      particles: [{ from: 'fleet', to: 'pgb', color: C.client, count: 3 }],
    },
    {
      title: 'Every write funnels to one box',
      prose:
        'All writes from the entire fleet land on <b>one primary</b>. That sounds fragile, and it is the point: one machine assigning one WAL order is what makes transactions cheap. The whole fleet design exists to protect this box — pooling in front of it, replicas beside it, archives behind it.',
      focus: ['pgb', 'primary'],
      particles: [{ from: 'pgb', to: 'primary', color: C.wal, via: [{ x: 25, y: 27 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'The sync standby',
      prose:
        'A synchronous standby (typically in another availability zone) must ack the WAL before COMMIT returns. Cost: one network RTT on every write. Purchase: <b>failover loses zero committed transactions</b>. Most shops run exactly one sync standby plus async replicas — paying the RTT once, not N times.',
      focus: ['primary', 'sync'],
      particles: [{ from: 'primary', to: 'sync', color: C.wal }],
    },
    {
      title: 'Async replicas absorb the reads',
      prose:
        'Read-only traffic — dashboards, feeds, search indexing — routes to <b>async replicas</b> replaying the WAL milliseconds behind. The app must be lag-literate: a user who just wrote must read the primary (or a caught-up replica) or they’ll watch their own comment vanish. Replica count scales reads nearly linearly; it does nothing for writes.',
      focus: ['pgb', 'async'],
      particles: [{ from: 'pgb', to: 'async', color: C.client, count: 2 }],
    },
    {
      title: 'The WAL goes to object storage too',
      prose:
        'Every WAL segment is continuously shipped to <b>object storage</b> alongside periodic base backups (pgBackRest, WAL-G). Backups here aren’t nightly dumps — they are <em>the log itself</em>, which is what makes the next step possible. Archive lag is a paged metric: a backup you can’t restore from is a rumor.',
      focus: ['primary', 'arch'],
      particles: [{ from: 'primary', to: 'arch', color: C.buf }],
    },
    {
      title: 'Point-in-time recovery',
      prose:
        '“Restore to 14:03:59, right before the bad migration” — take the last base backup, replay archived WAL up to any chosen second. PITR is the difference between an incident and a catastrophe when the failure is <em>logical</em> (bad deploy, fat-fingered DELETE) and replicas have faithfully replicated the damage everywhere.',
      focus: ['arch', 'pitr'],
      particles: [{ from: 'arch', to: 'pitr', color: C.buf }],
    },
    {
      title: 'Failover — the drill you rehearse',
      prose:
        'Primary dies: orchestration (Patroni et al.) promotes the sync standby — guaranteed to have every committed byte — and repoints the PgBouncer tier. Writes pause for seconds. The dangerous parts are human: split-brain (two primaries taking writes) is why fencing and consensus-backed leader election exist. You drill this quarterly, or you discover it doesn’t work during the real one.',
      focus: ['sync', 'pgb'],
      particles: [{ from: 'pgb', to: 'sync', color: C.vac, via: [{ x: 25, y: 20 }, { x: 25, y: 2 }, { x: 60, y: 2 }] }],
    },
    {
      title: 'When the ladder ends: shard',
      prose:
        'When one primary’s write throughput is truly exhausted, the fleet multiplies: data is split by a <b>shard key</b> (Notion: <code>team_id</code> — everything for one workspace lives together) across many full clusters, each with its own primary, replicas, and failover. Cross-shard joins and transactions are gone; the app-level router is the new source of truth. It works — and it is the least reversible decision on this page.',
      focus: ['fleet', 'router', 's1', 's2'],
      particles: [
        { from: 'fleet', to: 'router', color: C.client, via: [{ x: 12.5, y: 2 }, { x: 87, y: 2 }] },
        { from: 'router', to: 's1', color: C.machine },
        { from: 'router', to: 's2', color: C.machine, via: [{ x: 74.5, y: 16 }, { x: 74.5, y: 35 }] },
      ],
    },
  ],
}
