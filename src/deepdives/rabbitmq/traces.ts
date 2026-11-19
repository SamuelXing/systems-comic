import type { TraceSpec } from '../../components/TracePlayer'
import { VIZ } from '../../styles/viz'

/* Colors: clients blue, routing machinery amber, queue-as-data violet,
   disk/store green, alarms & danger red, cross-DC links cyan. */
const C = {
  client: VIZ.blue,
  machine: VIZ.amber,
  queue: VIZ.violet,
  store: VIZ.green,
  danger: VIZ.red,
  edge: VIZ.cyan,
}

export const publishTrace: TraceSpec = {
  title: 'Trace a publish — exchange, bindings, queue, ack',
  aspect: 0.5,
  zones: [
    { label: 'Producer side', x: 2, y: 4, w: 21, h: 42 },
    { label: 'The broker', x: 27, y: 4, w: 45, h: 42 },
    { label: 'Consumer side', x: 76, y: 4, w: 22, h: 42 },
  ],
  nodes: [
    { id: 'prod', x: 4.5, y: 9, w: 16, h: 7, label: 'Producer', sub: 'basic.publish', color: C.client },
    { id: 'chan', x: 4.5, y: 21, w: 16, h: 8, label: 'Channel', sub: 'multiplexed on one TCP', color: C.client },
    { id: 'ex', x: 29.5, y: 8, w: 17, h: 8, label: 'Exchange', sub: 'topic: orders.#', color: C.machine },
    { id: 'bind', x: 51, y: 8, w: 18, h: 8, label: 'Bindings', sub: 'trie match → queues', color: C.machine },
    { id: 'qproc', x: 29.5, y: 21, w: 17, h: 8, label: 'Queue process', sub: 'one Erlang actor', color: C.queue },
    { id: 'store', x: 51, y: 21, w: 18, h: 8, label: 'Message store', sub: 'fsync if persistent', color: C.store },
    { id: 'credit', x: 29.5, y: 35, w: 17, h: 7.5, label: 'Credit flow', sub: 'backpressure per hop', color: C.danger },
    { id: 'unack', x: 51, y: 35, w: 18, h: 7.5, label: 'Unacked tracking', sub: 'per delivery tag', color: C.machine },
    { id: 'cons', x: 78, y: 9, w: 18, h: 8, label: 'Consumer', sub: 'prefetch = 30', color: C.client },
    { id: 'dlx', x: 78, y: 22, w: 18, h: 8, label: 'Dead-letter exchange', sub: 'rejected & expired', color: C.machine },
  ],
  steps: [
    {
      title: 'Publish on a channel',
      prose:
        'The producer publishes over a <em>channel</em>, a lightweight session multiplexed onto one long-lived TCP connection. Connections are expensive here, and channels are how you get concurrency without paying for more sockets. With publisher confirms enabled, the broker acknowledges the publish asynchronously once the message is safe. That acknowledgement is the producer’s only durability signal, so production code always turns it on.',
      focus: ['prod', 'chan'],
      particles: [{ from: 'prod', to: 'chan', color: C.client }],
    },
    {
      title: 'The exchange — routing as a first-class object',
      prose:
        'The message arrives at an <em>exchange</em> with a routing key such as <code>orders.eu.created</code>. The producer knows nothing about queues: not who consumes, not how many copies are made, not whether anyone is listening at all. That indirection is the heart of the smart-broker design. The topology lives in the broker, so producers and consumers can change independently.',
      focus: ['chan', 'ex'],
      particles: [{ from: 'chan', to: 'ex', color: C.client, via: [{ x: 25, y: 25 }, { x: 25, y: 12 }] }],
    },
    {
      title: 'Binding match',
      prose:
        'The exchange consults its <em>bindings</em>. For a topic exchange that is a trie of patterns (<code>orders.#</code>, <code>*.eu.*</code>) matched against the routing key; a fanout exchange copies to every bound queue; a direct exchange matches exactly; a headers exchange matches on metadata. This routing work is done per message, on the broker, which is a flexibility Kafka does not offer, at a per-message cost Kafka does not pay.',
      focus: ['ex', 'bind'],
      particles: [{ from: 'ex', to: 'bind', color: C.machine }],
    },
    {
      title: 'Into the queue process',
      prose:
        'Each matched queue is one Erlang process: an actor with a mailbox, processing messages strictly in order. FIFO ordering comes free from the actor model, and so does the ceiling that defines <a href="#hardware">Chapter 3</a>: one queue can never use more than one core. Sixteen consumers on one queue still share one sequential process.',
      focus: ['bind', 'qproc'],
      particles: [{ from: 'bind', to: 'qproc', color: C.queue }],
    },
    {
      title: 'Persistence, if you asked',
      prose:
        'A persistent message on a durable queue is written to the <em>message store</em>, with batched fsyncs, and only then is the publisher’s confirm released. For a <em>quorum queue</em> the bar is higher still: the message is an entry in a Raft log, confirmed after a majority of replicas have fsynced it. Durability here is per message and explicit, and each level of it costs throughput, which <a href="#hardware">Chapter 3</a> prices.',
      focus: ['qproc', 'store'],
      particles: [{ from: 'qproc', to: 'store', color: C.store }],
    },
    {
      title: 'Credit — backpressure by design',
      prose:
        'Every hop grants <em>credit</em> to the one before it: bindings to channels, queues to bindings. A queue that cannot keep up stops granting credit; the channel stops reading its socket; TCP pushes back on the producer. RabbitMQ slows publishers down rather than dropping messages or buffering without limit. This is the orderly version of what the second trace in <a href="#anatomy">Chapter 2</a> shows happening in a disorderly one.',
      focus: ['credit', 'qproc'],
      particles: [{ from: 'qproc', to: 'credit', color: C.danger }],
    },
    {
      title: 'Push to the consumer, bounded by prefetch',
      prose:
        'The broker pushes deliveries to consumers, whereas Kafka’s consumers pull; the inversions keep accumulating. <em>Prefetch</em> caps how many unacknowledged messages a consumer may hold at once. Set too low, the consumer starves waiting on round trips; set to unlimited, one consumer hoards the whole backlog while its peers sit idle. Per-consumer prefetch is the most important client-side setting.',
      focus: ['qproc', 'cons'],
      particles: [{ from: 'qproc', to: 'cons', color: C.queue, via: [{ x: 48.75, y: 18.5 }, { x: 74.5, y: 18.5 }, { x: 74.5, y: 13 }] }],
    },
    {
      title: 'Ack — and the message dies',
      prose:
        'The consumer processes the message and sends <code>basic.ack</code> with its delivery tag; the broker clears it from the unacknowledged set and deletes the message. This is the defining semantic of a queue: a message is a task, consumed once and then gone, rather than a log entry that outlives its readers. There is no replay, no second consumer group, no reprocessing of last Tuesday. Streams, in <a href="#bigfleet">Chapter 7</a>, are RabbitMQ’s answer when you want that back.',
      focus: ['cons', 'unack', 'qproc'],
      particles: [{ from: 'cons', to: 'unack', color: C.client }],
    },
    {
      title: 'Reject → dead letter',
      prose:
        'If the consumer sends a <code>nack</code> with <code>requeue=false</code>, or the message expires under a TTL, or it overflows <code>max-length</code>, it is routed to the <em>dead-letter exchange</em> instead of vanishing. This is the escape hatch for poison messages and the building block for retry-with-backoff topologies. Leave it unconfigured and a failing message is redelivered forever, burning a queue’s one core on a task that will never succeed (<a href="#boundaries">Chapter 8</a>).',
      focus: ['cons', 'dlx'],
      particles: [{ from: 'cons', to: 'dlx', color: C.machine }],
    },
  ],
}

