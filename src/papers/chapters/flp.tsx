import type { Chapter } from '../types'
import TracePlayer from '../../components/TracePlayer'
import DesignIt from '../DesignIt'
import { BivalentFrontierDiagram, FourExitsDiagram, InitialCliqueDiagram } from '../diagrams'
import { flpAdversaryTrace } from './flp-trace'

/* Opens Season 3, and it is the first chapter in the book whose subject is a
   proof rather than a system. The format has to survive that, which is most of
   why this chapter exists where it does.

   Two decisions worth writing down. The DesignIt walks the reader through the
   PROOF, not through a protocol — the constraints are the paper's model and
   the three decisions are its three moves, so "you are the designer" means you
   are the person trying to break every protocol at once. It works because the
   proof genuinely is a design: an adversary is a thing you build.

   And the chapter is deliberately not about consensus being hard. It is about
   the word "guarantee", which is the only word in the theorem that people drop
   when they repeat it. Chapters 8 and 9 already shipped working consensus;
   this one has to explain why those are not counterexamples without reading as
   a retraction of them. */

export const flp: Chapter = {
  slug: 'flp',
  act: 'Act I · The Floor Underneath',
  paperNo: 'Paper 31',
  title: 'The Proof That It Cannot Be Done',
  dek: 'Two seasons of systems that agree on things, and underneath them a nine-page paper saying no protocol can promise to. Both are true, and the gap between them is where every real system lives.',
  minutes: 17,
  paper: {
    title: 'Impossibility of Distributed Consensus with One Faulty Process',
    authors: 'Michael J. Fischer, Nancy A. Lynch, Michael S. Paterson',
    venue: 'Journal of the ACM 32(2), pp. 374–382',
    year: '1985',
    url: 'https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf',
  },
  caption:
    'ZooKeeper hands out an order. Spanner commits across three continents and goes home. The ring in Act II decides which shopping cart is the real one. Every one of those rests on machines settling a question while some of them are unreachable — and there is a paper from 1985, nine pages of it, that says this cannot be promised. Not *is expensive*. Not *needs a majority*. **No protocol at all, in that model, always finishes, once a single process is allowed to stop without saying so.** The systems in the first two seasons work anyway, most days, for years. Both of those sentences are true at the same time, and everything this act does is in the space between them.',
  steps: [
    {
      n: 'Step 01',
      title: 'One assumption does all the damage, and it is not the one you expect',
      accent: 'terra',
      rung: 'Rung 1 · The model',
      body: [
        'Read the list of what this paper *gives* you before the list of what it takes away, because the giving is what makes the result bite. The message system is reliable: it *“delivers all messages correctly and exactly once.”* Nothing is lost, nothing is duplicated, nothing is corrupted. No process lies or misbehaves — the authors set Byzantine failure aside by name. There is no network partition anywhere in the model. Every process runs a deterministic program.',
        'And the failure you have to survive is the mildest one anybody has ever written down: **one process stops.** Not a majority, not a minority, one — and the paper&rsquo;s own phrase for it is *“a single unannounced process death.”* It does not corrupt anything on the way out. It simply takes no further steps, and never says so.',
        'What is taken away is timing, and only timing. *“Crucial to our proof is that processing is completely asynchronous”* — no bound on how long a message sits in flight, no bound on how fast one process runs relative to another. The consequence the authors draw in the next breath is the one to hold on to: *“we assume that processes do not have access to synchronized clocks, so algorithms based on time-outs, for example, cannot be [used].”*',
        'So the adversary in this paper controls the clock and nothing else. It cannot drop your messages, corrupt them, forge them or cut a cable. It can only decide the order in which things happen. **That is the whole hand it is dealt, and it is enough** — which is why the result is not a statement about bad networks. It is a statement about what silence means when nothing bounds how long a message may take.',
      ],
      code: {
        file: 'is_p3_dead.txt',
        lines: [
          { t: 'p3 has not replied for 5 seconds' },
          { t: '' },
          { t: '# so p3 is dead? no —', hl: 'bad' },
          { t: '# nothing bounds message delay, so' },
          { t: '# "late" and "dead" are one observation' },
          { t: '' },
          { t: '# raise it to 60s, then? still no —', hl: 'bad' },
          { t: '# you are wrong less often, never right' },
          { t: '' },
          { t: '# and note what was NOT assumed:', hl: 'good' },
          { t: '# no losses, no corruption, no lying,' },
          { t: '# no partition. only "when".' },
        ],
      },
    },
    {
      n: 'Step 02',
      title: 'You are the designer',
      rung: 'Rung 2 · Design it yourself',
      span: 2,
      body: [
        'The problem on your desk in 1983 is the transaction commit problem, which is where this result was first presented. Several data managers have each done part of one transaction and every one of them has to reach the same verdict on whether it goes in. Your protocol must never let two of them disagree, and it must reach a verdict even if one machine falls over partway through.',
        'You are not going to write that protocol here. You are going to try to break every protocol that could be written — which is the same job seen from the other side, because a protocol no schedule can stall is a protocol that works.',
      ],
      diagram: (
        <DesignIt
          spec={{
            constraints: [
              '**The processes:** at least two, each deterministic, each starting with one bit, each writing its answer once into a register that cannot be rewritten',
              '**The network:** reliable — every message delivered correctly and exactly once, in whatever order the schedule likes',
              '**The timing:** unbounded. A message may take any finite time, a process may run at any speed, and there are **no clocks**, so a timeout is not something you can build',
              '**The failure to survive:** one process stops, whenever it chooses, without announcing it',
              '**What the protocol owes:** no two decisions disagree, *both* answers are reachable in principle, and **every run with at most one failure reaches a decision**',
            ],
            questions: [
              {
                q: 'A process has gone quiet. Your protocol has to keep going, because that process may be the one that stopped. What do you do?',
                options: [
                  {
                    label: 'Time it out and carry on without it',
                    verdict: 'dead',
                    why: 'There are no synchronised clocks in this model and no bound on delay, so no length of silence means anything. Raising the timeout does not fix that — it makes you wrong less often, which is a different property from being right. The paper closes this door on its second page rather than leaving it for a reader to find, and the reason it can be closed so early is that **a slow process and a stopped one produce the identical observation**: nothing.',
                  },
                  {
                    label: 'Wait to hear from every process before deciding',
                    verdict: 'dead',
                    why: 'Chapter 7&rsquo;s mutual-exclusion algorithm does exactly this, and the paper it comes from says outright that it needs every process participating, so one death stops everything. You have not survived the failure. You have converted a crash into a hang, which is worse in the way that matters here: the crash was allowed and the hang is the thing you were asked to prevent.',
                  },
                  {
                    label: 'Decide as soon as a majority has spoken',
                    verdict: 'dead',
                    why: 'This is what every working system does and it is not a mistake — it is just not an answer to this question. A majority still has to be a majority **at some moment**, and the schedule chooses which processes make up that moment and when it arrives. You have bought survival of the crash without buying arrival at the decision, and the distance between those two is the rest of this chapter.',
                  },
                  {
                    label: 'Accept that you cannot tell, and never let the decision depend on any named process',
                    verdict: 'move',
                    why: 'The only reading of the model that is honest. Silence carries no information, so if the outcome ever hangs on hearing from p specifically, then p stopping leaves you stuck — and you promised to survive exactly that. So the protocol must always have a way forward without p, for every p. **That is not a weakness in your design. It is the requirement, and it is also the lever**, because a protocol that can always proceed without any particular process is a protocol whose next step is never forced.',
                  },
                ],
              },
              {
                q: 'You want to show no protocol always finishes. Where does the run you are building start?',
                options: [
                  {
                    label: 'From the all-zeros inputs, where the answer is obviously 0',
                    verdict: 'dead',
                    why: 'That start has already made up its mind: every run from it decides 0, so there is nothing left for a schedule to influence and no stalling to do. A proof that begins there proves something about the easy case. You need a starting position where **the protocol&rsquo;s own inputs have not settled the answer**, and finding one is not free.',
                  },
                  {
                    label: 'Assume some start exists where the outcome is still open',
                    verdict: 'dead',
                    why: 'That is the thing to be proved and it is genuinely in doubt — nothing so far rules out a protocol every one of whose starting configurations is already committed one way or the other. If you assume it, the whole argument rests on an unexamined step, which for an impossibility result is fatal: you are claiming something about *every* protocol, and every protocol includes the awkward ones.',
                  },
                  {
                    label: 'Walk from all-zeros to all-ones one bit at a time and watch where the answer flips',
                    verdict: 'move',
                    why: 'Line the starting configurations up so neighbours differ in exactly one process&rsquo;s bit. If none of them is open, one end is committed to 0 and the other to 1, so somewhere along that line a committed-0 start sits next to a committed-1 start and they differ only in the input of one process p. **Now make p the one that stops.** Everyone else runs the same schedule in both worlds and cannot distinguish them, so both runs decide the same value — and whichever value that is, one of those two neighbours was open all along.',
                  },
                  {
                    label: 'Enumerate the schedules from every start and find the bad one',
                    verdict: 'dead',
                    why: 'There is nothing finite to enumerate. Processes have unbounded internal storage, messages have unbounded delay, and runs are infinite — so there is no search to run even for one fixed protocol, let alone for all of them at once. This is worth noticing rather than skipping: it is the reason the finished proof never names a protocol, and the reason it reads as an argument about configurations instead of about code.',
                  },
                ],
              },
              {
                q: 'You are sitting in an open configuration and there is a message you owe. Delivering it might settle the outcome for good. Now what?',
                options: [
                  {
                    label: 'Never deliver it',
                    verdict: 'dead',
                    why: 'Then the run is not admissible and you have proved something about an unreliable network, which needed no proof and would tell nobody anything. The message system here is reliable on purpose: **the adversary may be slow and may not lie.** Honouring that while still never deciding is the entire difficulty of the construction, and it is what makes the result about asynchrony rather than about failure.',
                  },
                  {
                    label: 'Stop the process the message is addressed to',
                    verdict: 'dead',
                    why: 'You have one stopped process to spend in the whole run, and spending it buys you one avoided message before you are back where you started with no budget left. It also aims at the wrong target — the requirement you are attacking is not that the protocol survives a crash, it is that it terminates. The finished proof makes the sharper point available: **you never need to spend the crash at all.**',
                  },
                  {
                    label: 'Deliver it to a different process instead',
                    verdict: 'dead',
                    why: 'Not a move the schedule has. An event in this model is a pair — a process, and a message taken from that process&rsquo;s own buffer — so there is no redirecting and no rewriting. The scheduler picks which of the pending events happens next and that is the whole of its power, which is worth remembering when the result starts to feel like cheating.',
                  },
                  {
                    label: 'Let the other processes run first, then deliver it, and check the outcome is still open',
                    verdict: 'move',
                    why: 'Take every configuration reachable from here *without* applying that event, and apply it to each one. At least one of those results is still open — the paper&rsquo;s third lemma, and it turns on steps by different processes commuting with each other. If the event settled the outcome from everywhere, you could line up two configurations one step apart whose successors disagree, and then either those two disjoint steps commute into a contradiction, or a deciding run that lets p alone arrives somewhere that is settled and unsettled at the same time. **So there is always another open configuration to move to, and the message still gets delivered.**',
                  },
                ],
              },
            ],
            reveal: {
              title: 'You built the run — now count the crashes in it',
              body: [
                'That is the theorem, and the construction fits in a paragraph. Begin at a starting configuration where the answer is open. Keep the processes in a queue and the pending messages in send order. At each stage, take the process at the head and the oldest message it is owed, walk the system to a configuration where delivering that message leaves the answer open, deliver it, and send the process to the back of the queue. Repeat forever. Every process reaches the head infinitely often; every message eventually becomes somebody&rsquo;s oldest. The run is admissible by every condition the model asks for, and no decision is ever reached.',
                'Now go back through that run and count the failures. **There are none.** A process is faulty here when it takes finitely many steps, and the construction hands every process infinitely many and delivers every message that was ever sent. The protocol had to be ready for one machine to stop. The machine never stops. *What breaks it is having had to be ready* — because readiness means the decision can never hang on any single process, and a decision that is never forced is a decision the schedule can keep postponing.',
                'And the honest scope, because it is what the next four chapters are about. The model has deterministic processes and no clock of any kind. Delete either of those and the theorem stops applying — not because someone found a cleverer algorithm, but because they are no longer solving this problem. **Everything that comes after this paper is an argument about which assumption to buy**, and the papers that buy well are the ones you are already running.',
              ],
            },
          }}
        />
      ),
    },
    {
      n: 'Step 03',
      title: 'The whole thing turns on one word',
      accent: 'denim',
      rung: 'Rung 3 · Bivalence',
      body: [
        'Take a snapshot of the system — every process&rsquo;s internal state, plus every message still in flight. Ask what decisions are still reachable from it. If both 0 and 1 are, the snapshot is **bivalent**; if only one value is left, it is committed to that value and no schedule can move it.',
        'A protocol that terminates has to get from bivalent to committed, and it does that on **one single step**. Before that step both futures exist. After it, one of them is gone. That step is the target of the entire proof — not the protocol&rsquo;s logic, not its message format, not how many rounds it runs, not how clever its leader election is. The argument attacks the existence of that step, by showing there is always somewhere else to be standing when it comes due.',
        'Two things bivalence does not mean, and both trip people up. It is not the processes disagreeing — every process is executing correctly, deterministically, exactly as written, and a bivalent configuration may have every process perfectly confident about what happens next. And it is not a state anybody can be in. **No process can observe bivalence.** It is a property of the whole configuration together with everything reachable from it, which is not a thing that exists inside any one machine.',
        'Which raises the objection worth answering before it settles in as a suspicion. The scheduler in this proof knows which configurations are bivalent, and no real scheduler could. That is fine, because **the adversary here is not a threat model.** It is a quantifier — the claim is that for every protocol there exists a run, and the run is exhibited by an argument rather than deployed by an attacker. Nobody is going to schedule your datacentre this way. What the theorem forbids is a *promise*, and it forbids it absolutely; what happens on an ordinary Tuesday is a different question, and the answer to that one is: usually fine.',
      ],
      diagram: <BivalentFrontierDiagram />,
      think: {
        q: 'If no process can see bivalence and no real network behaves like the adversary, what is a working engineer supposed to do with this result?',
        a: 'Use it to read claims. Any system that advertises *asynchronous, tolerates a crash, always reaches a decision* has an error in it somewhere, and you can stop reading and go looking for which of the three it actually gives up — the answer is in the paper it implements, and it is nearly always the third. **That is a real and frequently useful thing to be able to do**, and it costs nothing once you know the shape. The second use is on your own designs: the moment you write "and then we wait for the coordinator to confirm", you have made progress depend on a named process, and this result tells you what you owe the reader of that design — the timing assumption under which the wait ends. Not a guess about latency. The assumption. *The theorem does not forbid your system from working. It forbids you from claiming it always will without naming what you are assuming about the network.*',
      },
    },
    {
      n: 'Step 04',
      title: 'The schedule, run one stage at a time',
      accent: 'denim',
      rung: 'Rung 4 · The reveal',
      span: 2,
      body: [
        'Three processes, one bit each, and on the right the only thing in the picture that changes: which answers are still reachable. Nothing in this trace is faulty and no cable is cut.',
        'The step to sit with is the last one, and it is the fact almost nobody carries away from this paper. Every process took infinitely many steps. Every message arrived. Nothing crashed at all.',
      ],
      diagram: (
        <div className="gn-figure">
          <TracePlayer spec={flpAdversaryTrace} />
        </div>
      ),
    },
    {
      n: 'Step 05',
      title: 'Nobody beat it — they each deleted a line from it',
      accent: 'terra',
      rung: 'Rung 5 · The bill',
      body: [
        'Forty years of consensus research sits downstream of this paper, and not one result in it contradicts the theorem. Every escape works the same way: take the four assumptions the impossibility needs at once, and stop paying for one of them. The authors say as much in their own conclusion — the results *“point up the need for more refined models of distributed computing that better reflect realistic assumptions about processor and communication timings, and for less stringent requirements on the solution”* — and then, in a parenthesis, they name the exit somebody took the same year: *“termination might be required only with probability 1.”*',
        '**Randomisation** deletes determinism. Ben-Or&rsquo;s protocol, which appears in this paper&rsquo;s own reference list, has processes flip coins when they are stuck, and terminates with probability 1. That is a genuinely different guarantee from *terminates*: there is no round by which you are finished, only a probability that shrinks toward zero as you wait. You have traded a deadline for an expectation, which is a fine trade when you have no deadline.',
        '**Partial synchrony** deletes unbounded delay — not by assuming the network is fast, which would be a lie, but by assuming that bounds exist and eventually hold, without your having to know them in advance. Progress happens in the good stretches and stops in the bad ones, and safety holds throughout. This is the assumption almost everything you run is standing on, and it gets a chapter of its own next but one.',
        '**Failure detectors** delete the premise that silence is uninformative: assume an oracle that eventually stops suspecting live processes, and consensus becomes solvable. The honesty problem is what you build the oracle out of, because in practice it is a timeout — the thing the model forbade, readmitted under a better name and with its failure modes written down. That last part is the actual contribution, and it is not nothing.',
        'And the fourth, which is what most production systems really do: **keep safety unconditionally and stop promising termination.** Paxos never decides two values, in any run, under any schedule, ever. It may fail to decide at all, and its own literature says so plainly. Read the systems in Season 1 again with this in hand and you will find the same shape under every one of them — an absolute guarantee about correctness, and a conditional one about progress, with the condition hidden in a timeout constant that somebody tuned in 2014.',
      ],
      diagram: <FourExitsDiagram />,
    },
    {
      n: 'Step 06',
      title: 'Section 4 has a working protocol in it',
      rung: 'Rung 6 · The part nobody quotes',
      body: [
        'Everybody cites the impossibility. Almost nobody mentions that the same nine pages contain an algorithm that solves consensus, and its assumption is worth more than the algorithm is.',
        'The setting: some processes may be dead **before the protocol starts**, nobody knows which, and no process dies once it is running. A strict majority is alive at the outset. Under those conditions, here is what the processes do. Each broadcasts its own name and then listens until it has heard from L − 1 others, where L is ⌈(N + 1)/2⌉ — for five processes, three, which is also a strict majority, and the paper states the same number both ways. That gives every process a set of others it heard from directly, and those sets, taken together, form a directed graph.',
        'Then the second round. Each process broadcasts its name, its input value, and the list of processes it heard from in the first round, and waits until it has heard from every process it knows to be an ancestor of it in that graph — a list that grows as the messages arrive and teach it about ancestors it did not know it had. When it stops growing, each process computes which of its ancestors form an **initial clique**: a group with no edges coming in from anywhere outside. There is exactly one such group, its membership is at least L, and every process that finishes the second round knows precisely who is in it. Decide from the initial clique&rsquo;s input values by any agreed rule, and everyone decides the same thing.',
        'Now the interesting part, which is what the assumption is doing. **The only thing this protocol needs is that the set of live processes stops changing.** Not synchrony, not clocks, not a leader, not randomness — just that nobody dies partway through. Put beside the impossibility result on the facing page, it isolates the difficulty to a single point with unusual precision: consensus is not hard because processes fail. It is hard because a process may fail **while you are in the middle of talking to it**, and there is no moment at which you can be sure that window has closed.',
      ],
      diagram: <InitialCliqueDiagram />,
      deeper: {
        summary: 'Why “no process dies during execution” is a much bigger assumption than it sounds.',
        body: [
          'It sounds almost like a technicality — surely a crash is a crash, and it hardly matters when it lands. It matters completely. A process that was dead before you started is a process that never sends you anything, and after one round of waiting you have a stable picture of who exists. A process that dies in the middle has already sent some of its messages and not the rest, so different processes end the round holding different pictures, and **there is no round after which the pictures agree.**',
          'That is the same distinction the failure-detector literature spent the following decade formalising, and it is why the useful question about a real deployment is rarely "how often do machines fail". It is "how often does a machine fail *during* a coordination attempt", which is a completely different number and one that scales with how much coordinating you do.',
          'It is also a decent argument for the design move that Chapter 9 sells: push coordination into a small service that does it rarely, and let everything else read the result. You have not escaped anything — the small service still lives inside this theorem — but you have shrunk the window in which a badly-timed failure is expensive, and window size is the only thing anybody actually controls.',
        ],
      },
    },
    {
      n: 'Step 07',
      title: 'What it begat — and where it stands in 2026',
      rung: 'Rung 7 · Descendants',
      body: [
        '**The award for this kind of work went to Chapter 7 first and to this paper second.** PODC created an influential-paper prize in 2000 and gave it to *Time, Clocks*; the following year it went to Fischer, Lynch and Paterson; from 2003 it carries Dijkstra&rsquo;s name. Two papers from the bottom of the pile, recognised in the order the field ended up leaning on them. The other legacy is the vocabulary — bivalent, univalent, admissible run, the critical step are now simply how people talk about consensus, mostly with no idea where the words came from.',
        '**The direct descendants are the exits.** Ben-Or in 1983 for randomisation; Dwork, Lynch and Stockmeyer in 1988 for partial synchrony, which appears in this paper&rsquo;s references as a 1984 conference talk and is the next-but-one chapter; Chandra and Toueg in 1996 for failure detectors, and then the harder result about the weakest detector that suffices. Each is the same intellectual move — find the cheapest assumption that makes the problem go away — and the reason the sequence is worth reading in order is that the assumptions get progressively more honest about what a real network gives you.',
        '**Paxos answers this paper out loud**, and *Paxos Made Simple* is where you can watch it happen. Lamport declines to state a liveness requirement at all — *“we won&rsquo;t try to specify precise liveness requirements”* — then shows two proposers stepping on each other forever, then writes the sentence that ends the argument: *“The famous result of Fischer, Lynch, and Patterson implies that a reliable algorithm for electing a proposer must use either randomness or real time — for example, by using timeouts. However, safety is ensured regardless of the success or failure of the election.”* Two of the exits, named in one line, sixteen years later. Raft takes both at once, which is what randomised election timeouts are.',
        '**The blockchain literature rediscovered all of it**, sometimes the hard way. Nakamoto consensus does not evade this result; it takes the randomisation exit, at industrial scale, and its guarantee is probabilistic in exactly the sense the parenthesis in the conclusion described. Act II of this season reads the papers where the failure model changes from *stops* to *lies*, and the arithmetic underneath changes with it.',
        '**2026 status: load-bearing, and mostly misquoted.** The theorem is cited constantly and restated wrongly about as often, usually as "consensus is impossible in an asynchronous system", which drops the word that makes it true. What has aged best is not the impossibility but the method: state the model precisely enough that an impossibility is provable, and the model becomes the thing you negotiate over. **Every distributed system in production is a position in that negotiation**, and the position is nearly always the same one — never be wrong, and be quick about it when the network cooperates.',
      ],
    },
  ],
  bubbles: [
    {
      term: 'Configuration.',
      body: 'Every process’s internal state plus the messages sent and not yet delivered. The unit the whole proof reasons about — not a process’s view, the whole system at once.',
    },
    {
      term: 'Bivalent.',
      body: 'A configuration from which both 0 and 1 are still reachable. Nothing observes it; it is a property of the configuration and its whole future.',
    },
    {
      term: 'Admissible run.',
      body: 'At most one process faulty, and every message to a live process eventually delivered. The fairness the adversary has to honour, which is what makes the construction hard.',
    },
    {
      term: 'Faulty.',
      body: 'A process that takes finitely many steps in a run. Note what this makes “slow” — a process taking infinitely many steps very late is not faulty at all.',
    },
    {
      term: 'The critical step.',
      body: 'The single step where a run leaves bivalence behind and the answer becomes fixed. Every terminating run has exactly one, and the proof is a way of never arriving at it.',
    },
    {
      term: 'Window of vulnerability.',
      body: 'The paper’s own phrase for the interval in a commit protocol where one slow participant stalls everything. Its result is that every such protocol has one.',
    },
  ],
  inTheWild: {
    note: '5 places this shows up without being named',
    points: [
      '**Any design doc promising an election that always completes.** The claim is not merely optimistic, it is unavailable — what the system really has is an election that finishes whenever the network gives it a quiet enough window. The honest version of the sentence names the window: how long a stretch of well-behaved network the protocol needs, and how often the deployment supplies one.',
      '**The election timeout is where the theorem sends its invoice.** Set it too low and candidates keep interrupting each other and no term ever completes, which is the impossibility arriving as a pager alert rather than as a theorem. Randomised timeouts exist because symmetry between equal candidates is the exact thing determinism cannot break.',
      '**Health checks are failure detectors with a nicer name.** Every readiness probe is an unreliable oracle for a question the network cannot answer, and the useful design question is never how fast it fires — it is what the system does during the stretch when the oracle is wrong, because there will be one.',
      '**Two-phase commit&rsquo;s blocking case is the window, drawn.** A participant that has voted yes and lost the coordinator cannot unilaterally do anything, and no timeout resolves it correctly. Three-phase commit shortens the window by assuming timing; handing the decision to a consensus service moves it somewhere with a better uptime record. Neither closes it.',
      '**Almost every incident is the other half.** This result is about liveness, and liveness failures present as a stall — a queue that stops draining, a cluster with no leader, a deploy that hangs. The incidents that make the news are usually safety failures instead: somebody raised a timeout, or let a minority accept writes, and two answers were given to one question. **The theorem is not what goes wrong most; it is what makes the thing that goes wrong most look tempting.**',
    ],
  },
  tradeoffs: {
    title: 'what to do with an impossibility result',
    rows: [
      {
        choose: 'Read every termination claim as a question',
        when: 'somebody tells you their system always makes progress. Ask under which timing assumption. There is an answer, it is in the paper they implemented, and it is usually some version of *eventually the network delivers within a bound nobody has to know*.',
      },
      {
        choose: 'Split safety from liveness in your own spec',
        when: 'writing anything that has to agree on a value. Safety gets no conditions and holds in every run including the impossible one; liveness gets a condition attached and named. Systems that fuse the two into a single promise are the ones that quietly break the first half to keep the second.',
      },
      {
        choose: 'Buy randomness when the problem is symmetry',
        when: 'equal participants keep colliding — duelling candidates, retry storms, everybody backing off by the same amount. Determinism is what makes them collide identically, so the cheapest fix is to stop being deterministic, and it is the fix Raft takes.',
      },
      {
        choose: 'Shrink the window rather than trying to close it',
        when: 'you are designing around a coordination step at all. You cannot make a badly-timed failure impossible; you can make coordination rare, make the coordinating set small, and make the interval short. Every practical improvement since 1985 is one of those three wearing a different hat.',
      },
    ],
  },
  misconception: {
    think: '“FLP proves that consensus is impossible in a distributed system.”',
    actually:
      'It proves that no protocol **in one particular model** can *guarantee* it always terminates, and every part of that is load-bearing. **Guarantee** — the abstract&rsquo;s own wording is that every protocol *“has the possibility of nontermination”*, which is a claim about the worst schedule and not about the likely one. **Terminates** — safety is untouched; a protocol can be flawless about never deciding two different values and still be caught by this, and most good ones are. **That model** — deterministic processes, no clocks whatsoever, one process permitted to stop. Paxos, Raft, ZAB and every system in the first two seasons live comfortably inside the theorem rather than refuting it: they hold safety unconditionally and hang progress on a timing assumption. The version worth keeping is not that agreement is hard, because agreement is demonstrably achievable and you are using six systems that do it right now. **It is that "always terminates" is a claim about the network, and if nobody told you which claim, somebody made one on your behalf** — usually in a config file, usually in units of milliseconds, usually years ago.',
  },
  sources: [
    {
      year: '1985',
      title: 'Impossibility of Distributed Consensus with One Faulty Process — Fischer, Lynch & Paterson (JACM 32(2), 374–382)',
      url: 'https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf',
      note: 'Nine pages, and the first two of them are the ones that matter — §2 defines the model, and the model *is* the trick. §3 is the proof itself, three lemmas, and it is followable without any background beyond those two pages. Then read §4, which contains a working protocol and which most people who cite this paper have never opened. Read the abstract last and notice the word *possibility*.',
    },
    {
      year: '1988',
      title: 'Consensus in the Presence of Partial Synchrony — Dwork, Lynch & Stockmeyer (JACM 35(2), 288–323)',
      url: 'https://groups.csail.mit.edu/tds/papers/Lynch/jacm88.pdf',
      note: 'The exit almost every system you run has taken, and the next-but-one chapter. Two versions of the assumption: bounds exist but are unknown, or bounds are known but only hold after some unknown time. Both give you a model where consensus is solvable and where the honest statement of a guarantee has an *eventually* in it. The introduction alone is worth an evening.',
    },
    {
      year: '1996',
      title: 'Unreliable Failure Detectors for Reliable Distributed Systems — Chandra & Toueg (JACM 43(2), 225–267)',
      url: 'https://doi.org/10.1145/226643.226647',
      note: 'The third exit, and the one that changes how you think about health checks. Rather than assuming the network behaves, assume a module that is allowed to be wrong — permanently wrong about some processes, wrong for a while about others — and then work out exactly how wrong it may be while consensus remains solvable. Long, and the first thirty pages carry the idea.',
    },
    {
      year: '1983',
      title: 'Another Advantage of Free Choice: Completely Asynchronous Agreement Protocols — Michael Ben-Or (PODC ’83, 27–30)',
      url: 'https://doi.org/10.1145/800221.806707',
      note: 'Four pages, published the same year the impossibility was first presented, and it is in this paper’s own reference list. Processes that are stuck flip a coin. Termination with probability 1, which is not termination, and the gap between those two is the entire price. The cleanest possible demonstration that the theorem is a fence around a model rather than around a problem.',
    },
    {
      year: '2001',
      title: 'Paxos Made Simple — Leslie Lamport',
      url: 'https://lamport.azurewebsites.net/pubs/paxos-simple.pdf',
      note: 'Read it again after this chapter and one short section changes shape. §2.4, “Progress”, is two pages, it opens by declining to state a liveness requirement, and it ends by citing this paper and saying that electing a proposer needs randomness or real time. That is not an author being cautious. It is a protocol declaring which exit it took. Chapter 8 reads Paxos as an algorithm; this is reading it as a position in an argument.',
    },
  ],
  seenIn: [
    { label: 'What “Before” Even Means — Ch 7', to: '/papers/lamport', live: true },
    { label: 'Consensus, Twice Told — Ch 8', to: '/papers/consensus', live: true },
    { label: 'Consensus as a Service — Ch 9', to: '/papers/zookeeper', live: true },
    { label: 'Interlude: CAP', to: '/papers/cap', live: true },
    { label: 'Why it’s hard — the comic', to: '/ddia/read/distributed-troubles', live: true },
  ],
  finale: {
    title: 'A fence around a model, mistaken for a fence around the problem',
    body: 'The uncomfortable part is not that agreement is unreachable, because you are running several systems that reach it every second. It is that the thing standing between the impossibility and your working cluster is an assumption somebody made about the network, and in most organisations nobody can tell you what it was. That is what this act goes looking for: the floor the first two seasons were built on, which turns out to have a hole in it and a plank laid across the hole. Next, an algorithm this book has referred to twice and never contained — how to photograph a system that has no shared clock and cannot be asked to hold still.',
  },
  next: { title: 'A Photograph Nobody Posed For', unwritten: true },
}
