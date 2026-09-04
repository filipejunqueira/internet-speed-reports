/**
 * The HTML the explorer page is built from. Every function here returns a string.
 *
 * Nothing in this file touches the document, fetches anything or imports anything, so it
 * runs under `node --test` without a browser. The page itself (app.js) puts these strings
 * into the document and wires the clicks; the class names below are the contract between
 * this file, the stylesheet and the click handling, so they are not decorative.
 *
 * Everything that came out of a measurement goes through esc() first. A run label is free
 * text the user typed on the command line, and the ISP, city and country come back from a
 * geolocation service, so none of it is trusted enough to put in the page as it stands.
 */

// Never measured and measured as zero are different answers, so the missing value gets a
// mark of its own rather than a 0 that reads like a real reading.
const DASH = '—'

// Which columns the picker table shows, in order, and which key of the summary row each
// one sorts by. The keys are the ones store.summary_row() writes into runs/index.json.
//
// The run column sorts on `label` and shows runName(row), which would part company on a
// run saved without a label: the cell would show the id while the sort saw nothing and
// parked the row at the bottom either way. app.js fills `label` in with runName(row) as it
// loads the index, so by the time a row reaches this table the two are the same string.
const PICKER_COLUMNS = [
  {key: 'label', head: 'run'},
  {key: 'timestamp', head: 'date (UTC)'},
  {key: 'isp', head: 'ISP'},
  {key: 'city', head: 'city'},
  {key: 'medium', head: 'medium'},
  {key: 'duration_s', head: 'duration', num: true},
  {key: 'download_mbps', head: 'down / up Mbit/s', num: true},
  {key: 'worst_loss_pct', head: 'worst loss %', num: true},
  {key: 'worst_burst_probes', head: 'worst burst', num: true},
  {key: 'sao_paulo_p95_ms', head: 'São Paulo p95 ms', num: true}
]

const TARGET_NAMES = {
  'router': 'router',
  'isp-hop': 'isp hop',
  'london': 'London',
  'madrid': 'Madrid',
  'us-east': 'US-East',
  'sao-paulo': 'São Paulo'
}

export function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A measured number for reading: thousands separated, fixed decimals, an em dash when
 * there is nothing to show. The locale is pinned to en-GB rather than the reader's own so
 * a published page reads the same everywhere and matches the Python-rendered run pages.
 */
export function fmt(value, nd = 1, unit = '') {
  if (value === null || value === undefined || value === '') return DASH
  const n = Number(value)
  if (!Number.isFinite(n)) return DASH
  const text = n.toLocaleString('en-GB', {minimumFractionDigits: nd, maximumFractionDigits: nd})
  return text + unit
}

export function runName(row) {
  return row.label || row.id
}

/** The name where the space is tight: a label if there is one, else a stub of the id. */
export function shortName(row) {
  return row.label || String(row.id).slice(0, 10)
}

/**
 * Bursts were only counted from 2026-09-03 onwards. A run published before that has no
 * figure at all, which must not be drawn as the 0 that a clean run earns.
 */
export function burstText(value) {
  return value === null || value === undefined ? DASH : String(value)
}

/**
 * The colour chip that stands for a run wherever its name appears.
 *
 * The colour is written inline, so the stylesheet cannot reach it: data-slot is here so that
 * app.js can swap these chips to tokens.runSlots.dark when the theme flips. It has to do
 * that itself — the report pages' theme script only restyles plotly divs, and nothing else
 * yet reads data-slot.
 */
export function swatch(slot, tokens) {
  const known = slot !== null && slot !== undefined
  const colour = known ? tokens.runSlots.light[slot] : 'transparent'
  return `<span class="sw" data-slot="${known ? slot : ''}" ` +
    `style="background:${esc(colour)}"></span>`
}