export const beamTrace: TraceSpec = {
  title: 'The queue is a process — BEAM, backlog, and the alarm',
  aspect: 0.5,
  zones: [
    { label: 'Publishers', x: 2, y: 4, w: 21, h: 42 },
    { label: 'One broker node (BEAM VM)', x: 27, y: 4, w: 45, h: 42 },
    { label: 'The cliff edge', x: 76, y: 4, w: 22, h: 42 },
  ],
  nodes: [
    { id: 'pubs', x: 4.5, y: 9, w: 16, h: 8, label: 'Publisher fleet', sub: 'thousands of channels', color: C.client },
    { id: 'sched', x: 29.5, y: 8, w: 17, h: 8, label: 'BEAM schedulers', sub: 'one per core', color: C.machine },
    { id: 'q1', x: 51, y: 8, w: 18, h: 8, label: 'queue: orders', sub: 'one process, one core', color: C.queue },
    { id: 'q2', x: 51, y: 21, w: 18, h: 8, label: 'queue: emails', sub: 'another process, in parallel', color: C.queue },
    { id: 'ram', x: 29.5, y: 21, w: 17, h: 8, label: 'Process heaps', sub: 'backlog lives here', color: C.store },
    { id: 'page', x: 29.5, y: 35, w: 17, h: 7.5, label: 'Paging to disk', sub: 'message store v2', color: C.store },
    { id: 'alarm', x: 51, y: 35, w: 18, h: 7.5, label: 'Memory alarm', sub: 'vm_memory_high_watermark', color: C.danger },
    { id: 'blocked', x: 78, y: 9, w: 18, h: 8.5, label: 'Publishers blocked', sub: 'cluster-wide, all of them', color: C.danger },
    { id: 'drain', x: 78, y: 22, w: 18, h: 8, label: 'Consumers drain', sub: 'deliveries continue', color: C.client },
    { id: 'ok', x: 78, y: 35, w: 18, h: 7.5, label: 'Alarm clears', sub: 'below the watermark', color: C.store },
  ],
  steps: [
    {
      title: 'An actor per queue',
      prose:
        'RabbitMQ runs on the <em>BEAM</em>, Erlang’s virtual machine, which was built for telephone switches: millions of lightweight processes, preemptively scheduled, with one scheduler per core. Every queue, channel and connection is such a process. The gift of the design is isolation and FIFO ordering for free. The bill is that one queue is one process, and a process runs on one core at a time.',
      focus: ['pubs', 'sched', 'q1'],
      particles: [
        { from: 'pubs', to: 'sched', color: C.client, count: 2 },
        { from: 'sched', to: 'q1', color: C.queue },
      ],
    },
    {
      title: 'Queues in parallel',
      prose:
        'The saving grace that Redis lacks is that RabbitMQ parallelises across queues. A hundred queues spread over sixteen cores use all of them, so the broker scales with the number of queues, which is why <a href="#scale-out">Chapter 5</a>’s answer to nearly everything is “more queues.” No amount of hardware helps within one queue; that ceiling is architectural.',
      focus: ['q1', 'q2', 'sched'],
      particles: [{ from: 'sched', to: 'q2', color: C.queue }],
    },
    {
      title: 'A healthy queue is empty',
      prose:
        'RabbitMQ’s design assumption, the exact opposite of Kafka’s, is that messages flow through: published, delivered, acknowledged and deleted within milliseconds. Memory holds only what is in flight. A queue with a standing backlog is not a buffer doing its job; it is an incident with a slow fuse.',
      focus: ['q1', 'ram'],
    },
    {
      title: 'Backlog — the poison',
      prose:
        'Now the consumers slow down, because of a deploy, a dependency or a holiday. Publishes keep arriving, and every unconsumed message sits in a process heap, with per-message bookkeeping on top of the payload. Erlang’s garbage-collection cost grows with heap size, so the queue process gets slower as it gets fuller. The debt compounds quietly.',
      focus: ['pubs', 'ram'],
      particles: [{ from: 'pubs', to: 'ram', color: C.danger, via: [{ x: 25, y: 13 }, { x: 25, y: 25 }] }],
    },
    {
      title: 'Paging buys time, costs latency',
      prose:
        'The broker defends its memory by <em>paging</em> messages to disk. The v2 message store does this aggressively, and “lazy queues” made it the default posture from 3.12 onwards. It works, in that millions of messages can wait on disk, but the queue is now doing disk I/O inside its one sequential process. Throughput falls exactly when it is needed most.',
      focus: ['ram', 'page'],
      particles: [{ from: 'ram', to: 'page', color: C.store }],
    },
    {
      title: 'The alarm',
      prose:
        'Memory keeps climbing past <code>vm_memory_high_watermark</code>, which is 40% of RAM by default. The broker declares a <em>memory alarm</em>. This is not a log line; it is a cluster-wide change of state, and what happens next is the most famous behaviour in RabbitMQ operations.',
      focus: ['ram', 'alarm'],
      particles: [{ from: 'ram', to: 'alarm', color: C.danger }],
    },
    {
      title: 'Everyone stops',
      prose:
        'The alarm blocks every publishing connection on every node, not only those publishing to the bloated queue but all of them. One team’s slow consumer has frozen every producer in the company. Publishers do not receive errors; their <code>publish</code> calls simply hang, which is how the freeze propagates upstream into web request handlers. <a href="#ops">Chapter 6</a> plays the full cascade.',
      focus: ['alarm', 'blocked'],
      particles: [{ from: 'alarm', to: 'blocked', color: C.danger }],
    },
    {
      title: 'The only way out',
      prose:
        'Deliveries continue, because consumers are the exit. The backlog drains, memory falls below the watermark, the alarm clears, and publishers unfreeze. The lesson is structural: put the bulkheads in place before the alarm. A <code>max-length</code> and a TTL on every queue, whether they drop or dead-letter, so that depth is bounded, and per-vhost memory limits per tenant, so that one queue’s worst day stays one queue’s problem.',
      focus: ['blocked', 'drain', 'ok'],
      particles: [{ from: 'drain', to: 'ok', color: C.store }],
    },
  ],
}

