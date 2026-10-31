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
        'When a client connects, the postmaster forks a new operating system process, called a <em>backend</em>, to serve that connection for as long as it lasts. There is no thread pool and no event loop. This design dates from 1986, when threads were not yet portable, and it has the advantage that a crash in one backend cannot corrupt another. However, each backend uses several megabytes of memory before it has executed anything, plus up to <code>work_mem</code> for every sort or hash operation, and the kernel has to schedule it. A thousand idle connections therefore mean a thousand processes. For this reason most production deployments place a connection pooler such as PgBouncer in front of the server, which multiplexes thousands of application connections onto a few dozen real backends, one transaction at a time.',
      focus: ['app', 'pool'],
      particles: [
        { from: 'app', to: 'pool', color: C.client },
        { from: 'pool', to: 'parser', color: C.client, via: [{ x: 25, y: 37 }, { x: 25, y: 12 }] },
      ],
    },
    {
      title: 'Parse and rewrite',
      prose:
        'The parser converts the SQL text into a tree. The analyzer then resolves every name in that tree, for example which table <code>accounts</code> refers to and what type <code>balance</code> has, by consulting the <em>system catalogs</em>. The catalogs are themselves ordinary tables, which is a pleasing bit of self-reference but also means that every query begins with a few catalog lookups. Each backend keeps a cache of catalog entries, so these lookups are cheap once the backend has been running for a while, and this is one reason why a freshly opened connection is slower than a pooled one. Finally, the rewriter expands any views and rules. Nothing so far has touched your data.',
      focus: ['parser'],
      particles: [{ from: 'parser', to: 'planner', color: C.machine }],
    },
    {
      title: 'Plan — the cost-based gamble',
      prose:
        'There are usually many ways of executing the same query: scanning the whole table or using an index, joining tables in one order or another, using a hash join or a merge join. The planner cannot try them all, so it estimates the cost of each candidate using statistics that a previous <code>ANALYZE</code> gathered: the number of rows, a histogram of the values in each column, and how well the physical order of the table correlates with the index. It then chooses the plan with the lowest estimated cost. Note that this is an <em>estimate</em>, and the rest of the system trusts it. If the statistics are out of date, the planner may confidently choose a plan far worse than the one it chose yesterday, which is how a query that has taken two milliseconds for a year comes to take forty seconds one night. Chapter 8 discusses this <em>plan flip</em> in more detail.',
      focus: ['planner'],
      particles: [{ from: 'planner', to: 'exec', color: C.machine }],
    },
    {
      title: 'Execute — walk the index to the heap',
      prose:
        'The executor runs the plan as a tree of operators, each of which asks its children for the next row. For our UPDATE, that means descending the B-tree index to find the location of the row in the table, and then asking the buffer manager for the 8 KB page at that location. If the page is already in <code>shared_buffers</code>, this takes nanoseconds. If not, the page is read from the operating system’s page cache or from disk, and some other page is evicted to make room for it. Postgres deliberately relies on the OS cache as a second layer, which is why <code>shared_buffers</code> is conventionally set to about a quarter of RAM rather than all of it: a larger setting would cache many pages twice, and the OS has a better view of what else the machine needs memory for.',
      focus: ['exec', 'shbuf'],
      particles: [{ from: 'exec', to: 'shbuf', color: C.buf }],
    },
    {
      title: 'MVCC: an UPDATE never updates',
      prose:
        'We now reach the decision that shapes much of the rest of the system. Some other transaction may be reading this row at this very moment. If we overwrote the row in place, that reader could observe a mixture of old and new bytes. One option would be to make readers wait by taking a lock, as the earliest relational databases did. Postgres instead keeps the old version where it is and inserts a second version of the row alongside it. The new version is stamped with <code>xmin</code> = 205, the ID of our transaction, and the old version is stamped with <code>xmax</code> = 205, meaning that it was superseded by transaction 205. Both versions are now on the page. A reader whose snapshot predates transaction 205 continues to see the old version, and it does not need to take any lock to do so. The cost is that an UPDATE is physically an insert plus a deferred delete, and the deletion must be completed later by a separate process, <em>vacuum</em>. The next trace is about that.',
      focus: ['exec', 'shbuf'],
      particles: [{ from: 'exec', to: 'shbuf', color: C.vac, count: 2 }],
    },
    {
      title: 'WAL first — always',
      prose:
        'Before the modified page can be written to disk, a description of the change is appended to the WAL buffers as a <em>redo record</em>, which says in effect: on page X, at offset Y, these bytes. The order matters. The log record must reach disk before the page does, which is where the name write-ahead log comes from. The reason is the torn-page problem from Chapter 1: a page is 8 KB and a power failure can interrupt its write, leaving no way to tell what it used to contain, whereas a log record is small, is appended rather than overwritten, and is either present or absent. The log is therefore the authoritative record, and the data files are a cache of it that may lag behind. Readers of the Kafka deep-dive will recognize the same idea applied to messages rather than pages.',
      focus: ['exec', 'walbuf'],
      particles: [{ from: 'exec', to: 'walbuf', color: C.wal }],
    },
    {
      title: 'COMMIT = one sequential fsync',
      prose:
        'When the transaction commits, the WAL buffers are flushed and fsync’d to the <code>pg_wal</code> directory. This is the only disk write in the whole path that anything waits for, so the latency of a commit is essentially the latency of a WAL flush: on the order of 50 µs on a local NVMe drive, a millisecond or two on a cloud network volume, and around ten milliseconds on a spinning disk. If several transactions commit at about the same time, their log records are flushed together, a technique known as <em>group commit</em>, so throughput can grow well beyond one commit per flush even though each commit waits for one. At this point the transaction is durable, even though the modified table page exists only in memory.',
      focus: ['walbuf', 'waldisk'],
      particles: [{ from: 'walbuf', to: 'waldisk', color: C.wal }],
    },
    {
      title: 'The WAL fans out',
      prose:
        'The same bytes that were just fsync’d are streamed by WAL sender processes to each replica. A replica is not kept consistent with the primary by some separate protocol; it simply replays the same log, slightly later, against its own copy of the files. By default this replication is asynchronous and a replica lags by a few milliseconds. If a standby is listed in <code>synchronous_standby_names</code>, COMMIT additionally waits for that standby to acknowledge the log record, which means that no committed transaction can be lost in a failover, at the cost of one network round trip per commit.',
      focus: ['waldisk', 'repl'],
      particles: [{ from: 'waldisk', to: 'repl', color: C.wal, via: [{ x: 74.5, y: 38.75 }, { x: 74.5, y: 12 }] }],
    },
    {
      title: 'Ack — and the debt left behind',
      prose:
        'The client receives its acknowledgement of COMMIT. The total synchronous cost of the whole path was one sequential fsync. The modified table and index pages remain in shared buffers until the <em>checkpointer</em> writes them out, which it deliberately spreads over several minutes so that the disk does not see a burst. If the server crashes before then, recovery replays the WAL from the last checkpoint and reconstructs the pages. One consequence is worth knowing: the first time each page is modified after a checkpoint, the entire 8 KB page is copied into the WAL, so that a torn page can be rebuilt from scratch rather than patched. This is why the volume of WAL written rises sharply just after every checkpoint.',
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
        'Transaction 100 inserts a row. A tuple is placed on a heap page, stamped with <code>xmin&nbsp;=&nbsp;100</code>, the ID of the transaction that created it. Nothing on the page records who is allowed to see this tuple. That question is answered at read time: each reader compares the tuple’s <code>xmin</code> and <code>xmax</code> with its own snapshot, and consults the commit log in <code>pg_xact</code> to find out whether those transactions committed. In other words, visibility is computed on every read rather than stored.',
      focus: ['wtx', 'v1'],
      particles: [{ from: 'wtx', to: 'v1', color: C.client }],
    },
    {
      title: 'A reader takes a snapshot',
      prose:
        'A reader starts a transaction and is given a <em>snapshot</em>, which records the set of transaction IDs that had committed at that instant. From then on it sees the database as it was at that moment, regardless of what writers do in the meantime, and it does not hold any lock in order to do so. This is the arrangement usually summarized as “readers never block writers and writers never block readers.” What pays for it is the old row versions: they must remain on disk for as long as any snapshot might still need them.',
      focus: ['rtx', 'v1'],
      particles: [{ from: 'rtx', to: 'v1', color: C.client, via: [{ x: 25, y: 31.25 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'UPDATE = insert a rival version',
      prose:
        'Transaction 205 updates the row. A second version is inserted elsewhere on the page with <code>xmin = 205</code>, and the first version is stamped with <code>xmax = 205</code>. If the update changed a column that is indexed, every index on the table also needs a new entry pointing at the new version, because an index entry refers to a physical location and the new version is at a different one. A single logical UPDATE has thus become one heap insert plus one insert per index. Uber’s well-known critique of Postgres, listed in Chapter 9, is largely about this multiplication.',
      focus: ['wtx', 'v2', 'idx'],
      particles: [
        { from: 'wtx', to: 'v2', color: C.vac, via: [{ x: 12.5, y: 2 }, { x: 60, y: 2 }] },
        { from: 'v2', to: 'idx', color: C.machine },
      ],
    },
    {
      title: 'Two truths at once',
      prose:
        'Both versions are now on the page. Our reader’s snapshot predates transaction 205, so it sees Version 1; a transaction that starts now sees Version 2. Neither is wrong: they are answering different questions, namely what the row looked like as of different points in time. This is what allows a long-running <code>pg_dump</code> or an hour-long report to proceed against a busy transactional database without blocking anyone. The next step shows what it costs.',
      focus: ['v1', 'v2', 'rtx'],
      particles: [{ from: 'rtx', to: 'v1', color: C.client, via: [{ x: 25, y: 31.25 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'The dead pile up',
      prose:
        'Once no live snapshot can still see Version 1, it is said to be <em>dead</em>. It still occupies space on the page and entries in the indexes, and nothing reclaims that space inline, because updates and deletes in Postgres only ever add. How far back the cleanup can reach is determined by the oldest snapshot anywhere in the system, known as the <em>xmin horizon</em>. A single session that executed <code>BEGIN</code> and then went idle therefore prevents dead versions from being removed in every table of the cluster. This is worth remembering, since it is the root cause of the cascade in Chapter 6.',
      focus: ['v1', 'rtx'],
    },
    {
      title: 'HOT — the mercy optimization',
      prose:
        'There is an important special case. If the update did not change any indexed column, and there is room on the same page, Postgres performs a <em>heap-only tuple</em> (HOT) update: Version 2 is placed on the same page, chained from Version 1, and no index is modified. The indexes continue to point at the original line pointer, and a reader follows the chain from there. This is why tables are often created with some <code>fillfactor</code> headroom, and why the advice not to index columns that are updated frequently is a genuine design rule rather than folklore.',
      focus: ['lp', 'v1', 'v2'],
      particles: [
        { from: 'lp', to: 'v1', color: C.machine },
        { from: 'v1', to: 'v2', color: C.wal },
      ],
    },
    {
      title: 'Autovacuum sweeps',
      prose:
        'Autovacuum workers wake up when the number of dead tuples in a table crosses a threshold. A worker scans the table, throttled so as not to saturate the disk, removes the dead versions and their index entries, records the reclaimed space in the <em>free space map</em>, and marks any page with no dead tuples as all-visible in the <em>visibility map</em>, which is what makes index-only scans possible. Note what vacuum does not do: it rarely makes the file smaller. Space is reused for future inserts rather than being returned to the operating system.',
      focus: ['av', 'v1', 'vm', 'free'],
      particles: [
        { from: 'av', to: 'v1', color: C.vac, via: [{ x: 74, y: 19 }, { x: 48.75, y: 19 }] },
        { from: 'av', to: 'vm', color: C.buf },
      ],
    },
    {
      title: 'The doomsday counter',
      prose:
        'Transaction IDs are 32-bit integers and are compared in a circle, modulo 2<sup>32</sup>. To transaction 3 billion, transaction 100 looks as though it lies in the future, so a very old row that was never touched again would eventually become invisible to every query. Vacuum prevents this by <em>freezing</em> old tuples, which marks them as visible to all transactions regardless of ID. If freezing falls roughly two billion transactions behind, Postgres first emits warnings and then, about three million transactions short of wraparound, refuses to accept new writes rather than risk losing data. Every serious installation monitors <code>age(datfrozenxid)</code>; Chapter 6 shows the corresponding alert.',
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
        'Hundreds of application instances, each with its own connection pool, add up to thousands of client connections. They are not pointed at Postgres directly but at a tier of PgBouncer processes, which multiplex them onto a few dozen real backends per database. This is the first thing that every production Postgres deployment has in common: at scale, nobody connects the application straight to the primary.',
      focus: ['fleet', 'pgb'],
      particles: [{ from: 'fleet', to: 'pgb', color: C.client, count: 3 }],
    },
    {
      title: 'Every write funnels to one box',
      prose:
        'Every write from the entire fleet lands on one primary. That sounds fragile, and in a sense it is, but it is also the point: having one machine assign one order to the WAL is what makes transactions cheap. The rest of the fleet exists to protect this machine, with pooling in front of it, replicas beside it, and archives behind it.',
      focus: ['pgb', 'primary'],
      particles: [{ from: 'pgb', to: 'primary', color: C.wal, via: [{ x: 25, y: 27 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'The sync standby',
      prose:
        'A <em>synchronous standby</em>, usually in another availability zone, must acknowledge each WAL record before COMMIT returns to the client. The cost is one network round trip on every write. What it buys is that a failover loses no committed transactions. Most installations run exactly one synchronous standby and make the remaining replicas asynchronous, so that the round trip is paid once rather than once per replica.',
      focus: ['primary', 'sync'],
      particles: [{ from: 'primary', to: 'sync', color: C.wal }],
    },
    {
      title: 'Async replicas absorb the reads',
      prose:
        'Read-only traffic, such as dashboards, feeds and search indexing, is routed to asynchronous replicas that replay the WAL a few milliseconds behind the primary. The application has to take replication lag into account: a user who has just written something must read from the primary, or from a replica known to have caught up, or they will see their own change disappear. Adding replicas scales reads almost linearly; it does nothing for writes.',
      focus: ['pgb', 'async'],
      particles: [{ from: 'pgb', to: 'async', color: C.client, count: 2 }],
    },
    {
      title: 'The WAL goes to object storage too',
      prose:
        'Every WAL segment is shipped continuously to object storage, alongside periodic base backups, using a tool such as pgBackRest or WAL-G. A backup in this arrangement is not a nightly dump; it is the log itself, which is what makes the next step possible. Archive lag is worth alerting on, since a backup that cannot be restored is not really a backup.',
      focus: ['primary', 'arch'],
      particles: [{ from: 'primary', to: 'arch', color: C.buf }],
    },
    {
      title: 'Point-in-time recovery',
      prose:
        'Restoring to 14:03:59, just before the bad migration, means taking the most recent base backup and replaying the archived WAL up to that second. This is <em>point-in-time recovery</em> (PITR), and it is what separates an incident from a catastrophe when the failure is logical, such as a bad deployment or a mistaken DELETE, because the replicas will have faithfully replicated the damage.',
      focus: ['arch', 'pitr'],
      particles: [{ from: 'arch', to: 'pitr', color: C.buf }],
    },
    {
      title: 'Failover — the drill you rehearse',
      prose:
        'When the primary fails, an orchestrator such as Patroni promotes the synchronous standby, which is guaranteed to hold every committed byte, and repoints the PgBouncer tier at it. Writes pause for a few seconds. The dangerous part is not the mechanism but its edge cases: two machines both believing they are the primary, known as <em>split-brain</em>, is the reason fencing and consensus-based leader election exist. Failover is rehearsed regularly, or it is discovered not to work during the real one.',
      focus: ['sync', 'pgb'],
      particles: [{ from: 'pgb', to: 'sync', color: C.vac, via: [{ x: 25, y: 20 }, { x: 25, y: 2 }, { x: 60, y: 2 }] }],
    },
    {
      title: 'When the ladder ends: shard',
      prose:
        'When one primary’s write throughput is genuinely exhausted, the fleet is multiplied. Data is split by a <em>shard key</em> (at Notion, <code>team_id</code>, so that everything belonging to one workspace is stored together) across many full clusters, each with its own primary, replicas and failover. Joins and transactions across shards are no longer available, and an application-level router becomes the authority on where each row lives. This works, but it is the least reversible decision on this page.',
      focus: ['fleet', 'router', 's1', 's2'],
      particles: [
        { from: 'fleet', to: 'router', color: C.client, via: [{ x: 12.5, y: 2 }, { x: 87, y: 2 }] },
        { from: 'router', to: 's1', color: C.machine },
        { from: 'router', to: 's2', color: C.machine, via: [{ x: 74.5, y: 16 }, { x: 74.5, y: 35 }] },
      ],
    },
  ],
}
