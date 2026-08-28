import type { Comic } from '../types'
import { RetryDupDiagram, AtomicPairDiagram } from '../diagrams'

export const exactlyOnce: Comic = {
  slug: 'exactly-once',
  chapter: 'Extension · Delivery Guarantees',
  chapterNo: 'Ext 2',
  title: 'Exactly-Once, Mechanically',
  dek: 'Three chapters of this book say “effectively once” and move on. This one opens the hood: the retry that cannot know whether it is a duplicate, the sequence number that catches it anyway, and the transaction that makes “processed” and “recorded as processed” a single fact.',
  minutes: 7,
  caption:
    'A consumer reads an order and charges a card. If the machinery delivers the order twice, somebody is charged twice; if it drops the order, somebody’s purchase silently never happens. Everybody wants the third thing — **exactly once** — and the network declines to offer it. *The 2011 Kafka paper settled the question in one blunt paragraph — exactly-once would need two-phase commit, deduplicating in the consumer is cheaper — and DDIA’s Chapter 11 concurs in a sentence. This chapter is an extension: it is that paragraph, taken apart until you can see why both halves are true.*',
  steps: [
    {
      n: 'Step 01',
      title: 'The retry that cannot know',
      accent: 'terra',
      rung: 'Rung 1 · Intuition',
      body: [
        'Start with one producer, one broker, one message, and take the network seriously. The producer sends; no acknowledgement comes back. There are two possible worlds: **the message was lost** on the way in, or **the message arrived and the ack was lost** on the way out. From where the producer stands, these worlds are *indistinguishable* — and they demand opposite responses.',
        'Retry, and in the second world you have written the message twice. Refuse to retry, and in the first world you have lost it. There is no third move, because acknowledging the acknowledgement just moves the same ambiguity one hop over — this is the Two Generals problem from Chapter 8, showing up for an ordinary day of work.',
        'So every sender in every messaging system picks a side: **at-most-once** (never retry; loss is possible) or **at-least-once** (retry; duplicates are possible). *Exactly-once delivery was never on the menu.* Everything the phrase “exactly-once” legitimately means is built on top of at-least-once, by machinery that recognizes the duplicates it knowingly creates.',
      ],
      code: {
        file: 'two indistinguishable worlds',
        lines: [
          { t: 'send(m) ... no ack arrives. either:' },
          { t: '' },
          { t: 'world A: m lost      → must retry, or lose it', hl: 'bad' },
          { t: 'world B: ack lost    → retry writes m twice', hl: 'bad' },
          { t: '' },
          { t: '# the sender cannot tell A from B. ever.' },
        ],
      },
    },
    {
      n: 'Step 02',
      title: 'Deduplication is a job for the ends',
      accent: 'terra',
      rung: 'Rung 1 · Intuition',
      body: [
        'The tempting fix is to make the middle smarter — let the broker, the driver, the protocol dedup for you. And they do: TCP discards duplicate packets on every connection you open. Yet payments still double-fire across systems built entirely on TCP, because **the duplicate was never born at the packet layer**. It was born when an application timed out, gave up on a request whose fate it could not see, and sent the *same logical operation* again — through a fresh connection with fresh sequence numbers, past every dedup the middle had to offer.',
        'This is the [[end-to-end argument|Saltzer, Reed & Clark, 1984: a function like reliable delivery or deduplication, implemented inside the network, is necessarily incomplete — only the endpoints know what a repeat of the operation means, so the ends must implement it, and the middle can at best optimize.]], and it is the load-bearing idea of this whole chapter. A layer can only deduplicate the retries *it* issued. Retries issued above it look like new operations. So “once” can only be enforced by something that understands the operation’s **identity** — an id minted where the operation is born, checked where its effect lands.',
        'Watch for the shape in the wild: Stripe asks you to send an `Idempotency-Key` header; databases let an upsert on a primary key land twice harmlessly; and the two mechanisms in the rest of this chapter are exactly this — an identity, checked at the effect.',
      ],
      think: {
        q: 'TCP already retransmits and deduplicates. Why does that not make an HTTP POST safe to retry?',
        a: 'Because TCP’s guarantee dies with the connection. Its sequence numbers name **byte positions inside one conversation**, not operations — when your client times out and POSTs again, that is a *new* TCP connection whose bytes are all “new,” duplicating flawlessly at the layer below while duplicating the charge at the layer above. The retry that hurts you is almost never the one the transport made; it is the one your retry loop, your load balancer’s replay, or your impatient user made — and none of those pass through any dedup table unless the application put one there, keyed by something that survives reconnection. The middle cannot save you, not because it is badly built, but because it genuinely does not know what “the same operation” means. Only the ends know that.',
      },
    },
    {
      n: 'Step 03',
      title: 'The sequence number',
      accent: 'denim',
      rung: 'Rung 2 · Mechanism',
      diagram: <RetryDupDiagram />,
      body: [
        'Now the machinery, smallest piece first. Kafka’s idempotent producer attaches an identity to every batch: a **producer id** assigned at startup, and a per-partition [[sequence number|A counter the producer stamps on each batch per partition. The broker remembers the last few per producer id and drops any arrival at or below it — turning “retry might duplicate” into “retry is safe.”]] that increments with every send. The broker remembers the last sequence it has written for each producer-partition pair. A retry arrives carrying the same number, the broker recognizes it, drops the data, and re-sends the acknowledgement the producer never got.',
        'Look at what this buys: the ambiguity from Step 01 is now *harmless*. The producer still cannot tell world A from world B — it retries blindly, exactly as before — but the broker can tell, because the retry announces its identity. `acks=all`, infinite retries, and ordering all become safe to combine, which is why this has been the default since Kafka 3.0.',
        'And look at what it does not buy. The sequence number lives inside **one producer session** talking to **one partition**. Restart the application and a new producer id starts fresh sequences; send the same *logical* event from your own retry loop and it arrives as a legitimately new record with a new number. *This is Step 02’s boundary drawn precisely: the broker deduplicates the transport retries it can see, and nothing above them.*',
      ],
      deeper: {
        summary: 'Where you have seen this before — and the small print on the window',
        body: [
          'This is TCP’s sequence number, reinvented one layer up and scoped per partition — the same move the Backpressure chapter found with flow control, where TCP’s window came back as prefetch, permits and `request(n)`. The transport tricks get rediscovered at every layer that starts doing deliveries.',
          'The small print: the broker keeps the last **five** batches’ sequence state per producer-partition, which is why `max.in.flight.requests.per.connection` must stay ≤ 5 for the dedup-and-ordering guarantee to hold. And the producer id itself only survives restarts when tied to a `transactional.id` — which is the bridge to the next step.',
        ],
      },
    },
    {
      n: 'Step 04',
      title: 'Processed, and recorded as processed, atomically',
      accent: 'denim',
      rung: 'Rung 2 · Mechanism',
      diagram: <AtomicPairDiagram />,
      body: [
        'The consumer side has a nastier version of the same problem, because a consumer does **two things**: it produces an effect (writes a result, updates a total) and it records its progress (commits the input offset). Crash between them in one order and the effect happens again on replay; crash in the other order and the input is marked done without its effect. Two writes, two systems, a gap — Chapter 11’s dual-write bug, wearing a consumer costume.',
        'The fix has to make the pair atomic, and Kafka’s transactions do it by noticing that **an offset commit is just a write to another topic**. So a consume-transform-produce loop opens a transaction, writes its results to the output topic *and* its input offsets to the offsets topic inside it, and commits. The coordinator stamps every touched partition with a [[transaction marker|A control record the transaction coordinator writes into each partition a transaction touched, declaring it committed or aborted. Consumers in read_committed mode use the markers to skip aborted data.]]; consumers running [[read_committed|A consumer isolation mode that only delivers data from committed transactions, holding back anything newer than the first still-open transaction.]] deliver only what committed.',
        'Now walk the crash through it. Die mid-transaction: the coordinator times it out and writes abort markers; the results written so far become invisible; a successor replays from the *uncommitted* offset and produces them again — but since the aborted attempt is never read, the effect lands **once**. Progress and effect stopped being two facts that can disagree; they became one fact with two shadows.',
      ],
      deeper: {
        summary: 'The coordinator’s bookkeeping, and the zombie it has to shoot',
        body: [
          'Underneath: `transactional.id` maps to a coordinator broker, which logs the transaction’s state in an internal topic, then two-phases the finish — write the intent, then write commit markers into every touched partition. It is the two-phase commit the 2011 paper declined to pay for, made affordable by keeping every participant inside Kafka, where the coordinator’s log and the participants’ logs are the same kind of thing.',
          'The [[producer epoch|A counter bumped every time a producer re-registers its transactional id. The coordinator rejects requests stamped with an old epoch, which fences a paused-and-resumed predecessor out of committing anything.]] handles the survivor problem: your old producer instance, paused mid-transaction by a long GC, wakes after its replacement registered — and tries to commit. Its epoch is stale; the coordinator refuses. This is Chapter 8’s **fencing token**, verbatim, in a producer costume.',
        ],
      },
    },
    {
      n: 'Step 05',
      title: 'The guarantee ends at the door',
      accent: 'terra',
      rung: 'Rung 3 · Consequence',
      body: [
        'Everything in Steps 03–04 works because every participant is a Kafka log the coordinator can write markers into. The moment your consumer’s effect lands **outside** — a Postgres row, a payment API, an email — the transaction cannot reach it, and you are back at Step 02 holding the end-to-end argument: *the final system must be able to recognize a repeat, or the guarantee stops one hop short of the thing you cared about.*',
        'For a database sink there is a natural identity lying on the ground: the input’s partition and offset. Write them into the row — `INSERT ... ON CONFLICT (topic, partition, off) DO NOTHING` — and replay becomes a no-op; the offset was an address in the log, and it moonlights as an idempotence key. Going the other direction, database-then-Kafka, the same one-fact trick returns as the [[outbox pattern|Write the business row and an “event to publish” row in one database transaction, and let CDC ship the outbox to the log. The DB transaction is the atomic pair; the publisher can crash and retry freely.]] — Chapter 11’s change-data-capture, doing for the application what transactions did for the consumer.',
        'And some effects simply have no undo and no key: an email, an SMS, a legacy API that treats every call as new. There you shrink the window — dedup table checked before sending, send as late in the transaction as possible — and then write down, honestly, that the tail risk is nonzero. **“Exactly-once” is not a property a pipeline has; it is a property each effect has**, earned per sink, and the sinks that cannot earn it deserve a sentence in the design doc instead of a hope.',
      ],
      callout: {
        kind: 'bad',
        big: 'ONCE IS PER SINK',
        text: 'Kafka transactions make Kafka-to-Kafka exactly-once. Every exit into another system re-asks the question, and the answer must come from that system: a key it checks, or a transaction it joins.',
      },
      think: {
        q: 'Your consumer sends a welcome email, then crashes before committing. Replay sends it again. Where is the bug — and at which layer is it fixable?',
        a: 'There is no bug — every component did its job — which is what makes the question worth sitting with. The duplicate exists because “send email” produced its effect in a system that keeps no identity for the operation, so *no* layer below the mail provider can distinguish retry from repeat: not Kafka, whose transaction dutifully aborted and replayed; not your dedup table, which can shrink the window but not close it (crash after send, before the table write, and the table lies). The honest fixes are at the ends: a provider that accepts an idempotency key — then the key is the fix, end-to-end — or accepting the risk and choosing *which side to fail on*: commit-then-send loses an email on a crash between; send-then-commit duplicates one. Loss or duplicate, chosen per effect. That decision being unavoidable is the end-to-end argument, felt.',
      },
    },
  ],
  bubbles: [
    {
      term: 'sequence number',
      body: 'The producer’s per-partition counter, remembered by the broker. Makes transport retries recognizable, so at-least-once sending stops producing duplicates it cannot see.',
    },
    {
      term: 'producer epoch',
      body: 'Bumped each time a transactional id re-registers. Old epoch → request refused. Chapter 8’s fencing token, keeping a paused predecessor from committing after its successor took over.',
    },
    {
      term: 'transaction marker',
      body: 'The commit/abort control record the coordinator writes into every partition a transaction touched. What read_committed consumers navigate by.',
    },
    {
      term: 'read_committed',
      body: 'Consumer mode that delivers only committed transactional data — and therefore waits behind the oldest still-open transaction on the partition.',
    },
    {
      term: 'outbox pattern',
      body: 'Business row and event row written in one database transaction; CDC publishes the event. The atomic pair, hosted in the database instead of the log.',
    },
    {
      term: 'end-to-end argument',
      body: 'Reliability implemented in the middle of a system is an optimization, not a guarantee — only the endpoints know what “the same operation” means. 1984, and still deciding designs.',
    },
  ],
  inTheWild: {
    note: 'where “effectively once” goes to be tested',
    points: [
      '**The dedup was three layers below the duplicate.** A checkout service times out calling the order service and retries; the order service’s Kafka producer was idempotent all along. Two orders, each written exactly once. The postmortem discovers the end-to-end argument the expensive way: the retry that hurt was born above every layer that dedups.',
      '**One flag is mistaken for the whole guarantee.** A team enables idempotence (or reads that it is now the default) and announces the pipeline exactly-once. The flag dedups transport retries within a producer session — application resends, restarts and consumer replays are all still on the table. The claim was one mechanism wide and got reported as the whole property.',
      '**One hung transaction freezes every read_committed consumer.** The isolation level only delivers up to the first still-open transaction, so a producer that began one and stalled holds every downstream consumer at that watermark. Lag climbs on a healthy topic until the transaction times out — the guarantee’s cost, discovered as an incident.',
      '**The offset stops being a key when the coordinates change.** Rows deduped by (topic, partition, offset) survive replays perfectly — then the topic is re-created, or repartitioned, or backfilled from a copy, and every “address” is new. Coordinates make excellent idempotence keys only while the map never changes; identities from the event itself survive moves.',
      '**The side effects inside the transaction still happen twice.** The output records abort cleanly on retry — but the metrics counter the handler bumped, the log line it wrote, the cache it warmed, all fired on the aborted attempt too. Transactions cover the writes the coordinator can mark, and nothing else the code did along the way.',
    ],
  },
  tradeoffs: {
    title: 'Buying “once,” per effect',
    rows: [
      {
        choose: 'At-least-once plus an idempotent sink',
        when: 'the effect lands somewhere with a natural key — an upsert, a keyed PUT, an Idempotency-Key header. Cheapest and most robust; the guarantee lives at the end, where the end-to-end argument wanted it anyway.',
      },
      {
        choose: 'Kafka transactions',
        when: 'the whole loop is Kafka-to-Kafka — stream processors, consume-transform-produce. Buys atomic progress-plus-effect; costs latency, coordinator round trips, and read_committed consumers who wait behind open transactions.',
      },
      {
        choose: 'The outbox, with CDC',
        when: 'the database is the source of truth and Kafka must hear about every change. One DB transaction holds the pair; the publisher can crash freely. You inherit a CDC pipeline to operate — Chapter 11’s trade, again.',
      },
      {
        choose: 'At-most-once, on purpose',
        when: 'a duplicate costs more than a loss — metrics, telemetry, cache warming. Send without retry and let it go. The unfashionable option, and the right one more often than dashboards admit.',
      },
    ],
  },
  misconception: {
    think: '“Exactly-once means the message arrives exactly once — you just need the right settings.”',
    actually:
      'Arrival can never be guaranteed once: a sender that hears no ack cannot know whether to retry, and both guesses are wrong in one possible world — that ambiguity is structural, not a configuration gap. What the machinery actually builds is **at-least-once delivery plus recognition of repeats**: a sequence number so the broker recognizes the transport’s retries, a transaction so replay cannot recommit finished work, an idempotence key so the final sink recognizes the operation itself. Each mechanism covers exactly the duplicates born at its own layer, which is why the guarantee is assembled end to end or not at all. **“Effectively once” is not a hedge — it is the accurate name**: the wire delivers at-least-once, and the ends manufacture the once.',
  },
  sources: [
    {
      year: '1984',
      title: 'Saltzer, Reed & Clark — End-to-End Arguments in System Design',
      url: 'https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf',
      note: 'Nine pages from before most of this book’s systems existed, deciding arguments teams still have weekly. The file-transfer example in §2 is Step 02 of this chapter with 1984 hardware.',
    },
    {
      year: '2016',
      title: 'KIP-98 — Exactly Once Delivery and Transactional Messaging',
      url: 'https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging',
      note: 'The design document: producer ids, sequence numbers, the transaction coordinator, markers, and read_committed — with the rejected alternatives, which is where design documents earn their keep.',
    },
    {
      year: '2017',
      title: 'Neha Narkhede — Exactly-Once Semantics Are Possible: Here’s How Kafka Does It',
      url: 'https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/',
      note: 'The readable companion to KIP-98, by one of the 2011 paper’s authors — the same person, six years apart, on why “too expensive” became “shipped.” Read them together.',
    },
    {
      title: 'Designing Data-Intensive Applications (1st ed.), Ch 8 & Ch 11',
      note: 'Ch 8 for why the ambiguity is structural (unreliable networks, Two Generals); Ch 11 for “effectively once,” idempotent writes, and committing offsets with output — the sentences this chapter expands.',
    },
  ],
  seenIn: [
    { label: 'Kafka — idempotent producer and purgatory, in the traces', to: '/ddia/components/kafka', live: true },
    { label: 'Stream–Table Duality — where “effectively once” was first promised', to: '/ddia/read/stream-table', live: true },
    { label: 'Why It’s Hard — the fencing token, in its original costume', to: '/ddia/read/distributed-troubles', live: true },
    { label: 'Write Once, Replay Everywhere — the 2011 paragraph this expands', to: '/papers/kafka', live: true },
  ],
  finale: {
    title: 'The once is manufactured at the end',
    body: 'The network offers two honest options — lose it or maybe double it — and every layer that promises more is describing work done somewhere specific: a broker checking a sequence number against the retries it can see, a coordinator making progress and effect commit as one fact, a sink checking a key against effects it already produced. None of these is “exactly-once” alone; each recognizes precisely the duplicates born at its own layer, and the guarantee exists only where the chain of recognition reaches the last system that matters. That is what the 1984 paper said about file transfer, what the 2011 paper meant by “cheaper in the consumer,” and what the design doc for your next pipeline should say per sink — because the question is never whether the pipeline is exactly-once. It is whether this effect, here, would recognize its own repeat.',
  },
  next: { slug: 'rebalance', title: 'The Rebalance' },
}
