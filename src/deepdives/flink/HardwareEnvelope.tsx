import { useState } from 'react'
import { fmt } from '../format'
import { LAD, LadderSlider } from '../ladder'

/* ============================================================
   TaskManager envelope: pick a machine, push a workload through
   it, see which resource binds.

   The thing this widget exists to show is the memory split. A
   TaskManager does not hand its RAM to your operators — Flink
   carves it up by documented fractions before user code sees any
   of it, and on a heap-state job the largest slice (managed
   memory, 0.4) goes almost entirely unused. People size these
   machines by total RAM and are then surprised by an OOM in a
   process that looks half empty.

   Every fraction below is a DOCUMENTED default, cited in the
   chapter's source note. The two per-record costs are ASSUMPTIONS
   and are sliders, because they are the numbers only your own
   job can answer.
   ============================================================ */

interface Shape {
  name: string
  cores: number
  ramGB: number
  slots: number
  nicGbps: number
  diskGB: number
  note: string
}

const SHAPES: Shape[] = [
  { name: 'Small', cores: 4, ramGB: 8, slots: 2, nicGbps: 1, diskGB: 100, note: '4 vCPU · 8 GB · 2 slots · SSD' },
  { name: 'Standard', cores: 8, ramGB: 32, slots: 4, nicGbps: 10, diskGB: 500, note: '8 vCPU · 32 GB · 4 slots · NVMe' },
  { name: 'State-heavy', cores: 16, ramGB: 64, slots: 8, nicGbps: 10, diskGB: 2000, note: '16 vCPU · 64 GB · 8 slots · NVMe' },
  { name: 'Large', cores: 32, ramGB: 128, slots: 16, nicGbps: 25, diskGB: 4000, note: '32 vCPU · 128 GB · 16 slots · NVMe stripe' },
]

/* Documented defaults — see taskmanager.memory.* in the configuration
   reference. These are the fractions Flink applies before your operators
   get anything. */
const MANAGED_FRAC = 0.4
const NETWORK_FRAC = 0.1
const NETWORK_MIN_MB = 64
const OVERHEAD_FRAC = 0.1
const OVERHEAD_MIN_MB = 192
const OVERHEAD_MAX_MB = 1024
const METASPACE_MB = 256

/** How long a record's bytes occupy a network buffer on the way out. An
 *  ASSUMPTION — it stands in for buffer residency, which real jobs vary
 *  wildly on, and the chapter labels it as such. */
const BUFFER_MS = 50

