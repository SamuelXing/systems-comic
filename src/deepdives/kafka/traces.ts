import type { TraceSpec } from '../../components/TracePlayer'
import { VIZ } from '../../styles/viz'

/* Colors: client blue, broker machinery amber, page cache green,
   replication violet, purgatory red. */
const C = {
  client: VIZ.blue,
  broker: VIZ.amber,
  cache: VIZ.green,
  repl: VIZ.violet,
  purg: VIZ.red,
}

export const produceTrace: TraceSpec = {
  title: 'Trace a produce request (acks=all)',
  aspect: 0.5,
  zones: [
    { label: 'Producer (client)', x: 2, y: 4, w: 21, h: 42 },
    { label: 'Broker — partition leader', x: 27, y: 4, w: 45, h: 42 },
    { label: 'Followers', x: 76, y: 4, w: 22, h: 27 },
  ],
  nodes: [
    { id: 'app', x: 4.5, y: 9, w: 16, h: 7, label: 'Your app', sub: 'send(key, value)', color: C.client },
    { id: 'accum', x: 3.5, y: 21, w: 18, h: 9, label: 'RecordAccumulator', sub: 'batch per partition', color: C.client },
    { id: 'sender', x: 4.5, y: 36, w: 16, h: 7, label: 'Sender thread', sub: 'one TCP per broker', color: C.client },
    { id: 'net', x: 29.5, y: 8, w: 17, h: 8, label: 'Network threads', sub: 'default 3', color: C.broker },
    { id: 'reqq', x: 51, y: 8, w: 18, h: 8, label: 'Request queue', sub: 'shared', color: C.broker },
    { id: 'io', x: 29.5, y: 21, w: 17, h: 8, label: 'I/O threads', sub: 'default 8', color: C.broker },
    { id: 'cache', x: 51, y: 20.5, w: 18, h: 9, label: 'OS page cache', sub: 'active segment append', color: C.cache },
    { id: 'index', x: 29.5, y: 33, w: 17, h: 7.5, label: 'Offset + time index', sub: 'mmap, sparse', color: C.broker },
    { id: 'purg', x: 50, y: 33, w: 21, h: 7.5, label: 'Purgatory', sub: 'hierarchical timing wheel', color: C.purg },
    { id: 'hw', x: 75.5, y: 33, w: 22, h: 7.5, label: 'High watermark', sub: 'min ISR log-end-offset', color: C.repl },
    { id: 'f1', x: 78.5, y: 8, w: 18, h: 8, label: 'Follower B2', sub: 'replica fetcher', color: C.repl },
    { id: 'f2', x: 78.5, y: 20, w: 18, h: 8, label: 'Follower B3', sub: 'replica fetcher', color: C.repl },
  ],
  steps: [
    {
      title: 'Partition & batch on the client',
      prose:
        'The serializer turns your record into bytes, and the partitioner chooses a partition: <code>hash(key) % partitions</code> for a keyed record, which is what makes ordering per key possible, or sticky batching for records with no key. Records then accumulate into per-partition batches, governed by <code>batch.size</code> and <code>linger.ms</code>, and compression (lz4 or zstd) is applied to each batch rather than to each record. Batching is where a Kafka client earns most of its throughput.',
      focus: ['app', 'accum'],
      particles: [{ from: 'app', to: 'accum', color: C.client, count: 3 }],
    },
    {
      title: 'Sender drains to the leader',
      prose:
        'A single background <em>sender thread</em> drains the batches that are ready and multiplexes them over one TCP connection per broker, routing each batch to the leader of its partition. With the idempotent producer, which is the default, every batch carries a producer ID and a sequence number, so the broker can discard duplicates and retries become safe.',
      focus: ['accum', 'sender', 'net'],
      particles: [
        { from: 'accum', to: 'sender', color: C.client },
        // route up the clear channel between the producer & broker zones
        { from: 'sender', to: 'net', color: C.client, via: [{ x: 24, y: 39.5 }, { x: 24, y: 12 }] },
      ],
    },
    {
      title: 'Network thread → request queue',
      prose:
        'The broker’s <em>network threads</em> (three by default) do no real work. They read bytes off sockets and place complete requests on a shared request queue. Keeping them thin is deliberate: socket I/O should never block behind disk work.',
      focus: ['net', 'reqq'],
      particles: [{ from: 'net', to: 'reqq', color: C.broker }],
    },
    {
      title: 'Append to the log — the heart of Kafka',
      prose:
        'An <em>I/O thread</em> (eight by default) validates the batch, checking the leader epoch and the producer sequence, and appends it to the partition’s active segment. This is an ordinary sequential write to a file, and it lands in the OS page cache. By default there is no fsync on this path: durability comes from replication, and the operating system flushes dirty pages when it chooses to. Sequential I/O into the page cache, instead of application-managed buffers, is the design decision from which the rest of the system follows.',
      focus: ['reqq', 'io', 'cache'],
      particles: [
        { from: 'reqq', to: 'io', color: C.broker },
        { from: 'io', to: 'cache', color: C.cache },
      ],
    },
    {
      title: 'Sparse indexes, memory-mapped',
      prose:
        'Every 4 KB or so of log (<code>log.index.interval.bytes</code>) gets one entry in the offset index and one in the time index. These are memory-mapped files, and they let a fetch at offset N binary-search to a file position without scanning the log. A sparse index is enough because a read then proceeds sequentially from that position.',
      focus: ['io', 'index'],
      particles: [{ from: 'io', to: 'index', color: C.broker }],
    },
    {
      title: 'Parked in purgatory',
      prose:
        'With <code>acks=all</code>, the response cannot be sent until the in-sync replicas have the batch. Rather than block a thread, the request is parked in <em>purgatory</em>, a hierarchical timing-wheel structure that holds hundreds of thousands of pending requests with constant-time insertion and expiry.',
      focus: ['purg'],
      particles: [{ from: 'io', to: 'purg', color: C.purg }],
    },
    {
      title: 'Followers fetch — replication is consumption',
      prose:
        'Followers are not sent the data; they fetch it, using the same fetch protocol as any consumer, and append it to their own logs and hence their own page caches. There is one replication mechanism and one code path. Because the fetch reads from the leader’s page cache, replication of the tail rarely touches disk.',
      focus: ['f1', 'f2', 'cache'],
      particles: [
        { from: 'cache', to: 'f1', color: C.repl },
        { from: 'cache', to: 'f2', color: C.repl },
      ],
    },
    {
      title: 'High watermark advances',
      prose:
        'The leader tracks every replica’s log-end offset. The <em>high watermark</em> is the minimum of those across the in-sync replicas: everything below it is committed, and will survive the loss of any single broker. When the high watermark passes our batch, purgatory completes the produce request. Consumers are only ever allowed to read up to the high watermark.',
      focus: ['hw', 'purg', 'f1', 'f2'],
      particles: [
        // f1's report routes down the channel left of the followers, not through f2
        { from: 'f1', to: 'hw', color: C.repl, via: [{ x: 74, y: 12 }, { x: 74, y: 36.75 }] },
        { from: 'f2', to: 'hw', color: C.repl },
      ],
    },
    {
      title: 'Ack the producer',
      prose:
        'The response leaves through the same network thread, and the producer’s callback fires. The total cost of a durable, replicated write was two network hops, one sequential append into the page cache, and RF − 1 fetches, and at no point did anything wait for a random disk seek. That is why one broker sustains hundreds of megabytes per second.',
      focus: ['net', 'app'],
      particles: [
        // response routes down under the grid and up the inter-zone channel,
        // instead of cutting straight across the page cache
        { from: 'purg', to: 'net', color: C.broker, via: [{ x: 60.5, y: 46 }, { x: 24, y: 46 }, { x: 24, y: 12 }] },
        { from: 'net', to: 'app', color: C.client },
      ],
    },
  ],
}

