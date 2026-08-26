import type { Comic } from '../types'
import { FlowForkDiagram, DelayCurveDiagram, CreditLoopDiagram, ChiuJainDiagram } from '../diagrams'

export const backpressure: Comic = {
  slug: 'backpressure',
  chapter: 'Extension · Flow Control',
  chapterNo: 'Ext 1',
  title: 'Backpressure',
  dek: 'A producer that outruns its consumer leaves a system three exits: throw work away, pile it up, or make the sender slow down. Everything with a queue in it — TCP, RabbitMQ, Kafka, Flink — is an arrangement of those three, and the arrangement has mathematics.',
  minutes: 7,
  caption:
    'Between every producer and consumer sits a buffer, and the buffer obeys one line of arithmetic: it grows by exactly **arrivals minus departures**. While the consumer keeps up, the buffer sits empty and nobody thinks about it. The day the producer gets faster — for a burst, or for good — the system has to answer a question it was hoping to avoid: **who gets hurt?** The sender, the reader, or the data. *DDIA raises exactly this on the first page of Chapter 11 — three options, a nod at TCP — and moves on. This chapter is an extension: it follows the nod the rest of the way down.*',
  steps: [
    {
      n: 'Step 01',
      title: 'Three exits, and no fourth',
      accent: 'terra',
      rung: 'Rung 1 · Intuition',
      diagram: <FlowForkDiagram />,
      body: [
        'Call the arrival rate **λ** and the consumer’s processing rate **μ**. The queue between them is an integral: `Q(t) = Q(0) + ∫(λ − μ)dt`. Nothing about brokers or protocols yet — just conservation. Work that comes in and does not go out is *somewhere*.',
        'So when λ exceeds μ, there are exactly three places the excess can go. **Drop it** — refuse at the door, discard on the floor, send a 429. **Buffer it** — let the queue absorb the difference and hope the imbalance is temporary. Or [[backpressure|Making the sender slow down instead of dropping data or growing a queue — pushing the rate mismatch back to where the work comes from.]] — push the problem upstream and make the sender slow to what the consumer can take.',
        'Every real system is some arrangement of the three. A Unix pipe blocks the writer: backpressure. UDP silently discards: drop. Kafka writes the backlog to disk: buffer, a very large one. None of these is wrong. What is wrong — and common — is not knowing which one you picked.',
      ],
      code: {
        file: 'the invariant',
        lines: [
          { t: 'Q(t) = Q(0) + ∫ (λ − μ) dt' },
          { t: '' },
          { t: 'λ ≤ μ long-run  → any buffer works', hl: 'good' },
          { t: 'λ > μ long-run  → no buffer is big enough', hl: 'bad' },
        ],
      },
      callout: {
        kind: 'bad',
        big: 'λ > μ',
        text: 'A sustained rate mismatch cannot be bought off with memory. A bigger buffer changes the date of the outage, not the fact of it.',
      },
    },
    {
      n: 'Step 02',
      title: 'What a buffer actually costs',
      accent: 'terra',
      rung: 'Rung 2 · Mechanism',
      diagram: <DelayCurveDiagram />,
      body: [
        'Buffering feels free because its legitimate job is invisible: absorbing **variance**. Traffic arrives in bursts; a queue smooths the bursts over the quiet moments between them. That works precisely when the long-run average fits — the buffer buys you tolerance of *fluctuation*, never of *rate*.',
        'The bill is delay, and it is not optional. [[Little’s Law|L = λW: the average number of items in a system equals arrival rate times average time spent inside. Rearranged, W = L/λ — a queue’s length, divided by its throughput, is its delay.]] says the items in the queue and the time they spend there are the same fact: `L = λW`. A million-message backlog draining at ten thousand per second *is* a hundred seconds of latency — for every message, including the fresh one that just arrived and now waits behind the pile. An unbounded buffer does not remove failure; it converts a loud one (errors) into a quiet one (staleness).',
        'And queues get expensive before they get full. With any randomness in arrivals, the average wait grows like **1/(μ − λ)** — a hyperbola, not a line. At 80% utilization the wait is already five times the idle wait; at 95% it is twenty. This curve, not caution, is why capacity planning keeps saying *“target 80% of sustained max”*: the last fifth of a machine’s throughput is bought with almost all of the latency.',
      ],
      think: {
        q: 'Memory is cheap. Why not give every queue an enormous buffer, just in case?',
        a: 'Because a buffer sized in messages is a **latency promise you did not mean to make** — Little’s Law converts its length into seconds, and callers time out long before it fills. Now the queue holds work whose requesters have hung up: the consumer burns capacity computing answers nobody will read, which lowers its effective μ, which grows the queue further. Worse, a huge buffer *hides the signal*: upstream sees every send succeed, so nothing tells it to slow down, and the first symptom anyone observes is that the whole pipeline is minutes stale. Networking has a name for this — [[bufferbloat|Buffers so large that the congestion signal (loss, delay) disappears into them: senders never learn to slow down, and latency inflates to fill the memory available.]] — router buffers so deep that TCP never sees a drop, so it never slows, so every packet queues behind seconds of others. The buffer did not fix the overload. It anesthetized it.',
      },
    },
    {
      n: 'Step 03',
      title: 'Credit: permission to send, counted',
      accent: 'denim',
      rung: 'Rung 2 · Mechanism',
      diagram: <CreditLoopDiagram />,
      body: [
        'Here is the mechanism that makes backpressure work over a network. The receiver announces how much it can take — its free buffer, counted in bytes or messages. The sender may have **at most that much in flight, unacknowledged**. Every acknowledgement hands back one unit of permission. That number is called [[credit|Permission to send, counted. The receiver grants it (a window, a prefetch limit, permits, request(n)); the sender never has more in flight than it holds; every consumed item returns some.]], and the loop it forms is the whole design: *the consumer’s progress is the producer’s throttle.*',
        'The oldest mass-deployed version is TCP’s **receive window**: every ACK carries the receiver’s remaining buffer space, and a sender facing a zero window stops — it has been running under every connection you have opened since 1981. RabbitMQ’s **prefetch** is the same number for messages: at most N unacked deliveries per consumer, ack one to receive one. Pulsar’s consumers grant the broker **permits**. Reactive Streams calls it `request(n)`. *Four names, four decades, one mechanism.*',
        'This is also where the old push-versus-pull argument quietly dissolves. Bare push — the broker sends at its own pace — is credit with the counter deleted, and it drowns slow consumers. Pull is credit in disguise: a fetch request *is* an explicit grant (“here is how much you may send me”), and silence is a zero window. Once you see the counter, the question is never push or pull. **It is who issues the permission, and how often.**',
      ],
      deeper: {
        summary: 'The window is also your speed limit: sizing credit with one multiplication',
        body: [
          'Credit caps in-flight data, and in-flight data over a round trip is throughput: **rate ≤ credit / RTT**. To keep a link busy you need credit of at least the [[bandwidth-delay product|The data “in the pipe” when a link runs full: bandwidth × round-trip time. Any credit or window smaller than this caps throughput below the link’s capacity.]] — target rate × round-trip time. The same multiplication sizes a consumer’s prefetch: `prefetch ≈ processing rate × RTT`, with headroom.',
          'Both directions of getting it wrong are common. Too small, and the consumer drains its window, then idles a full round trip waiting for more — the mysterious slow consumer that moved to another region. Too large, and one consumer hoards the backlog its peers should be sharing; its memory balloons, and when it dies, everything it held redelivers at once. Unlimited prefetch is this failure with the safety off.',
        ],
      },
    },
    {
      n: 'Step 04',
      title: 'Strangers sharing a pipe: AIMD',
      accent: 'denim',
      rung: 'Rung 2 · Mechanism',
      diagram: <ChiuJainDiagram />,
      body: [
        'Credit protects a receiver from its senders. It says nothing about the other problem: **many senders sharing something in the middle** — a link, a broker — that issues no credit and will not say what its capacity is. Each sender knows only one bit, learned the hard way: “my last send got through” or “it did not.” From that bit alone, everyone must find a rate that fills the pipe *and* shares it fairly with strangers they cannot see.',
        'Chiu and Jain settled this in 1989 with a drawing. Put two senders’ rates on a plane, one per axis. Full capacity is the line `x₁+x₂ = C`; fairness is the 45° line `x₁ = x₂`; the target is their crossing. Now watch the two kinds of move. **Adding a constant to both rates slides the point at 45°** — parallel to the fairness line, and it shrinks the *ratio* between the two senders. **Multiplying both by a constant slides the point along a ray through the origin** — the ratio does not move at all.',
        'So increase must be additive and decrease must be multiplicative: every increase step improves fairness, and no decrease step gives it back. **AIMD** — climb by a constant, cut by a fraction on congestion — is the only linear rule where the fair, full corner attracts. TCP’s version: one packet per round trip up, halve on loss. The sawtooth on every throughput graph is this drawing, running.',
        '*The decrease is the moral of it.* Cutting multiplicatively means whoever holds the most gives back the most; adding constantly means the small sender catches up at the same absolute pace as the large one grows. Fairness is not negotiated between the senders — it is a property of the arithmetic.',
      ],
      deeper: {
        summary: 'Killing the other three quadrants, and what the sawtooth costs',
        body: [
          'The other combinations die by invariant. **Additive-increase, additive-decrease** preserves the *difference* between two senders forever — start unfair, stay unfair. **Multiplicative both ways** preserves the *ratio* — same sentence. **Multiplicative-increase, additive-decrease** is worst: the increase widens absolute gaps and the decrease worsens ratios, so it actively diverges from fairness. Only [[AIMD|Additive increase, multiplicative decrease: grow your rate by a constant each round, cut it by a fraction on congestion. The only linear control rule that converges to a fair, full share of a blind, shared resource.]] converges.',
          'The sawtooth has a price you can compute: average throughput scales with `1/√p` for loss rate p, so on long fat links a whisper of random loss caps the rate far below capacity — the reason BBR and friends measure delay instead of waiting for drops. And the model assumes everyone hears congestion at the same tempo; real flows with shorter round trips climb faster and grab more, which is why the fairness is honest-but-approximate.',
        ],
      },
      callout: {
        kind: 'good',
        big: 'penalty ∝ holdings',
        text: 'Multiplicative decrease is fairness enforcement: the sender holding the most gives back the most. Additive increase is opportunity: everyone gains at the same absolute rate, so the small flow closes the gap.',
      },
    },
    {
      n: 'Step 05',
      title: 'Where the pressure finally lands',
      accent: 'terra',
      rung: 'Rung 3 · Consequence',
      body: [
        'Pressure is conserved. You can move it; you cannot delete it. Follow one real chain: a Kafka consumer group slows down, replicas lag, the broker’s responses stretch. The broker stops draining its sockets, so **TCP’s window closes** against every producer. The producer client’s sender thread blocks on the socket, so its in-memory accumulator fills; when `buffer.memory` is gone, `send()` itself blocks the calling thread. Which is your checkout API’s request handler. **The incident channel now reads “checkout is down,” and the messaging system is four hops away from the symptom.** Every hop was a full queue closing a window on the hop before — a chain of credit loops, doing exactly what they promise.',
        'Stream processors run the same chain deliberately. Inside a Flink job, every stage feeds the next through small bounded buffers with **per-channel credit** — bounded because a checkpoint must wait for in-flight data, so unbounded in-flight means unbounded recovery. (Flink learned the granularity lesson the hard way: it once let TCP alone carry the backpressure, and one slow channel froze every channel multiplexed on the same connection — the same head-of-line blocking that pushed HTTP/2 to become QUIC. The fix was to rebuild the window *per logical channel*, one layer up.)',
        'And when the pressure reaches the job’s source, it meets the log — and turns into something else. A source under backpressure simply stops fetching, and **consumer lag grows**: the disk absorbs what the pipeline refused to hold. That is the architecture, seen whole: *tight credit loops where in-flight data must stay small, one enormous buffer at the boundary where lag is survivable, and drop reserved for the front door.* Designing the system is choosing where the pressure is allowed to land.',
      ],
      think: {
        q: 'Kafka consumers run no credit protocol — no permits, no prefetch cap, nothing. Where did the flow control go?',
        a: 'Into the shape of the request. A fetch is an explicit, bounded grant — “send me up to `fetch.max.bytes`, from this offset” — and not fetching is a zero window. The broker physically cannot overrun a consumer, because it only ever answers. That is credit reduced to request–response, and it costs one round trip per grant, which is exactly the cost the long-poll trick pays back: a fetch with no data to claim parks on the broker until data arrives, so the next grant is already waiting there when it does. The pull-versus-push war, up close, is an accounting question — **who holds the counter, and how many round trips a refill costs** — and both camps ended up holding a counter.',
      },
    },
  ],
  bubbles: [
    {
      term: 'backpressure',
      body: 'Slowing the sender to the receiver’s pace instead of dropping work or growing a queue. Not a failure — the feedback loop doing its job. The alternative is pressure with no visible gauge.',
    },
    {
      term: 'credit',
      body: 'Permission to send, counted by the receiver: TCP’s window, RabbitMQ’s prefetch, Pulsar’s permits, Reactive Streams’ request(n). In flight ≤ credit; each ack refills one.',
    },
    {
      term: 'Little’s Law',
      body: 'L = λW. Queue length, throughput and waiting time are one fact in three units — so a buffer sized in messages is secretly a promise about seconds.',
    },
    {
      term: 'bandwidth-delay product',
      body: 'Rate × round-trip time: the amount of data “in the pipe” when a link runs full. Credit below this caps throughput; credit far above it hoards work on one consumer.',
    },
    {
      term: 'AIMD',
      body: 'Add a constant when things go well, multiply by a fraction when they don’t. The only linear rule by which blind strangers sharing a pipe converge on fair, full use of it.',
    },
    {
      term: 'bufferbloat',
      body: 'A buffer so large the congestion signal disappears into it. Senders never learn to slow down, and latency — not loss — inflates to fill the memory available.',
    },
  ],
  inTheWild: {
    note: 'where the pressure actually shows up',
    points: [
      '**The messaging outage that pages the wrong team.** A broker slows; producer clients quietly buffer; the moment `buffer.memory` fills, `send()` blocks the application thread that called it — and an API with no obvious relationship to Kafka stops answering. The chain (socket window → client buffer → your thread) is documented, but almost nobody reads it until the postmortem.',
      '**One consumer with unlimited prefetch eats the queue.** It grabs the entire backlog into its own memory, its peers starve at zero utilization, and when it crashes, everything it held redelivers in one burst. The fix is one number: a finite prefetch on every consumer, sized rate × round trip.',
      '**Moving a consumer to another region silently caps its throughput.** Credit drains in one round trip; refills take another. A prefetch tuned on a 1 ms LAN is thirty times too small at 30 ms — the consumer idles between windows and the graphs blame the code. `rate ≤ credit / RTT` is the whole diagnosis.',
      '**Dropping without backoff amplifies the load.** Shed requests with a bare 429 and clients retry immediately — arrivals *rise* exactly when capacity falls. Load shedding only sheds if the client slows down: exponential backoff is AIMD, reinvented at the application layer, usually after the first retry storm.',
      '**The unbounded queue converts overload into dead work.** Callers time out at thirty seconds; the queue holds two minutes; so every accepted request is computed and delivered to nobody. Throughput looks healthy while goodput is zero. A queue longer than your callers’ patience is a drop policy — one that does the work first.',
      '**Flow control at the wrong granularity freezes the innocent.** One slow stream sharing a TCP connection stalls every stream on it — Flink before credit-based flow control, HTTP/2 under loss, any multiplexed protocol relying on the transport’s single window. The window has to live at the granularity of the thing you want to protect.',
    ],
  },
  tradeoffs: {
    title: 'Where should the pressure land?',
    rows: [
      {
        choose: 'Refuse work at the door',
        when: 'your latency promise matters more than serving everyone, and callers can retry later — load shedding, a 429 with backoff. Only works if the refusal actually slows the sender; a drop that triggers an instant retry raised λ, not lowered it.',
      },
      {
        choose: 'Absorb it in memory',
        when: 'the overload is a burst and the long-run average fits. Size the buffer in seconds of delay via Little’s Law, not in messages — its length is a latency you are agreeing to serve.',
      },
      {
        choose: 'Send the pressure upstream',
        when: 'you control the pipeline end to end and in-flight data must stay bounded — credit, prefetch, request(n). The honest cost: a slow consumer now idles the producer, visibly. That visibility is the feature.',
      },
      {
        choose: 'Park it on disk in a log',
        when: 'producers must never block and readers may lag — the Kafka position. Retention becomes a deadline and consumer lag the gauge; the pressure did not vanish, it became a number somebody must watch.',
      },
    ],
  },
  misconception: {
    think: 'Kafka proved pull beats push. Push is what the losing systems did.',
    actually:
      'Bare push lost — pushing at the broker’s pace with no counter drowns slow consumers, and the 2011 Kafka paper was right to bury it. But push with **credit** never lost anything: TCP has pushed bytes under flow control since before any of these systems existed, RabbitMQ pushes under a prefetch cap, Pulsar pushes against consumer-granted permits. And pull is not credit’s opposite — it is credit’s *degenerate case*, where the grant rides inside the request and silence is a zero window. The war was never push versus pull. It was **counted versus uncounted**, and every survivor counts.',
  },
  sources: [
    {
      year: '1989',
      title: 'Chiu & Jain — Analysis of the Increase and Decrease Algorithms for Congestion Avoidance',
      url: 'https://www.cs.wustl.edu/~jain/papers/ftp/cong_av.pdf',
      note: 'The phase-plane drawing in Step 04, from the people who drew it first. Eleven pages, one figure doing most of the work — read §2 for the vector arguments and enjoy a proof you can check with a ruler.',
    },
    {
      year: '1988',
      title: 'Van Jacobson — Congestion Avoidance and Control (SIGCOMM)',
      url: 'https://ee.lbl.gov/papers/congavoid.pdf',
      note: 'Written while the 1986 Internet was collapsing under congestion — throughput fell a thousandfold — and slow start and AIMD went into BSD as the treatment. The rare paper that is also an incident report.',
    },
    {
      title: 'Designing Data-Intensive Applications (1st ed.), Ch 11',
      note: 'The drop / buffer / backpressure trichotomy appears in the first pages of the chapter, applied to message brokers — the framing this comic is built on.',
    },
    {
      year: '2019',
      title: 'Apache Flink — A Deep-Dive into Flink’s Network Stack',
      url: 'https://flink.apache.org/2019/06/05/flink-network-stack.html',
      note: 'Credit-based flow control per logical channel, and why relying on TCP’s single window caused head-of-line blocking — the granularity lesson of Step 05, from the team that learned it.',
    },
  ],
  seenIn: [
    { label: 'RabbitMQ — prefetch and per-hop credit, animated', to: '/ddia/components/rabbitmq', live: true },
    { label: 'Kafka — the log that absorbs what the pipeline refuses', to: '/ddia/components/kafka', live: true },
    { label: 'Stream–Table Duality — why the log can afford to lag', to: '/ddia/read/stream-table', live: true },
    { label: 'Web tier — the queueing hyperbola, live in the envelope', to: '/ddia/components/web', live: true },
    { label: 'Write Once, Replay Everywhere — the paper that voted pull', to: '/papers/kafka', live: true },
  ],
  finale: {
    title: 'Pressure is conserved',
    body: 'Strip the vocabulary away and every system in this chapter is answering the same question: the producer is faster, so who gets hurt? Drop hurts the data, buffering hurts the reader (in seconds, priced by Little’s Law), backpressure hurts the sender — and a design that refuses to choose has still chosen, it just finds out during an incident. The mature architectures are legible maps of where pressure is allowed to land: credit loops where in-flight work must stay small, a log at the boundary where lag is survivable, refusal at the front door where the latency promise is the product. Underneath all of it, on every connection you have ever opened, the same two moves repeat — climb by a constant, cut by a fraction — quietly proving, at 45° on a plane two researchers drew in 1989, that strangers who cannot see each other can still share a pipe fairly.',
  },
  next: { slug: 'tail-latency', title: 'Tail Latency' },
}
