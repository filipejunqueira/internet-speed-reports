/**
 * The arithmetic behind the run explorer.
 *
 * Nothing in here draws, fetches or touches the page, so every function can be run and
 * checked under plain node. The shapes it reads are the ones the Python side publishes:
 * `runs/<id>.json` is a whole redacted run record, and `run.analysis.targets[<name>]` is
 * one address's figures inside it.
 *
 * The rules about missing figures are the important part. A target that never answers at
 * all (a router set to ignore probes) is not a target that lost every probe, and a run
 * saved before bursts were counted has no burst figure rather than a burst of zero. Both
 * come back as null here so that the page can draw an em dash instead of a number.
 */

// The errors a target can carry and still count as silent rather than broken. A run saved
// before the "silent" flag existed recorded the case as the error "no replies".
const SILENT_ERRORS = ['no replies']

// Room left above the top of the range, and below the best round trip, so neither end of a
// run is clipped off the chart.
const SLACK = 0.05

// Floating point puts a value that should sit exactly on a bin edge a hair either side of
// it, so the bin comparisons below allow this much slack: as a fraction of a bin when
// choosing the bin, and scaled to the axis when deciding what falls off the top.
const EDGE_SLACK = 1e-9

// One decimal, because that is what the run page prints under the same heading. The same
// run must not read 20.0 % on its own page and 20.00 % in the table one click away.
const LOSS_DECIMALS = 1

/** Did this address ignore the probes altogether, rather than lose them? */
export function isSilent (entry) {
  if (!entry) return false
  if (entry.silent !== null && entry.silent !== undefined) return Boolean(entry.silent)
  // An older record only tells us that nothing came back and ping itself did not fail.
  const samples = entry.samples || []
  const error = entry.error
  const noError = error === null || error === undefined
  return samples.length === 0 && (noError || SILENT_ERRORS.includes(error))
}

/**
 * The longest run of probes lost back to back, or null when there is none to count.
 *
 * Null covers both a run saved before bursts were counted and an address that never
 * answered. Zero means it was counted and nothing was lost: the two must not look alike.
 */
export function burstProbes (entry) {
  if (!entry || isSilent(entry)) return null
  const loss = entry.loss
  if (loss === null || loss === undefined) return null
  return loss.longest_burst_probes || 0
}

/** How many probes went unanswered, or null for an address that answers nothing at all. */
export function lostCount (entry) {
  if (!entry || isSilent(entry)) return null
  const all = entry.all || {}
  if (!isNumber(all.sent) || !isNumber(all.received)) return null
  return all.sent - all.received
}

/** How much slower the line got while the speed test ran: busy p95 minus idle p95, in ms. */
export function penalty (entry) {
  if (!entry || isSilent(entry)) return null
  const busy = (entry.busy || {}).p95_ms
  const idle = (entry.idle || {}).p95_ms
  if (!isNumber(busy) || !isNumber(idle)) return null
  const value = Math.round((busy - idle) * 10) / 10
  return value === 0 ? 0 : value // never hand back a negative zero to be formatted
}

/**
 * The targets worth drawing: present, and answering, in at least one of the ticked runs.
 *
 * `targetOrder` comes from the tokens block, so the charts and the selector agree with
 * the order the run pages already use.
 */
export function liveTargets (runs, targetOrder) {
  const seen = []
  for (const run of runs || []) {
    const targets = targetsOf(run)
    for (const name of Object.keys(targets)) {
      if (isSilent(targets[name])) continue
      if (!seen.includes(name)) seen.push(name)
    }
  }
  const order = targetOrder || []
  // A target the tokens block has not heard of still gets shown, at the end. Dropping a
  // real measurement because the order list is out of date would hide it with no warning.
  return order.filter((name) => seen.includes(name))
    .concat(seen.filter((name) => !order.includes(name)))
}

/**
 * One set of histogram bins covering every ticked run, so their outlines can be compared.
 *
 * Spans the smallest best round trip to the largest p99 plus headroom, in `n` bins — the
 * p99 on purpose, for the reason below. Null when not one of the runs has samples for this
 * target.
 */