export const consumeTrace: TraceSpec = {
  title: 'Trace a fetch (consume) request',
  aspect: 0.5,
  zones: [
    { label: 'Consumer (client)', x: 2, y: 4, w: 21, h: 38 },
    { label: 'Broker — partition leader', x: 27, y: 4, w: 47, h: 42 },
    { label: 'Kafka itself', x: 76, y: 16, w: 22, h: 18 },
  ],
  nodes: [
    { id: 'cons', x: 4.5, y: 9, w: 16, h: 8, label: 'Consumer', sub: 'poll() loop', color: C.client },
    { id: 'commit', x: 4.5, y: 28, w: 16, h: 8, label: 'Offset commit', sub: 'group coordinator', color: C.client },
    { id: 'net', x: 29.5, y: 8, w: 18, h: 8, label: 'Network thread', color: C.broker },
    { id: 'fpurg', x: 52.5, y: 8, w: 19, h: 8, label: 'Fetch purgatory', sub: 'long poll', color: C.purg },
    { id: 'hw', x: 29.5, y: 21, w: 18, h: 7, label: 'HW check', sub: 'committed data only', color: C.repl },
    { id: 'cache', x: 52.5, y: 20, w: 19, h: 9, label: 'OS page cache', sub: 'segment data', color: C.cache },
    { id: 'sfile', x: 40, y: 34, w: 21, h: 8, label: 'sendfile()', sub: 'zero-copy → NIC', color: C.cache },
    { id: 'offlog', x: 77, y: 20, w: 20, h: 10, label: '__consumer_offsets', sub: 'compacted topic', color: C.repl },
  ],
  steps: [
    {
      title: 'Fetch request',
      prose:
        'The consumer asks for data from offset N. The position is the consumer’s own state; the broker tracks nothing per consumer on the read path. <code>fetch.min.bytes</code> and <code>fetch.max.wait.ms</code> tell the broker not to answer until it has at least that much data, or that much time has passed.',
      focus: ['cons', 'net'],
      particles: [{ from: 'cons', to: 'net', color: C.client }],
    },
    {
      title: 'Long-poll in fetch purgatory',
      prose:
        'If not enough data exists yet, the fetch is parked in purgatory rather than polled repeatedly. This single mechanism gives Kafka both low latency and batched efficiency: data arriving completes the waiting fetches immediately, and a quiet partition costs nothing while it waits.',
      focus: ['fpurg'],
      particles: [{ from: 'net', to: 'fpurg', color: C.purg }],
    },
    {
      title: 'Bounded by the high watermark',
      prose:
        'The read is capped at the high watermark, so only records that have been replicated to the in-sync replicas are visible. A consumer can therefore never observe data that a leader failover could later roll back.',
      focus: ['hw'],
      particles: [{ from: 'fpurg', to: 'hw', color: C.repl }],
    },
    {
      title: 'Read from the page cache',
      prose:
        'A consumer reading the tail, which is by far the most common case, is reading data written seconds ago, and that data is still in the page cache, so no disk I/O occurs at all. The troublesome case is a lagging consumer that reads cold segments from disk, evicting the hot pages and slowing everyone else. This is <em>cache pollution</em>, and it is a noisy-neighbour problem.',
      focus: ['cache'],
      particles: [{ from: 'hw', to: 'cache', color: C.cache }],
    },
    {
      title: 'Zero-copy to the NIC',
      prose:
        'The broker calls <code>sendfile(2)</code>, and the kernel moves pages from the cache directly to the network card. The data never enters the broker’s user space: no copies, no heap allocation, and no garbage-collection pressure, regardless of message size. TLS is the caveat, since encryption forces one pass through user space. It is still cheap, but it is why plaintext benchmarks look better than production ever will.',
      focus: ['sfile', 'cons'],
      particles: [
        { from: 'cache', to: 'sfile', color: C.cache },
        // zero-copy delivery routes under the grid, not across the HW-check node
        { from: 'sfile', to: 'cons', color: C.cache, via: [{ x: 50.5, y: 44 }, { x: 24, y: 44 }, { x: 24, y: 13 }] },
      ],
    },
    {
      title: 'Commit offsets — to Kafka itself',
      prose:
        'The consumer records its position by producing a record to <code>__consumer_offsets</code>, a compacted internal topic keyed by group, topic and partition. Kafka stores its own coordination state in its own log; the log really is the database.',
      focus: ['commit', 'offlog'],
      // route under the grid to __consumer_offsets, not across the page cache
      particles: [{ from: 'commit', to: 'offlog', color: C.repl, via: [{ x: 12.5, y: 46 }, { x: 87, y: 46 }] }],
    },
  ],
}
