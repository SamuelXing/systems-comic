import type { TraceSpec } from '../../components/TracePlayer'
import { VIZ } from '../../styles/viz'

/* The proof, run as a machine. Three processes on the left, and on the right
   the only thing that actually changes: which decisions are still reachable.

   Colour, and it is doing real work here. The processes are blue because they
   are ordinary and correct — nothing in this trace is faulty, which is the
   whole punchline. Amber usually marks machinery, and it marks the bookkeeping
   the schedule is maintaining: no machine holds that set, and painting one of
   the process boxes amber would hand a process the power the argument gives to
   the schedule. Green is a settled decision, which the protocol wants and never
   gets. Red appears once, on the step the schedule declines to take.

   Geometry: nodes stop at x=57 and the zone runs to 60, so the corridor at
   x=58.5 carries anything that would otherwise cut a process box on its way
   right. Every particle that skips a row uses it. */
const C = {
  proc: VIZ.blue,
  open: VIZ.amber,
  decided: VIZ.green,
  msg: VIZ.violet,
  lost: VIZ.red,
}

export const flpAdversaryTrace: TraceSpec = {
  title: 'A schedule that never lets the answer settle',
  aspect: 0.5,
  zones: [
    { label: 'Three processes', x: 2, y: 4, w: 58, h: 42 },
    { label: 'Still reachable', x: 64, y: 4, w: 33, h: 42 },
  ],
  nodes: [
    { id: 'p1', x: 5, y: 8, w: 52, h: 8, label: 'P1 · input 0', sub: 'correct, and slow', color: C.proc },
    { id: 'p2', x: 5, y: 19, w: 52, h: 8, label: 'P2 · input 1', sub: 'correct, and slow', color: C.proc },
    { id: 'p3', x: 5, y: 30, w: 52, h: 8, label: 'P3 · input 1', sub: 'correct, and slow', color: C.proc },
    { id: 'both', x: 67, y: 8, w: 27, h: 8, label: 'V = {0, 1}', sub: 'bivalent', color: C.open },
    { id: 'zero', x: 67, y: 19, w: 27, h: 8, label: 'V = {0}', sub: 'abort', color: C.decided },
    { id: 'one', x: 67, y: 30, w: 27, h: 8, label: 'V = {1}', sub: 'commit', color: C.decided },
  ],
  steps: [
    {
      title: 'Three machines, one bit each, and nothing broken',
      prose:
        'Every process starts holding a single bit and has to write an answer into a register it may write only once. The network is <b>reliable</b> — the paper is explicit that every message is delivered correctly and exactly once. Nobody lies, nothing is dropped, nothing is duplicated, and no cable is cut. <em>The only thing left unspecified in this model is when things happen</em>, and that is the entire attack surface.',
      focus: ['p1', 'p2', 'p3'],
      particles: [],
    },
    {
      title: 'Start somewhere the answer is not already fixed',
      prose:
        'Line the starting configurations up so that neighbours differ in exactly one process&rsquo;s input bit. If not one of them is open, then one end of that line must be committed to 0, the other to 1, and somewhere in between a committed-0 start sits beside a committed-1 start, differing in the bit of a single process p. <b>Now let p be the process that is allowed to stop.</b> Everyone else runs the identical schedule in both worlds and cannot tell them apart, so both runs decide the same value — and whichever it is, one of those two neighbours was open after all.',
      focus: ['p1', 'p2', 'p3', 'both'],
      particles: [
        { from: 'p1', to: 'both', color: C.msg },
        { from: 'p2', to: 'both', color: C.msg, via: [{ x: 58.5, y: 23 }, { x: 58.5, y: 12 }] },
        { from: 'p3', to: 'both', color: C.msg, via: [{ x: 58.5, y: 34 }, { x: 58.5, y: 12 }] },
      ],
    },
    {
      title: 'The scheduler has exactly one job',
      prose:
        'Keep the system in the top box. A run that terminates has to leave it, and it leaves on <b>one single step</b> — before that step both answers are live, after it one of them is gone forever. Nothing else in the protocol matters to this argument: not the message format, not the number of rounds, not how clever the leader election is. <em>Find a way to never take that step and the protocol never finishes.</em>',
      focus: ['both'],
      particles: [],
    },
    {
      title: 'But the message has to be delivered eventually',
      prose:
        'Here is why this is hard rather than trivial. The scheduler is allowed to be <b>slow and is not allowed to lie</b> — if some message to a live process never lands, the run is inadmissible and the theorem being proved would be about a broken network, which nobody needs a proof for. So the oldest message owed to P1 has to be applied sooner or later. And applying it may be the very step that settles everything.',
      focus: ['both', 'one'],
      particles: [{ from: 'p1', to: 'one', color: C.lost, via: [{ x: 58.5, y: 12 }, { x: 58.5, y: 34 }] }],
    },
    {
      title: 'So walk the system somewhere else first, then deliver it',
      prose:
        'Let the other two processes take steps while that message waits. Among everything reachable without applying it, there is a configuration where applying it leaves the outcome open — that is the paper&rsquo;s third lemma, and it turns on <b>steps by different processes commuting</b>. If the message were fatal from everywhere, you could find two configurations one step apart whose successors disagree, and then either the two disjoint steps commute into a contradiction, or a deciding run that leaves p alone arrives at a configuration that is settled and unsettled at once.',
      focus: ['p1', 'p2', 'p3', 'both'],
      particles: [
        { from: 'p2', to: 'p3', color: C.msg },
        { from: 'p3', to: 'p2', color: C.msg },
        { from: 'p1', to: 'both', color: C.msg },
      ],
    },
    {
      title: 'Close the stage, rotate the queue, begin again',
      prose:
        'The bookkeeping that keeps this honest. Hold the processes in a queue and the pending messages in send order. A stage ends when the process at the head takes a step that receives its <b>oldest</b> waiting message, and then that process goes to the back. Over an infinite sequence of stages every process reaches the head infinitely often, and every message eventually becomes somebody&rsquo;s oldest. <em>So the run satisfies every fairness condition the model asks for.</em>',
      focus: ['p1', 'p2', 'p3'],
      particles: [
        { from: 'p1', to: 'p2', color: C.msg },
        { from: 'p2', to: 'p3', color: C.msg },
        { from: 'p3', to: 'p1', color: C.msg, via: [{ x: 58.5, y: 34 }, { x: 58.5, y: 12 }] },
      ],
    },
    {
      title: 'Forever — and now count the failures in it',
      prose:
        'Each stage begins open and ends open, so the run goes on forever and never decides. Now go back through it and count the crashes. <b>There are none.</b> A process is faulty in this model when it takes finitely many steps, and this construction hands every process infinitely many and delivers every message. The protocol was required to survive one stopped machine, the machine never stops, and <em>what breaks it is having had to be ready</em> — because being ready means the decision can never hang on any one process, and that is precisely the freedom the schedule needed.',
      focus: ['both'],
      particles: [],
    },
  ],
}