export function sharedBins (runs, target, n = 30) {
  // p99 here, and only here: a histogram that stretched to the worst single probe would
  // squeeze every real outline into the first two bins. The samples above the top are
  // dropped on purpose, which `binCounts` says out loud.
  const span = msSpan(runs, target, 'p99_ms')
  if (!span || !(n > 0)) return null
  const lo = span.lo
  const hi = span.hi * (1 + SLACK)
  const edges = []
  for (let i = 0; i < n; i += 1) edges.push(lo + ((hi - lo) * i) / n)
  edges.push(hi) // exactly, rather than whatever the arithmetic above lands on
  return { lo, hi, edges }
}

/**
 * How many of this run's round trips fall in each of the shared bins.
 *
 * Bins are open at the bottom and closed at the top, so a sample sitting exactly on a
 * boundary is counted in the lower of the two bins; the first bin also takes a sample
 * exactly on `lo`, and the last one takes a sample exactly on `hi`. A sample above `hi`
 * belongs to no bin and is dropped, which is the only thing that is ever dropped.
 */
export function binCounts (run, target, bins) {
  const edges = (bins || {}).edges || []
  const n = Math.max(edges.length - 1, 0)
  const counts = new Array(n).fill(0)
  const entry = targetEntry(run, target)
  if (!entry || n === 0) return counts
  const lo = bins.lo
  const hi = bins.hi
  const width = (hi - lo) / n
  const tolerance = EDGE_SLACK * Math.max(1, Math.abs(hi))
  for (const sample of entry.samples || []) {
    const ms = sample[1]
    if (!isNumber(ms)) continue
    if (ms > hi + tolerance || ms < lo - tolerance) continue
    let index = width > 0 ? Math.ceil((ms - lo) / width - EDGE_SLACK) - 1 : 0
    if (index < 0) index = 0
    if (index > n - 1) index = n - 1
    counts[index] += 1
  }
  return counts
}

/**
 * One vertical scale for the side-by-side timeline panels, so their heights mean the same.
 *
 * Covers every run's worst round trip with headroom, then rounds outwards to a step a
 * person reads at a glance. Null when no run has figures for this target.
 *
 * The worst round trip, not the p99: the page pins this range onto the panels, so anything
 * above it would be drawn nowhere at all. Against Sao Paulo the two Leeds runs in the log
 * reach a p99 of 453 ms and a worst probe of 565 ms, so a p99 range hid two of the 299
 * probes — and hid them only here, since that run's own report page autoscales and shows
 * them. Two views of one measurement, one click apart, must not disagree.
 */
export function sharedYRange (runs, target) {
  const span = msSpan(runs, target, 'max_ms')
  if (!span) return null
  const loRaw = span.lo * (1 - SLACK)
  const hiRaw = span.hi * (1 + SLACK)
  const step = niceStep(hiRaw - loRaw)
  const lo = Math.max(0, Math.floor(loRaw / step) * step)
  const hi = Math.ceil(hiRaw / step) * step
  return [tidy(lo), tidy(hi)]
}

/**
 * The comparison table: one row per figure, one value per ticked run.
 *
 * `bestIndex` is the run that did better on that row, or null when fewer than two runs
 * have the figure or they came out equal. Lower is better everywhere except the two
 * throughput rows, where the whole point is to get a bigger number.
 */