export function pickerTable(rows, state, tokens) {
  const sort = state.sort || {}
  // The chips are dropped when exactly one run is ticked. The three run colours are the
  // London, Madrid and US-East hues borrowed back, which is only safe while the two views
  // are never on screen together — and with one run ticked the report below the table is
  // that run's own page, drawing those three targets in those very colours. A chip has
  // nothing to say at that point either: there is no second run to tell it apart from.
  // The chip still occupies its space at one tick, drawn transparent: dropping the
  // element outright shifted the whole name column sideways on the first tick and back
  // on the second.
  const chips = ((state && state.selected) || []).length !== 1
  const heads = PICKER_COLUMNS.map((col) => {
    const sorted = col.key === sort.key
    const classes = [col.num ? 'num' : '', sorted ? 'sorted' : ''].filter(Boolean).join(' ')
    const marker = sorted ? `<span class="arr">${sort.dir === 'asc' ? '▴' : '▾'}</span>` : ''
    return `<th data-sort="${esc(col.key)}"${classes ? ` class="${classes}"` : ''}>` +
      `${esc(col.head)}${marker}</th>`
  }).join('')
  const body = rows.map((row) => pickerRow(row, state, tokens, chips)).join('')
  return '<table class="picker"><thead><tr><th class="tickcol"></th>' + heads +
    `</tr></thead><tbody>${body}</tbody></table>` +
    '<p class="hint">Tick one run to read its full report. Tick two or three to compare them: ' +
    'each keeps its colour on every chart and on the map.</p>'
}

function pickerRow(row, state, tokens, chips) {
  const slot = slotFor(state, row.id)
  const ticked = slot !== null
  const cells = [
    `<td class="run">${swatch(chips ? slot : null, tokens)}${esc(runName(row))}</td>`,
    `<td>${dateText(row.timestamp)}</td>`,
    `<td>${orDash(row.isp)}</td>`,
    `<td>${orDash(row.city)}</td>`,
    `<td>${orDash(row.medium)}</td>`,
    `<td class="num">${fmt(row.duration_s, 0, ' s')}</td>`,
    `<td class="num">${fmt(row.download_mbps)} / ${fmt(row.upload_mbps)}</td>`,
    `<td class="num">${fmt(row.worst_loss_pct)}</td>`,
    `<td class="num">${burstText(row.worst_burst_probes)}</td>`,
    `<td class="num">${fmt(row.sao_paulo_p95_ms, 0)}</td>`
  ].join('')
  return `<tr data-id="${esc(row.id)}"${ticked ? ' class="on"' : ''}>` +
    `<td class="tickcol"><span class="tick${ticked ? ' on' : ''}"></span></td>${cells}</tr>`
}

/**
 * One tile per ticked run: what the run was, how fast the line was, and how many probes
 * went missing. These tiles are the legend for every chart below them, which is why the
 * colour chip sits next to the name rather than in a legend of its own.
 */
export function runTiles(runs, state, tokens) {
  return `<div class="runs">${runs.map((run, i) => runTile(run, state, tokens, i)).join('')}</div>`
}

function runTile(run, state, tokens, index) {
  const pub = (run.snapshot && run.snapshot.public) || {}
  const speed = {}
  for (const leg of run.speed || []) speed[leg.direction] = leg.mbps
  const loss = lostProbes(run)
  const status = lossStatus(loss.lost, loss.worstPct, tokens.thresholds || {})
  const where = [
    dateText(run.timestamp),
    orDash(pub.isp),
    orDash(pub.city),
    orDash((run.snapshot || {}).medium),
    fmt(run.duration_s, 0, ' s')
  ].join(' · ')
  return `<div class="run" data-id="${esc(run.id)}">` +
    `<div class="name">${swatch(slotOfRun(run, state, index), tokens)}` +
    `${esc(runName(run))}</div>` +
    `<div class="sub">${where}</div>` +
    `<div class="speed">${fmt(speed.download)} / ${fmt(speed.upload)} ` +
    '<small>Mbit/s down / up</small></div>' +
    `<div class="loss">${fmt(loss.lost, 0)} <small>probes lost</small>${badge(status)}</div>` +
    '</div>'
}

/**
 * The comparison table, from the rows stats.diffRows() worked out. The winning cell is
 * marked here rather than there so the arithmetic module never has to know about markup.
 */