export default function FlinkHardwareEnvelope() {
  const [shapeIdx, setShapeIdx] = useState(1)
  const [rate, setRate] = useState(100_000)
  const [recB, setRecB] = useState(512)
  const [stateGB, setStateGB] = useState(20)
  const [shufflePct, setShufflePct] = useState(100)
  const [cpuUs, setCpuUs] = useState(10)
  const [rocks, setRocks] = useState(1)

  const sh = SHAPES[shapeIdx]
  const totalMB = sh.ramGB * 1024
  const onRocks = rocks === 1

  /* The split, in the order Flink applies it. */
  const metaspaceMB = METASPACE_MB
  const overheadMB = Math.min(OVERHEAD_MAX_MB, Math.max(OVERHEAD_MIN_MB, totalMB * OVERHEAD_FRAC))
  const networkMB = Math.max(NETWORK_MIN_MB, totalMB * NETWORK_FRAC)
  const managedMB = totalMB * MANAGED_FRAC
  const heapMB = Math.max(0, totalMB - metaspaceMB - overheadMB - networkMB - managedMB)

  /* Demand. State is per slot, so the machine carries slots × state. */
  const stateOnBoxGB = stateGB * sh.slots
  const cpuUsed = (rate * cpuUs) / 1e6
  const shuffleMBs = (rate * (shufflePct / 100) * recB * 2) / 1e6
  const netBufMB = shuffleMBs * (BUFFER_MS / 1000)
  const nicMBs = (sh.nicGbps * 1000) / 8

  /* RocksDB wants its block cache and write buffers out of managed memory;
     heap state wants the heap instead. One of these two meters is always
     the interesting one, and which depends on the backend. */
  const managedUsed = onRocks ? Math.min(stateOnBoxGB * 1024 * 0.1, managedMB * 4) : 0
  const heapUsed = onRocks ? 0.5 * sh.slots : stateOnBoxGB * 1024

  const rows = [
    { label: 'CPU', used: cpuUsed, cap: sh.cores, unit: 'cores', why: `${fmt.compact(rate)}/s × ${cpuUs} µs per record — the one meter a bigger box reliably fixes` },
    {
      label: onRocks ? 'Managed memory vs RocksDB working set' : 'Task heap vs on-heap state',
      used: onRocks ? managedUsed : heapUsed,
      cap: onRocks ? managedMB : heapMB,
      unit: 'MB',
      why: onRocks
        ? `block cache + write buffers for ${fmt.n1(stateOnBoxGB)} GB across ${sh.slots} slots, against the 0.4 managed fraction. Past this line every state access is a disk read.`
        : `HashMapStateBackend keeps state as objects on the heap, so ${fmt.n1(stateOnBoxGB)} GB of state needs ${fmt.n1(stateOnBoxGB)} GB of heap — and the heap is what is left after Flink's other fractions.`,
    },
    { label: 'Network memory vs buffers in flight', used: netBufMB, cap: networkMB, unit: 'MB', why: `${fmt.sig(shuffleMBs)} MB/s of shuffle held for ~${BUFFER_MS} ms, against the 0.1 network fraction (min 64 MB). Rises with parallelism, not just rate.` },
    { label: 'Local disk vs state', used: onRocks ? stateOnBoxGB : 0, cap: sh.diskGB, unit: 'GB', why: onRocks ? `RocksDB keeps working state in the TaskManager's local directories — this is a cache, and the checkpoint store is the home` : 'heap state touches no local disk — which is also why it cannot exceed RAM' },
    { label: 'NIC vs shuffle traffic', used: shuffleMBs, cap: nicMBs, unit: 'MB/s', why: `${shufflePct}% of records crossing an all-to-all exchange, counted in and out` },
  ]

  const worst = rows.reduce((a, b) => (b.used / b.cap > a.used / a.cap ? b : a), rows[0])
  const worstPct = (worst.used / worst.cap) * 100

  const verdict =
    worstPct >= 100
      ? {
          s: 'crit',
          t: `<b>${worst.label} is over capacity</b> (${Math.round(worstPct)}%). ${
            worst.label.startsWith('CPU')
              ? 'Per-record work exceeds the machine. This is the easy direction — more slots, more TaskManagers, higher parallelism, provided max parallelism has room.'
              : worst.label.startsWith('Managed')
                ? 'The RocksDB working set no longer fits its cache, so state access has become disk I/O. The symptom you will actually see is backpressure, which sends most people to the parallelism slider instead of this one. Raise the managed fraction, or put fewer slots on each box so each one gets more of it.'
                : worst.label.startsWith('Task heap')
                  ? 'On-heap state has outgrown the heap, and the next event is an OutOfMemoryError that takes the TaskManager with it. This is the wall that forces the move to RocksDB — not a preference, a ceiling.'
                  : worst.label.startsWith('Network')
                    ? 'Not enough network memory for the buffers this shuffle needs. Flink will throttle rather than crash, so this shows up as backpressure with no obvious cause. Raise the network fraction, or cut the shuffle.'
                    : worst.label.startsWith('Local disk')
                      ? 'RocksDB has filled the local disk. The job stops; the checkpoint store is fine but it is not where the working state lives.'
                      : 'Shuffle bytes are saturating the wire. A keyBy you do not need, or a record you could make smaller, is worth more here than a bigger NIC.'
          }`,
        }
      : worstPct >= 75
        ? {
            s: 'warn',
            t: `<b>${worst.label} binds first</b> at ${Math.round(worstPct)}%. Worth noting what this envelope does <em>not</em> say: none of these meters is the reason most Flink jobs fall over. That one is checkpoint duration under backpressure, and it does not appear on any hardware chart.`,
          }
        : {
            s: 'good',
            t: `<b>Comfortable.</b> Binding resource: ${worst.label} at ${Math.round(worstPct)}%. The number worth carrying away is the split on the right — of ${sh.ramGB} GB, your operators get <b>${fmt.n1(heapMB / 1024)} GB</b> of heap${onRocks ? '' : ', and that is the hard ceiling on your state'}.`,
          }

  return (
    <div className="hwv card" style={{ padding: 0 }}>
      <div className="sandbox">
        <div className="sb-controls">
          <p className="sb-title">TaskManager shape & workload</p>
          <div className="ctl">
            <div className="ctl-top"><span className="ctl-label">Instance shape</span></div>
            <div className="hw-shapes">
              {SHAPES.map((s, i) => (
                <button key={s.name} className={'hw-shape' + (i === shapeIdx ? ' on' : '')} onClick={() => setShapeIdx(i)}>
                  <b>{s.name}</b>
                  <span>{s.note}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="ctl">
            <div className="ctl-top"><span className="ctl-label">State backend</span></div>
            <div className="hw-shapes">
              {['HashMap (heap)', 'RocksDB (disk)'].map((s, i) => (
                <button key={s} className={'hw-shape' + (i === rocks ? ' on' : '')} onClick={() => setRocks(i)}>
                  <b>{s}</b>
                  <span>{i === 0 ? 'fast, bounded by RAM' : 'slower, bounded by disk'}</span>
                </button>
              ))}
            </div>
          </div>
          {[
            { label: 'Records into this TaskManager', val: rate, set: setRate, steps: LAD.rate, fmtV: (v: number) => fmt.compact(v) + '/s', hint: 'This machine’s share of the job, not the whole pipeline.' },
            { label: 'Average record size', val: recB, set: setRecB, steps: LAD.bytes, fmtV: (v: number) => fmt.bytes(v), hint: 'Drives shuffle bytes and network buffer pressure.' },
            { label: 'State per slot', val: stateGB, set: setStateGB, steps: LAD.gb, fmtV: (v: number) => fmt.int(v) + ' GB', hint: 'Each slot owns a slice of the keyed state.' },
            { label: 'Records crossing a shuffle', val: shufflePct, set: setShufflePct, steps: LAD.pct, fmtV: (v: number) => v + '%', hint: 'A keyBy is an all-to-all exchange; a chained operator is free.' },
            { label: 'CPU per record (assumed)', val: cpuUs, set: setCpuUs, steps: LAD.ms, fmtV: (v: number) => v + ' µs', hint: 'Your operator logic. The one number only your job can answer.' },
          ].map((c) => (
            <div className="ctl" key={c.label}>
              <div className="ctl-top">
                <span className="ctl-label">{c.label}</span>
                <span className="ctl-val">{c.fmtV(c.val)}</span>
              </div>
              <LadderSlider steps={c.steps} value={c.val} onChange={c.set} ariaLabel={c.label} />
              <div className="ctl-hint">{c.hint}</div>
            </div>
          ))}
        </div>
        <div className="sb-out">
          <p className="sb-title">Load vs {sh.name}</p>
          {rows.map((r) => {
            const pct = r.cap === 0 ? 0 : (r.used / r.cap) * 100
            const st = pct >= 100 ? 'crit' : pct >= 75 ? 'warn' : 'good'
            const f = (n: number) => (r.unit === 'cores' ? fmt.n1(n) : fmt.sig(n))
            return (
              <div className="meter" key={r.label}>
                <div className="meter-top">
                  <span className="meter-label">{r.label}</span>
                  <span className={`meter-num st-${st}`}>
                    {f(r.used)} / {f(r.cap)} {r.unit}
                  </span>
                </div>
                <div className="meter-bar">
                  <div className={`meter-fill fill-${st}`} style={{ width: Math.min(100, pct) + '%' }} />
                </div>
                <div className="meter-detail">{r.why}</div>
              </div>
            )
          })}
          <div className="meter">
            <div className="meter-top">
              <span className="meter-label">Where the {sh.ramGB} GB actually goes</span>
              <span className="meter-num">{fmt.n1(heapMB / 1024)} GB reaches your operators</span>
            </div>
            <div className="meter-detail">
              Managed <b>{fmt.n1(managedMB / 1024)} GB</b> (0.4) · network <b>{fmt.sig(networkMB)} MB</b> (0.1, min 64) · JVM overhead{' '}
              <b>{fmt.sig(overheadMB)} MB</b> (0.1, 192 MB–1 GB) · metaspace <b>{METASPACE_MB} MB</b> · heap{' '}
              <b>{fmt.n1(heapMB / 1024)} GB</b>. Every fraction here is a documented default. On a heap-state job the managed
              slice is the largest single allocation and goes almost entirely unused — which is why a half-empty-looking
              TaskManager can still die of an OOM.
            </div>
          </div>
          <div className={`verdict v-${verdict.s}`}>
            <span className="vi">{verdict.s === 'good' ? '✓' : verdict.s === 'warn' ? '▲' : '✕'}</span>
            <span dangerouslySetInnerHTML={{ __html: verdict.t }} />
          </div>
        </div>
      </div>
    </div>
  )
}