export function diffRows (runs, target) {
  const list = runs || []
  const entries = list.map((run) => targetEntry(run, target))
  // A silent address has no figures worth showing, so it contributes an empty row of them.
  const summaries = entries.map((entry) => (entry && !isSilent(entry) ? entry.all || {} : {}))
  const stat = (key) => summaries.map((summary) => numberOrNull(summary[key]))
  const rows = [
    { label: 'loss %', values: stat('loss_pct'), nd: LOSS_DECIMALS, lowerWins: true },
    { label: 'probes lost', values: entries.map((e) => lostCount(e)), nd: 0, lowerWins: true },
    { label: 'longest burst', values: entries.map((e) => burstProbes(e)), nd: 0, lowerWins: true },
    { label: 'best ms', values: stat('min_ms'), nd: 1, lowerWins: true },
    { label: 'median ms', values: stat('median_ms'), nd: 1, lowerWins: true },
    { label: 'p95 ms', values: stat('p95_ms'), nd: 1, lowerWins: true },
    { label: 'p99 ms', values: stat('p99_ms'), nd: 1, lowerWins: true },
    { label: 'jitter ms', values: stat('jitter_ms'), nd: 1, lowerWins: true },
    { label: 'under-load penalty ms', values: entries.map((e) => penalty(e)), nd: 1,
      lowerWins: true },
    { label: 'download Mbit/s', values: list.map((r) => speedMbps(r, 'download')), nd: 1,
      lowerWins: false },
    { label: 'upload Mbit/s', values: list.map((r) => speedMbps(r, 'upload')), nd: 1,
      lowerWins: false },
    { label: 'local overhead ms', values: list.map((r) => localOverhead(r)), nd: 1,
      lowerWins: true }
  ]
  return rows.map(({ label, values, nd, lowerWins }) => ({
    label, values, nd, bestIndex: bestIndex(values, lowerWins)
  }))
}

function targetEntry (run, target) {
  return targetsOf(run)[target] || null
}

function targetsOf (run) {
  return (((run || {}).analysis || {}).targets) || {}
}

/**
 * The smallest best round trip and the largest `highKey` across the runs that measured this
 * address, or null when none of them did. Both the bins and the timeline scale start here,
 * and they ask for different tops: the bins want the p99, the timeline the worst probe.
 *
 * A record with no `highKey` figure is left out rather than fetched from another key. Every
 * record in the log carries max_ms wherever it carries p99_ms, and if one ever did not, a
 * null span leaves plotly to scale the panel itself, which shows everything.
 */
function msSpan (runs, target, highKey) {
  const lows = []
  const highs = []
  for (const run of runs || []) {
    const entry = targetEntry(run, target)
    if (!entry || isSilent(entry)) continue
    if ((entry.samples || []).length === 0) continue
    const all = entry.all || {}
    if (isNumber(all.min_ms)) lows.push(all.min_ms)
    if (isNumber(all[highKey])) highs.push(all[highKey])
  }
  if (lows.length === 0 || highs.length === 0) return null
  return { lo: Math.min(...lows), hi: Math.max(...highs) }
}

/** A gridline step of 1, 2 or 5 times a power of ten, giving roughly four steps across. */
function niceStep (span) {
  if (!(span > 0)) return 1
  const rough = span / 4
  const power = Math.pow(10, Math.floor(Math.log10(rough)))
  const base = rough / power
  const nice = base < 1.5 ? 1 : base < 3 ? 2 : base < 7 ? 5 : 10
  return nice * power
}

/** Trim the floating-point dust off a rounded axis bound, so 0.6 does not print as 0.6000…1. */
function tidy (value) {
  return Number(value.toPrecision(12))
}

function bestIndex (values, lowerWins) {
  const scored = values
    .map((value, index) => ({ value, index }))
    .filter((item) => item.value !== null && item.value !== undefined)
  if (scored.length < 2) return null
  const numbers = scored.map((item) => item.value)
  const best = lowerWins ? Math.min(...numbers) : Math.max(...numbers)
  const winners = scored.filter((item) => item.value === best)
  // Two runs that measured the same thing have no winner. Marking one of them would claim
  // a difference that the measurement does not support.
  return winners.length === 1 ? winners[0].index : null
}

function speedMbps (run, direction) {
  for (const leg of (run || {}).speed || []) {
    if (leg.direction === direction) return numberOrNull(leg.mbps)
  }
  return null
}

function localOverhead (run) {
  return numberOrNull(((run || {}).analysis || {}).local_overhead_ms)
}

function isNumber (value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberOrNull (value) {
  return isNumber(value) ? value : null
}
