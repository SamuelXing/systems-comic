import type { Comic } from '../types'
import { RebalanceTimelineDiagram, CooperativeDiagram } from '../diagrams'

export const rebalance: Comic = {
  slug: 'rebalance',
  chapter: 'Extension · Group Membership',
  chapterNo: 'Ext 3',
  title: 'The Rebalance',
  dek: 'A consumer group promises each partition to exactly one reader, and keeps that promise by occasionally stopping the world. What happens in those seconds, why a rolling deploy multiplies them, and the twenty-year project of shrinking the pause.',
  minutes: 6,
  caption:
    'The deploy went out at 4:00. The lag alarm fired at 4:02. Nothing is broken — twelve consumers are politely taking turns leaving and rejoining a group, and the group is doing what the protocol demands: **stopping everyone, every time, to recount who owns what.** *The papers book’s Kafka chapter made a design bet sound free — consumers coordinate only when membership changes, and membership changes are rare. This chapter is an extension: it is about the day they are not rare, and what that coordination actually does while you wait.*',
  steps: [
    {
      n: 'Step 01',
      title: 'One partition, one owner',
      rung: 'Rung 1 · Intuition',
      body: [
        'Begin with why the promise exists at all. A partition is the unit of ordering, so a group allows it **exactly one owner**: two consumers reading one partition would interleave its processing and race each other’s offset commits — order gone, progress a lie. Ownership must be exclusive, and it must be *agreed*, by processes that share nothing and fail freely.',
        'The Kafka design chose to pay for that agreement **only at membership changes**: while the roster holds, consumers run without coordinating at all — no locks, nothing on the hot path. The alternative, negotiating ownership continuously, is what the 2011 paper walked away from. It was the right bet, and it has a fine-print clause: *all* the coordination this system ever does gets compressed into the moments the roster changes.',
        'Which means every deploy, every crash, every scale-up, every pod that pauses too long at the wrong moment — each one cashes in the whole coordination bill at once. The rest of this chapter is that bill.',
      ],
    },
    {
      n: 'Step 02',
      title: 'Stop the world, count heads',
      accent: 'terra',
      rung: 'Rung 2 · Mechanism',
      diagram: <RebalanceTimelineDiagram />,
      body: [
        'The classic protocol runs through a [[group coordinator|A broker, picked by hashing the group id, that tracks membership by heartbeat and referees rebalances. It counts heads and enforces generations — it does not choose the assignment.]] — a broker that tracks the roster by heartbeat. When anything changes — a member joins, leaves, or misses its heartbeats — the coordinator declares a new [[generation number|The group’s epoch, bumped on every rebalance. Offset commits are stamped with it, and a commit carrying an old generation is refused — which is what makes an ex-owner harmless.]] and calls a rebalance: every member abandons its partitions and re-joins.',
        'Then a detail that surprises everyone the first time: **the coordinator does not decide who gets what.** It picks one consumer as group leader and hands it the member list; the *leader* computes the assignment — range, round-robin, or [[sticky assignment|An assignment strategy that minimizes movement: keep everyone’s current partitions where possible and reassign only what must move. The insight that eventually became the cooperative protocol.]] — and the coordinator distributes the result. Assignment lives client-side so strategies stay pluggable without upgrading brokers; the price is that the group’s brain is one of its own members.',
        'Between the revoke and the final sync, the group owns nothing and consumes nothing — the terra gap in the figure. And the generation number is doing quiet, familiar work: an ex-owner that wakes up late and tries to commit offsets is carrying last generation’s stamp, and the coordinator refuses it. **Chapter 8’s fencing token, a third appearance** — epochs for producers in the last chapter, generations for consumers here.',
      ],
    },
    {
      n: 'Step 03',
      title: 'The storm',
      accent: 'terra',
      rung: 'Rung 3 · Consequence',
      body: [
        'Now compound it. A rolling deploy of twelve pods is twelve leaves and twelve joins — up to **two dozen rebalances**, each one a full stop for the whole group, back to back for the length of the deploy. Nothing is failing; the protocol is simply billing you per roster change, and a deploy is a roster change per pod.',
        'Two different timers decide who gets thrown out, and confusing them is a genre of postmortem. The [[session timeout|How long the coordinator waits for heartbeats before declaring a consumer dead. Heartbeats come from a background thread — so a hung handler can look perfectly alive by this timer.]] watches heartbeats — but heartbeats run on a background thread, so a consumer whose *handler* is stuck looks alive. The real tripwire for slow processing is [[max.poll.interval|The longest a consumer may go between calls to poll(). Exceed it and the consumer concludes it is stuck, resigns from the group, and its partitions are revoked — while its heartbeats were still flowing.]]: go too long without asking for more work and you are presumed wedged, and evicted — heartbeats notwithstanding.',
        'And every eviction abandons in-flight work at an uncommitted offset, which the next owner replays: **duplicates, exactly the ones the previous chapter taught you to catch.** A GC pause longer than the session timeout means dead-then-back: two rebalances. A poison message that takes twenty minutes means evicted-mid-chew: rebalance, redeliver, re-chew. The storm is rarely one failure — it is the protocol’s fixed cost multiplied by an unlucky rhythm.',
      ],
      code: {
        file: 'the two timers',
        lines: [
          { t: 'session.timeout.ms      # heartbeats, background thread' },
          { t: '  → "is the process alive?"' },
          { t: '' },
          { t: 'max.poll.interval.ms    # gaps between poll() calls' },
          { t: '  → "is the handler making progress?"', hl: 'good' },
          { t: '' },
          { t: '# a hung handler passes the first test', hl: 'bad' },
          { t: '# and fails the second. know which fired.', hl: 'bad' },
        ],
      },
      think: {
        q: 'One poison message takes twenty minutes to process. Heartbeats are flowing the whole time. Why does the group rebalance anyway — and what happens to that message next?',
        a: 'Heartbeats only answer “is the process alive,” and the process is fine — it is the *handler* that is stuck, and the handler’s timer is `max.poll.interval`. Twenty minutes without a `poll()` and the consumer concludes it is wedged, resigns, and triggers a rebalance. Now the good part: its offsets were never committed, so the poison message is **redelivered — to a different consumer**, which also chews for twenty minutes, also blows the interval, also resigns. The message ping-pongs across the group, each hop billing a full rebalance, and the lag graph looks like the whole pipeline is dying when it is one record. This is why the poison-pill playbook — try-catch, retry budget, dead-letter topic — is not optional hygiene; it is the difference between one bad message and an afternoon-long membership crisis.',
      },
    },
    {
      n: 'Step 04',
      title: 'Move only what moves',
      accent: 'denim',
      rung: 'Rung 2 · Mechanism',
      diagram: <CooperativeDiagram />,
      body: [
        'The stop-the-world revoke was always stronger than the actual safety requirement. The invariant is “no partition owned by two consumers at once” — and if a rebalance moves one partition out of six, the other five never needed to leave anybody’s hands. Eager revocation was correctness by sledgehammer.',
        'Two fixes, both amounting to *moving less*. [[static membership|Give each consumer a persistent name (group.instance.id). A restart under the same name within the session timeout reclaims its old partitions silently — no rebalance, because identity survives the reconnection.]] attacks the deploy case: the roster never sees a restart as a departure, so the commonest membership change stops being a membership change at all. And [[cooperative rebalance|The incremental protocol (KIP-429): rebalance in two rounds, where consumers keep every partition not being reassigned and only the moving ones pause. The eager revoke-everything step is gone.]] rewrites the protocol itself: members keep what is not moving, and only the partitions actually changing hands go through a revoke-and-reassign — the denim half of the figure, where five of six never stop.',
        'The idea is older than either feature: the sticky assignor was already minimizing *movement*, but under the eager protocol everyone still dropped everything first, then mostly picked their own partitions back up. Cooperative rebalancing is the protocol finally believing the assignor: **if almost nothing moves, almost nothing should stop.**',
      ],
    },
    {
      n: 'Step 05',
      title: 'Retire the barrier',
      accent: 'denim',
      rung: 'Rung 3 · Consequence',
      body: [
        'The endgame ships in Kafka 4.0 as the next-generation protocol, KIP-848, and it deletes the two oldest decisions at once. **Assignment moves server-side** into the coordinator — the leader-consumer, the client-side strategies, the group-wide JoinGroup barrier, all gone. Each consumer just heartbeats; the coordinator computes the target assignment and *reconciles members toward it individually*, one revoke-then-grant at a time, with per-member epochs. There is no moment when the group as a whole stops.',
        'Notice the arc, because it is the same arc twice over. The global pause went from “everything stops” to “only what moves stops” to “nothing globally stops” — a lock, then a finer lock, then no lock, which is every distributed system’s maturation story. And the client-side assignor — the flexibility that justified putting the group’s brain in a consumer — was quietly demoted, because a pluggability almost nobody used was billing a barrier everybody paid. *Kafka made the same call when it swallowed ZooKeeper: generality owned by someone else, traded for a protocol it could finally make boring.*',
        'That is the answer to this chapter’s subtitle. Who decided the pause was worth it? The 2011 design did, when it compressed all coordination into membership changes — a good bet whose bill came due at cloud-native deploy frequencies, and then took fifteen years of KIPs to re-amortize.',
      ],
    },
  ],
  bubbles: [
    {
      term: 'group coordinator',
      body: 'The broker refereeing a group: heartbeats in, generations out. In the classic protocol it counts heads while a consumer computes the assignment; in the new one it does both.',
    },
    {
      term: 'generation number',
      body: 'The group’s epoch, bumped per rebalance. Commits carry it; stale ones are refused. The fencing token’s third costume in three chapters.',
    },
    {
      term: 'session timeout',
      body: 'Heartbeat deadline for “is the process alive.” Answered by a background thread — which is exactly why it cannot see a stuck handler.',
    },
    {
      term: 'max.poll.interval',
      body: 'Progress deadline for “is the handler working.” Blow it and the consumer resigns, its partitions revoked with offsets uncommitted — the duplicate factory.',
    },
    {
      term: 'static membership',
      body: 'A persistent per-consumer name, so a restart is a reconnection instead of a departure. Deploys stop being membership changes.',
    },
    {
      term: 'cooperative rebalance',
      body: 'The incremental protocol: keep everything that is not moving, pause only what is. Replaced eager’s revoke-everything in the name of the actual invariant.',
    },
  ],
  inTheWild: {
    note: 'the seconds, as they are actually spent',
    points: [
      '**A graceful shutdown causes more rebalances than a crash.** `close()` announces the departure and triggers a rebalance *now*; `kill -9` just goes quiet, and nothing happens until the session timeout. So a polite rolling restart fires one rebalance per pod immediately, while a crashed pod buys the group thirty quiet seconds. Static membership flips the ergonomics back: the named restart rejoins silently, and sudden death still gets detected.',
      '**The state took longer to move than the partitions.** In Kafka Streams, losing a partition means losing its state store; the new owner rebuilds it by replaying a changelog topic, and a store that took a week to accumulate takes real minutes to replay. The pause the protocol charges is seconds — the pause the *state* charges is the one on the incident timeline. Standby replicas exist precisely to pre-pay it.',
      '**The autoscaler and the rebalance take turns making each other worse.** Lag spikes, the autoscaler adds consumers, the rebalance pauses the group, the pause grows the lag, the autoscaler adds more. Rebalance pause is dead time in the control loop — the same trap as the web tier’s scaling lag, with the protocol itself as the delay.',
      '**CommitFailedException is the protocol working, and a retry loop hides it.** After an eviction, the old consumer’s commit is refused — stale generation, exactly as designed. Code that catches the exception and blindly retries or swallows it turns a clean fence into silent duplicate processing. The exception is a message: you no longer own this partition; stop, and let replay do its job.',
      '**Somebody set session.timeout to five seconds “for fast failover.”** Every GC pause, VM migration and network blip now reads as a death; the group spends its life recounting heads. Failure detection speed trades directly against stability — Chapter 8’s timeout dilemma, billed at group scale. The defaults are long for a reason.',
    ],
  },
  tradeoffs: {
    title: 'Choosing how the group holds together',
    rows: [
      {
        choose: 'Dynamic membership, cooperative protocol',
        when: 'the default, and the right one for elastic fleets — members come and go, only moving partitions pause. Expect duplicates on every revocation and keep the previous chapter’s machinery in place.',
      },
      {
        choose: 'Static membership on top',
        when: 'membership is actually stable and restarts are routine — Kubernetes with stable pod identities. Restarts stop billing rebalances; the cost is that a truly dead pod sits undetected until the session timeout you now set longer.',
      },
      {
        choose: 'Manual assignment, no group',
        when: 'you cannot afford any rebalance, ever, and are willing to be your own coordinator — assign() pins partitions to processes, and failure detection, restarts and ownership moves become your code’s problem. A real choice for small fixed topologies; a trap as a reflex.',
      },
      {
        choose: 'Standby state, not just standby consumers',
        when: 'the real pause is state rebuild, not partition reassignment — Streams with heavy stores. Warm replicas make the handoff a pointer swap instead of a changelog replay.',
      },
    ],
  },
  misconception: {
    think: '“The broker assigns partitions to consumers.”',
    actually:
      'In the protocol that ran the world for fifteen years, **the broker never chose anything** — the coordinator counted heads, then handed the roster to one of the *consumers*, elected leader for the round, and that consumer computed who owns what. Assignment was a client-side function so strategies could be swapped without touching brokers — and that one choice explains a family of production mysteries: a custom assignor with a bug can wedge a group no broker restart will fix; consumers on different client versions can disagree about strategy mid-upgrade; and the whole group must synchronize at a barrier so the leader can see everyone at once, which is *why* eager rebalancing stopped the world. KIP-848 finally moved the brain server-side — the misconception is now becoming true, twenty years late, and the fact that it took a protocol redesign is the measure of how load-bearing the original choice was.',
  },
  sources: [
    {
      year: '2019',
      title: 'KIP-429 — Kafka Consumer Incremental Rebalance Protocol',
      url: 'https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol',
      note: 'Cooperative rebalancing’s design doc: why eager revocation was stronger than the invariant needed, and the two-round dance that fixes it without ever allowing double ownership.',
    },
    {
      year: '2022',
      title: 'KIP-848 — The Next Generation of the Consumer Rebalance Protocol',
      url: 'https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol',
      note: 'The retirement papers for the global barrier and the leader-consumer. The motivation section is an unusually frank autopsy of the classic protocol’s failure modes.',
    },
    {
      year: '2020',
      title: 'Confluent — From Eager to Smarter: Incremental Cooperative Rebalancing',
      url: 'https://www.confluent.io/blog/incremental-cooperative-rebalancing-in-kafka/',
      note: 'The practitioner’s telling, with the measurements: what stop-the-world cost real deployments, and what cooperative recovered. Good companion to KIP-429’s formalism.',
    },
    {
      title: 'Kafka documentation — consumer groups & group membership',
      url: 'https://kafka.apache.org/documentation/#consumerconfigs',
      note: 'The two timers, static membership and assignment strategies, precisely specified. Read the config descriptions for session.timeout.ms and max.poll.interval.ms side by side — the distinction is this chapter’s Step 03.',
    },
  ],
  seenIn: [
    { label: 'Kafka — rebalance storms, in the failure gallery', to: '/ddia/components/kafka', live: true },
    { label: 'Exactly-Once, Mechanically — what every revocation replays', to: '/ddia/read/exactly-once', live: true },
    { label: 'Why It’s Hard — fencing tokens and the timeout dilemma', to: '/ddia/read/distributed-troubles', live: true },
    { label: 'Write Once, Replay Everywhere — the bet this chapter audits', to: '/papers/kafka', live: true },
  ],
  finale: {
    title: 'The bill for coordinating rarely',
    body: 'The 2011 design compressed all of a group’s coordination into the moments its membership changes, and that compression is why the hot path is free — and why everything else lands at once when the roster moves: the generation bump, the fencing of stale commits, the abandoned offsets replaying as duplicates, the seconds of a world stopped to let one consumer compute who owns what. Twenty years of protocol work has been a careful un-compressing — sticky assignment so less moves, static identity so restarts stop counting, cooperative rounds so the unmoved never pause, and finally a coordinator that reconciles members one at a time with no barrier at all. The promise never changed: one partition, one owner. What changed is how much of the world has to stop to keep it — which turned out to be, with enough care, almost none of it.',
  },
  next: { slug: 'tail-latency', title: 'Tail Latency' },
}