/* ---- Chapter 7: a production messaging estate ---- */
export const estateTrace: TraceSpec = {
  title: 'A production messaging estate — quorum, bulkheads, and the handoff',
  aspect: 0.5,
  zones: [
    { label: 'Apps', x: 2, y: 4, w: 21, h: 42 },
    { label: 'Cluster of three', x: 27, y: 4, w: 45, h: 42 },
    { label: 'Wider estate', x: 76, y: 4, w: 22, h: 42 },
  ],
  nodes: [
    { id: 'apps', x: 4.5, y: 8, w: 16, h: 8, label: 'Producer fleet', sub: 'long-lived connections', color: C.client },
    { id: 'lb', x: 4.5, y: 23, w: 16, h: 8, label: 'Load balancer', sub: 'spreads connections', color: C.client },
    { id: 'n1', x: 29.5, y: 8, w: 17, h: 9, label: 'Node 1', sub: 'leader: orders', color: C.queue },
    { id: 'n2', x: 51, y: 8, w: 18, h: 9, label: 'Node 2', sub: 'leader: payments', color: C.queue },
    { id: 'n3', x: 29.5, y: 22, w: 17, h: 8, label: 'Node 3', sub: 'leader: emails', color: C.queue },
    { id: 'dlq', x: 51, y: 22, w: 18, h: 8, label: 'DLX + parking lot', sub: 'retries, poison, triage', color: C.machine },
    { id: 'vh', x: 40, y: 35.5, w: 18, h: 7, label: 'vhosts', sub: 'tenants, limits, bulkheads', color: C.machine },
    { id: 'fed', x: 78, y: 8, w: 18, h: 8.5, label: 'Federation link', sub: 'async, DC → DC', color: C.edge },
    { id: 'stream', x: 78, y: 22, w: 18, h: 8, label: 'Streams', sub: 'the log, inside Rabbit', color: C.store },
    { id: 'kafka', x: 78, y: 35, w: 18, h: 7.5, label: 'The handoff', sub: 'firehose? → Kafka', color: C.machine },
  ],
  steps: [
    {
      title: 'Connections are infrastructure',
      prose:
        'AMQP connections are stateful and expensive to open, with a handshake, authentication and channel setup, so production applications hold long-lived connections with channels multiplexed on top, spread across nodes by a TCP load balancer. Connection churn, that is, open, publish, close and repeat, is among the most common self-inflicted problems. <a href="#ops">Chapter 6</a> has the metric.',
      focus: ['apps', 'lb'],
      particles: [{ from: 'apps', to: 'lb', color: C.client, count: 2 }],
    },
    {
      title: 'Quorum queues — Raft, per queue',
      prose:
        'Every important queue is a <em>quorum queue</em>: a Raft group with, typically, three replicas. A publish appends to the leader’s log and is confirmed only after a majority of replicas have fsynced it. This is real durability, priced at a network round trip plus a disk write per message. Classic mirrored queues, the older high-availability design, are deprecated for good reason: their failure modes filled a decade of postmortems.',
      focus: ['lb', 'n1'],
      particles: [{ from: 'lb', to: 'n1', color: C.queue, via: [{ x: 25, y: 27 }, { x: 25, y: 12.5 }] }],
    },
    {
      title: 'Leaders spread across nodes',
      prose:
        'Each node leads some queues and follows others, which is the same leadership-balancing idea as Kafka’s partition leaders. A three-node cluster whose leaders are well spread uses the cores of all three nodes; a cluster in which one node leads everything is one node with two expensive spectators.',
      focus: ['n1', 'n2', 'n3'],
      particles: [
        { from: 'n1', to: 'n2', color: C.queue },
        { from: 'n1', to: 'n3', color: C.queue },
      ],
    },
    {
      title: 'The dead-letter estate',
      prose:
        'Every real deployment grows a <em>parking-lot topology</em>. Failures are dead-lettered into a retry queue with a TTL, which provides the delay; that queue dead-letters back to the work queue, which provides the retry; and a counter caps the number of attempts before a message lands in a parking lot for human triage. Retry with backoff, built entirely from TTL and dead-letter exchanges: the smart broker’s primitives composing.',
      focus: ['n2', 'dlq'],
      particles: [{ from: 'n2', to: 'dlq', color: C.machine }],
    },
    {
      title: 'vhosts — the blast-radius tool',
      prose:
        'Tenants get <em>virtual hosts</em>: separate namespaces with their own permissions, quotas and resource limits. After the second trace in <a href="#anatomy">Chapter 2</a> the reason this matters is clear: limits per vhost are how one team’s runaway backlog is stopped before it reaches the node-wide watermark that freezes everyone.',
      focus: ['vh'],
    },
    {
      title: 'Federation, not stretched clusters',
      prose:
        'Across data centres, an estate uses <em>federation</em> or shovels, which are asynchronous links that republish messages remotely, rather than stretching one cluster over the wide-area network, since a Raft majority spanning continents makes every confirm pay intercontinental latency. It is the same lesson for the third page running: many bounded clusters, loosely coupled.',
      focus: ['n2', 'fed'],
      particles: [{ from: 'n2', to: 'fed', color: C.edge }],
    },
    {
      title: 'Streams — the log moves in',
      prose:
        'RabbitMQ’s answer to “we need replay” is <em>streams</em>: append-only, with non-destructive reads, consumers that track their own offsets, and millions of messages per second. It is Kafka’s abstraction living inside RabbitMQ, and it suits fan-in pipelines and audit feeds without the cost of running a second system.',
      focus: ['stream', 'n2'],
      particles: [{ from: 'n2', to: 'stream', color: C.store }],
    },
    {
      title: 'The honest boundary',
      prose:
        'When the workload is a firehose, replayable, with many subscribers, at hundreds of megabytes per second, consumed by teams you have never met, it is a log workload, and the log system wins; that is the opening argument of the Kafka page. Mature estates run both: RabbitMQ for tasks, routing and RPC, Kafka for the event backbone. The mistake is not choosing one; it is using either as if it were the other.',
      focus: ['kafka', 'stream'],
      particles: [{ from: 'stream', to: 'kafka', color: C.machine }],
    },
  ],
}