export function diffTable(rows, runs, target, tokens) {
  const heads = runs.map((run, i) =>
    `<th class="num">${swatch(slotOfRun(run, null, i), tokens)}` +
    `${esc(shortName(run))}</th>`).join('')
  const body = rows.map((row) => {
    const cells = row.values.map((value, i) => {
      const best = row.bestIndex !== null && row.bestIndex !== undefined && i === row.bestIndex
      return `<td class="num${best ? ' best' : ''}">${fmt(value, row.nd)}</td>`
    }).join('')
    return `<tr><th>${esc(row.label)}</th>${cells}</tr>`
  }).join('')
  return `<table class="diff"><thead><tr><th>${esc(prettyTarget(target))}</th>${heads}</tr>` +
    `</thead><tbody>${body}</tbody></table>`
}

/**
 * Every hop the map draws, written out under it, one table per run.
 *
 * On the map itself the delay, the address and the count of hops that stayed quiet are
 * only there while a pointer hovers over the point. A tooltip is an extra here, never the
 * only way to read a number, which is why each run's own report page carries the same
 * table under its route map. Collapsed, because the picture answers the usual question.
 *
 * `entries` is what map.hopRows() returns: one entry per run that has a route to draw for
 * this target, in slot order, each carrying the drawn points with the origin dropped.
 */
export function hopTable(entries, tokens) {
  if (!entries || !entries.length) return ''
  const tables = entries.map((entry) =>
    '<table class="stats hops">' +
    `<thead><tr><th colspan="5">${swatch(entry.slot, tokens)}${esc(entry.label)}</th></tr>` +
    '<tr><th>#</th><th>address</th><th>placed</th><th>reached in ms</th>' +
    `<th>added ms</th></tr></thead><tbody>${(entry.points || []).map(hopRow).join('')}` +
    '</tbody></table>').join('')
  return '<details><summary>every hop, and where the time goes</summary>' + tables +
    '</details>'
}

function hopRow(point) {
  return quietHops(point.hiddenBefore) +
    `<tr><th>${esc(point.n)}</th><td>${orDash(point.ip)}</td>` +
    `<td>${orDash(point.city)}</td><td>${fmt(point.ms)}</td>` +
    `<td>${stepText(point.step)}</td></tr>`
}

/** The hops between this point and the last one that never answered, if there were any. */
function quietHops(count) {
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return ''
  return `<tr class="quiet"><th colspan="5">${n} hop${n > 1 ? 's' : ''} did not answer` +
    '</th></tr>'
}

/**
 * What this hop added on top of the one before it, signed the way the run pages sign it.
 * A negative step is kept as it is: each hop figure is a single measurement, so it
 * wobbles, and a step below zero is that noise rather than a router giving time back —
 * the same reading render_map.hop_rows() puts on it.
 */
function stepText(step) {
  const n = Number(step)
  if (step === null || step === undefined || step === '' || !Number.isFinite(n)) return DASH
  return (n >= 0 ? '+' : '') + fmt(n)
}

/** The segmented control that says which single target everything below it is about. */
export function targetSelector(targets, selected) {
  const items = targets.map((name) => {
    const on = name === selected ? ' class="on"' : ''
    return `<span data-target="${esc(name)}"${on}>${esc(prettyTarget(name))}</span>`
  }).join('')
  return `<div class="filter">Drill into one target: <span class="seg">${items}</span></div>`
}

export function emptyCard() {
  return '<section class="card empty"><b>Nothing ticked yet</b>' +
    '<p>Tick one run above to read its full report here. Tick two or three to compare ' +
    'them: one colour per run, the same measurement on the same chart.</p></section>'
}

export function refusedNote(maxRuns) {
  return `<p class="refused">${maxRuns} runs at most: a fourth colour cannot be ` +
    'told apart on the map.</p>'
}

/**
 * A single ticked run is shown as the report page that was published for it, in a frame.
 * Nothing is redrawn, so this view can never drift from the page the reader already knows.
 */
export function detailFrame(id) {
  const href = `runs/${esc(id)}.html`
  return `<section class="card detail"><iframe class="frame" data-run="${esc(id)}" ` +
    `src="${href}" title="pingme report for ${esc(id)}"></iframe>` +
    `<p class="note"><a href="${href}" target="_blank" rel="noopener">` +
    'Open this report on its own</a></p></section>'
}

/**
 * One card with a heading over it.
 *
 * `headingId` is optional and lands on the heading itself. A card whose title names the
 * chosen target has to have that word rewritten when the reader picks a different one, and
 * an id is how app.js finds the heading without rebuilding the card around it — rebuilding
 * would throw away the plotly figure inside, which is the whole cost this avoids.
 */
export function chartCard(title, inner, headingId) {
  const id = headingId ? ` id="${esc(headingId)}"` : ''
  return `<section class="card"><h2${id}>${esc(title)}</h2>${inner}</section>`
}

export function prettyTarget(name) {
  return TARGET_NAMES[name] || name
}

// ---- private helpers -------------------------------------------------------------------

function orDash(value) {
  return value === null || value === undefined || value === '' ? DASH : esc(value)
}

/** The timestamp as the picker shows it: "2026-08-30 15:32", already UTC in the record. */
function dateText(timestamp) {
  if (!timestamp) return DASH
  return esc(String(timestamp).slice(0, 16).replace('T', ' '))
}

function slotFor(state, id) {
  const hit = ((state && state.selected) || []).find((s) => s.id === id)
  return hit ? hit.slot : null
}

/**
 * Which colour a run wears. The tick state knows it, but the comparison table is handed
 * the runs on their own, so a slot carried on the record comes next.
 *
 * The caller must attach that slot, the way map.js also expects it: the array position is
 * only the right answer while the slots run 0, 1, 2 with no gap. Untick the first of three
 * runs and the survivors still hold slots 1 and 2, so falling back to their new positions
 * would repaint them, which is the one thing the colours must never do.
 */
function slotOfRun(run, state, index) {
  const ticked = slotFor(state, run.id)
  if (ticked !== null) return ticked
  return Number.isFinite(run.slot) ? run.slot : index
}

/**
 * Whether a target never answered at all. This repeats stats.isSilent() because this file
 * imports nothing; the fallback is for runs saved before the record carried the flag.
 */
function isSilentEntry(entry) {
  if (!entry) return false
  if (entry.silent !== null && entry.silent !== undefined) return Boolean(entry.silent)
  const err = entry.error
  return (entry.samples || []).length === 0 &&
    (err === null || err === undefined || err === 'no replies')
}

/**
 * How many probes the run lost in total, and the worst loss any one target saw. A silent
 * address, like the ISP hop on BT, is left out of both: it is not answering by design, and
 * counting its every probe as lost would drown the real losses.
 */
function lostProbes(run) {
  const targets = ((run.analysis || {}).targets) || {}
  let lost = null
  let worstPct = null
  for (const entry of Object.values(targets)) {
    if (isSilentEntry(entry)) continue
    const all = entry.all || {}
    if (Number.isFinite(all.sent) && Number.isFinite(all.received)) {
      lost = (lost === null ? 0 : lost) + (all.sent - all.received)
    }
    if (Number.isFinite(all.loss_pct) && (worstPct === null || all.loss_pct > worstPct)) {
      worstPct = all.loss_pct
    }
  }
  return {lost, worstPct}
}

/**
 * The colour of the loss badge. Zero lost is the only green: one lost probe is still a
 * lost probe, so it earns a warning rather than a pass.
 */
function lossStatus(lost, lossPct, thresholds) {
  if (lost === null || lost === undefined || lossPct === null || lossPct === undefined) {
    return {kind: 'muted', mark: '?'}
  }
  if (lost === 0) return {kind: 'good', mark: '✓'}
  if (lossPct >= thresholds.lossCrit) return {kind: 'critical', mark: '✕'}
  if (lossPct >= thresholds.lossWarn) return {kind: 'serious', mark: '▲'}
  return {kind: 'warning', mark: '▲'}
}

/** A muted status has nothing to say, so it says nothing rather than showing a grey pill. */
function badge(status) {
  if (status.kind === 'muted') return ''
  return `<span class="badge ${status.kind}">${status.mark} ${status.kind}</span>`
}
