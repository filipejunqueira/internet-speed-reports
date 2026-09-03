/**
 * The run explorer: the page itself.
 *
 * This is the only file on the site that touches the document, fetches anything or calls
 * Plotly. Everything it shows is built by the five modules beside it — state.js decides
 * what is ticked and in what colour, stats.js does the arithmetic, dom.js writes the HTML
 * and figures.js and map.js describe the charts — so the whole of this file is plumbing:
 * read the tokens Python wrote into the page, fetch the runs, put the strings in the
 * document, draw the figures, and keep the address bar in step.
 *
 * The shape of the page never changes: `<main>` holds one card with the picker table in
 * it and one container underneath for everything the ticks call for. Ticking a run
 * redraws the picker at once and only then goes looking for the numbers, so the tick feels
 * immediate and the charts already on screen stay put, dimmed, while the fetch is in
 * flight. A blank page tells the reader nothing, so nothing here is ever allowed to
 * produce one.
 */

import * as dom from './dom.js'
import {
  DEFAULT_TARGET, readState, selectedIds, slotOf, sortRows, toggleRun, writeState
} from './state.js'
import {diffRows, liveTargets, sharedYRange} from './stats.js'
import {
  histogramFigure, overviewFigure, penaltyFigure, themeRoles, timelineFigure
} from './figures.js'
import {hopRows, mapFigure, untracedRuns} from './map.js'

// The mode bar keeps zoom and pan, which are worth having on a route map and on a long
// timeline, and loses the two selection tools, which do nothing on any chart here.
const PLOTLY_CONFIG = {
  displaylogo: false,
  responsive: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d']
}

// Every chart but the map carries its own height in its layout — the overview charts work
// theirs out from how many targets and runs there are — and plotly honours that. The map
// does not, so it is the one figure whose height the page has to give it: plotly sizes a
// figure with no height of its own to its container.
const MAP_HEIGHT_PX = 500

// Everything the page knows, kept in module variables because there is exactly one page.
let tokens = null
let indexRows = []
let state = null
// Every render takes a number. A fetch that finishes after a later tick has already
// started rendering must not overwrite it, so it checks its number before writing.
let renderSeq = 0
// Fetched run records, so re-ticking a run, or switching target, costs nothing.
const cache = new Map()

// ---- reading what the page was given -----------------------------------------------------

function mainEl() {
  return document.querySelector('main')
}

/** The colours, target order and thresholds Python wrote into the page as a JSON block. */
function readTokens() {
  const block = document.getElementById('pingme-tokens')
  if (!block) throw new Error('the page is missing its pingme-tokens block')
  return JSON.parse(block.textContent)
}

/** The list of published runs, newest first, as store.summary_row() wrote them. */
async function loadIndex() {
  const response = await fetch('runs/index.json')
  if (!response.ok) throw new Error(`runs/index.json came back ${response.status}`)
  return response.json()
}

/** One run's whole record. Fetched once and kept: the 600 s runs are a few hundred KB. */
async function fetchRun(id) {
  if (cache.has(id)) return cache.get(id)
  const response = await fetch(`runs/${encodeURIComponent(id)}.json`)
  if (!response.ok) throw new Error(`runs/${id}.json came back ${response.status}`)
  const record = await response.json()
  cache.set(id, record)
  return record
}

// ---- the picker ---------------------------------------------------------------------------

/**
 * The table of every published run.
 *
 * `refused` is the fourth-tick case: the state is unchanged and the only new thing on the
 * page is the sentence saying why.
 */
function renderPicker(refused) {
  const rows = sortRows(indexRows, state.sort.key, state.sort.dir)
  const note = refused ? dom.refusedNote(tokens.maxRuns) : ''
  document.getElementById('pick').innerHTML = dom.pickerTable(rows, state, tokens) + note
  paintSwatches()
}

/** Clicks anywhere in the page: a header sorts, a row ticks, a segment picks the target. */
function onClick(event) {
  const head = event.target.closest('th[data-sort]')
  if (head) return sortBy(head.dataset.sort)
  const row = event.target.closest('tr[data-id]')
  if (row) return tickRun(row.dataset.id)
  const segment = event.target.closest('[data-target]')
  if (segment) return pickTarget(segment.dataset.target)
}

function sortBy(key) {
  // Clicking the column already sorted turns it round; a new column starts at descending,
  // which puts the newest date, the fastest line and the worst loss at the top.
  const dir = state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : 'desc'
  state = {...state, sort: {key, dir}}
  pushUrl()
  renderPicker(false)
}

function tickRun(id) {
  const result = toggleRun(state, id, tokens.maxRuns)
  if (result.refused) return renderPicker(true) // the state, the URL and the charts stand
  state = result.state
  pushUrl()
  renderPicker(false)
  renderBody().catch(reportFailure)
}

function pickTarget(target) {
  if (target === state.target) return
  state = {...state, target}
  pushUrl()
  renderBody().catch(reportFailure)
}

/** The address bar carries the whole state, so a comparison can be sent to somebody. */
function pushUrl() {
  history.replaceState(null, '', location.pathname + writeState(state))
}

// ---- what sits under the picker -----------------------------------------------------------

/**
 * Nothing ticked, one ticked or several: the three views, and the fetch in between.
 *
 * The previous view stays on screen, dimmed by the `loading` class, until the numbers for
 * the newly ticked run have arrived. Nothing here ever empties the page first.
 */
async function renderBody() {
  const seq = ++renderSeq
  const ids = selectedIds(state)
  const body = document.getElementById('body')

  if (ids.length === 0) {
    setLoading(false)
    body.innerHTML = dom.emptyCard()
    return
  }
  if (ids.length === 1) {
    setLoading(false)
    renderDetail(body, ids[0])
    return
  }

  // Only a run that has never been fetched is worth dimming the page for; a target change
  // or a re-tick is served from the cache and should not so much as flicker.
  setLoading(ids.some((id) => !cache.has(id)))
  const fetched = await Promise.all(ids.map((id) =>
    fetchRun(id).then((record) => ({id, record}), (error) => ({id, error}))))
  // A later tick has taken over: leave its render, and its dimming, alone.
  if (seq !== renderSeq) return
  setLoading(false)

  // A run whose numbers would not load is named in a sentence and left out of the charts.
  // The rest of the comparison is still worth drawing.
  const failed = fetched.filter((item) => item.error).map((item) => item.id)
  const runs = fetched.filter((item) => item.record)
    .map((item) => ({...item.record, slot: slotOf(state, item.id)}))
  await renderComparison(body, runs, failed)
}

/** Dim the page while the numbers for a newly ticked run are on their way, or stop. */
function setLoading(on) {
  const el = mainEl()
  if (!el) return
  el.classList.toggle('loading', on)
}

/**
 * One run ticked: the report page that was published for it, in a frame sized to its own
 * content so the reader never meets a scrollbar inside a scrollbar.
 */
function renderDetail(body, id) {
  body.innerHTML = dom.detailFrame(id)
  const frame = body.querySelector('iframe.frame')
  if (frame) frame.addEventListener('load', () => sizeFrame(frame))
}

/**
 * Set the frame's height from the height of the page inside it.
 *
 * The height is cleared before measuring: an iframe is at least as tall as its own box, so
 * measuring without clearing would let the frame grow and never shrink. Both pages come
 * from the same origin on GitHub Pages, so reading the inner document is allowed; opened
 * from a file:// path it is not, and the CSS min-height carries the page instead.
 */
function sizeFrame(frame) {
  try {
    frame.style.height = '0'
    const doc = frame.contentDocument
    frame.style.height = doc ? `${doc.documentElement.scrollHeight}px` : ''
  } catch (error) {
    frame.style.height = ''
  }
}

function onResize() {
  const frame = document.querySelector('iframe.frame')
  if (frame) sizeFrame(frame)
}

// ---- the comparison -----------------------------------------------------------------------

/**
 * Two or three runs, top to bottom: what they were, the two overview charts, then one
 * target's figures in a table, a histogram, a timeline panel per run and the route map.
 */
async function renderComparison(body, runs, failed) {
  if (runs.length === 0) {
    body.innerHTML = failedNote(failed)
    return
  }
  const live = liveTargets(runs, tokens.targetOrder)
  const target = resolveTarget(live)
  const yRange = sharedYRange(runs, target)
  const named = dom.prettyTarget(target)

  body.innerHTML = failedNote(failed) +
    dom.runTiles(runs, state, tokens) +
    '<div class="grid2">' +
    dom.chartCard('Typical round trip, every target',
      figureDiv('fig-overview') +
      '<p class="note">The bar is the median and the tick is the p95: half the probes came ' +
      'back faster than the bar, and one in twenty took longer than the tick.</p>') +
    dom.chartCard('Extra delay while the line is busy',
      figureDiv('fig-penalty') +
      '<p class="note">The p95 while the speed test ran, less the p95 on an idle line. It ' +
      'says what a big download costs everything else, not what an idle line feels like.</p>') +
    '</div>' +
    dom.targetSelector(live, target) +
    dom.chartCard(`Every figure for ${named}`,
      dom.diffTable(diffRows(runs, target), runs, target, tokens)) +
    dom.chartCard(`Where the round trips to ${named} fell`,
      figureDiv('fig-histogram') +
      '<p class="note">Counts of probes, so a longer run draws a taller outline. Compare ' +
      'the shapes and where they sit, not their heights.</p>') +
    dom.chartCard(`Round trip to ${named} through each run`,
      timelinePanels(runs) +
      '<p class="note">Side by side rather than one on top of the other: the runs are ' +
      'different lengths and their speed tests start at different seconds. The shaded bands ' +
      'are the download and the upload; the crosses along the floor are probes that never ' +
      'came back.</p>') +
    dom.chartCard(`The route to ${named}`,
      figureDiv('fig-map', MAP_HEIGHT_PX) + mapNote(runs, target) +
      dom.hopTable(hopRows(runs, target), tokens))

  const drawn = [
    plot('fig-overview', overviewFigure(runs, tokens)),
    plot('fig-penalty', penaltyFigure(runs, tokens)),
    plot('fig-histogram', histogramFigure(runs, target, tokens)),
    plot('fig-map', mapFigure(runs, target, tokens))
  ]
  runs.forEach((run, i) => {
    drawn.push(plot(timelineId(i), timelineFigure(run, run.slot, target, yRange, tokens)))
  })
  await Promise.all(drawn)
  applyTheme() // the figures were built from the light tokens, so this is where dark lands
}

/**
 * Which single target the drill-down is about.
 *
 * The state may name a target that none of the ticked runs measured, or one that never
 * answers in any of them — a shared link asking for São Paulo, opened against two runs
 * that only reached the router. Falling back to the first target that is actually there
 * keeps the tables and charts below full rather than empty.
 */
function resolveTarget(live) {
  if (live.includes(state.target)) return state.target
  return live[0] || DEFAULT_TARGET
}

/** A box for plotly to draw into. A height is only given where the figure has none. */
function figureDiv(id, height) {
  const style = height ? ` style="height:${height}px"` : ''
  return `<div id="${id}"${style}></div>`
}

function timelineId(index) {
  return `fig-timeline-${index}`
}

function timelinePanels(runs) {
  const panels = runs.map((run, i) =>
    '<div>' +
    `<p class="ctitle">${dom.swatch(run.slot, tokens)}${dom.esc(dom.runName(run))}</p>` +
    figureDiv(timelineId(i)) +
    '</div>').join('')
  return `<div class="grid2">${panels}</div>`
}

/** What the map leaves out: a run measured without `--web` or `--publish` has no route. */
function mapNote(runs, target) {
  const missing = untracedRuns(runs, target).map((run) => dom.esc(dom.runName(run)))
  // A run measured without --web or --publish carries no route in its saved record, even
  // when it was published later and its own page shows one: publishing traced the route
  // then but the record in the log never learned it. Say that, rather than claiming the
  // route was never traced, so the two pages do not appear to contradict each other.
  const omitted = missing.length
    ? ` No route is saved with ${missing.join(' or ')}, so ` +
      `${missing.length > 1 ? 'those runs are' : 'that run is'} not drawn here. ` +
      'Its own report page may still show one, traced when it was published.'
    : ''
  return '<p class="note">Each point is where a hop answered from, which is not the same as ' +
    'where the cable goes. A dashed leg jumps over hops that did not answer.' + omitted + '</p>'
}

function failedNote(failed) {
  if (!failed.length) return ''
  const names = failed.map((id) => dom.esc(nameOf(id))).join(' and ')
  const which = failed.length > 1
    ? 'those runs are missing from the charts below. Their own report pages still work.'
    : 'that run is missing from the charts below. Its own report page still works.'
  return `<section class="card"><p class="note">The numbers behind ${names} would not ` +
    `load, so ${which}</p></section>`
}

/** A run's name from the index row, so a run that failed to load can still be named. */
function nameOf(id) {
  const row = indexRows.find((item) => item.id === id)
  return row ? dom.runName(row) : id
}

/** Draw one figure. Returns the promise so the caller can wait before restyling for dark. */
function plot(id, figure) {
  const div = document.getElementById(id)
  if (!div || !figure) return Promise.resolve()
  return Plotly.newPlot(div, figure.data, figure.layout, PLOTLY_CONFIG)
}

// ---- light and dark -----------------------------------------------------------------------

function isDark() {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'dark') return true
  if (chosen === 'light') return false
  return matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Repaint everything the theme touches: every figure on the page, and every colour chip.
 *
 * The figures are built from the light tokens, so this runs at the end of every render as
 * well as on a theme change — a chart drawn while the page was already dark would
 * otherwise keep its light colours. The run pages do the same thing with the script
 * render_web._theme_js() appends to them; the explorer shell has no such script, so this
 * is the only place it happens here.
 */
function applyTheme() {
  const dark = isDark()
  const roles = themeRoles(tokens, dark)
  const chrome = tokens.chrome[dark ? 'dark' : 'light']
  document.querySelectorAll('.plotly-graph-div').forEach((div) =>
    restyleFigure(div, roles, chrome, dark))
  paintSwatches()
}

function restyleFigure(div, roles, chrome, dark) {
  if (!div.data) return
  div.data.forEach((trace, i) => {
    const role = trace.meta && trace.meta.role
    const colour = role ? roles[role] : null
    if (!colour) return
    const update = {}
    if (trace.marker) {
      update['marker.color'] = colour
      if (trace.marker.line) update['marker.line.color'] = colour
    }
    if (trace.line) update['line.color'] = colour
    // Text written on the marks stays chrome, never a run colour: the only labels that
    // take their trace's colour are the muted ones, which are chrome to begin with.
    if (trace.textfont) update['textfont.color'] = role === 'muted' ? colour : chrome.ink2
    Plotly.restyle(div, update, [i])
  })
  // The map's land and sea are not part of the token palette — they are the map's own
  // colours, the same pair the run pages swap. Sending them to a chart without a map costs
  // nothing: plotly simply files them under a geo subplot that is never drawn.
  Plotly.relayout(div, {
    'font.color': chrome.ink,
    'xaxis.gridcolor': chrome.grid, 'yaxis.gridcolor': chrome.grid,
    'xaxis.linecolor': chrome.axis, 'yaxis.linecolor': chrome.axis,
    'geo.bgcolor': 'rgba(0,0,0,0)',
    'geo.landcolor': dark ? '#2a2a28' : '#f2efe9',
    'geo.oceancolor': dark ? '#151a20' : '#dbe9f6',
    'geo.countrycolor': dark ? '#444' : '#bbb',
    'geo.coastlinecolor': dark ? '#555' : '#999'
  })
}

/**
 * The colour chips that tie a run's name to its marks. dom.js writes them with the light
 * colour inline and the slot in a data attribute precisely so this can swap them: an
 * inline style is out of the stylesheet's reach.
 */
function paintSwatches() {
  const palette = tokens.runSlots[isDark() ? 'dark' : 'light']
  document.querySelectorAll('.sw[data-slot]').forEach((chip) => {
    const slot = chip.dataset.slot
    if (slot === '') return // a chip with no run behind it is deliberately transparent
    chip.style.background = palette[Number(slot)] || palette[0]
  })
}

// ---- starting up --------------------------------------------------------------------------

/** The sentence a reader gets instead of a blank page, plus the detail in the console. */
function reportFailure(error) {
  console.error('pingme explorer:', error)
  const el = mainEl()
  if (!el) return
  el.classList.remove('loading')
  el.innerHTML = '<section class="card empty"><b>This page could not build itself</b>' +
    `<p>${dom.esc(error && error.message ? error.message : String(error))}</p>` +
    '<p>The runs themselves are fine: the list of them is at ' +
    '<a href="runs/index.json">runs/index.json</a>, and every run has its own page under ' +
    '<code>runs/</code>.</p></section>'
}

/** Keep at most one ticked run per colour the page was given, lowest slots first. */
function clampToPalette(state, maxRuns) {
  const cap = Number.isInteger(maxRuns) && maxRuns > 0 ? maxRuns : state.selected.length
  if (state.selected.length <= cap) return state
  const kept = [...state.selected].sort((a, b) => a.slot - b.slot).slice(0, cap)
  return {...state, selected: kept}
}

/**
 * Drop ticked runs that are not in the index.
 *
 * A link can outlive the run it names — an id typed wrong, or a report taken down — and a
 * missing run would otherwise reach the modules as an empty record or a 404 in the frame.
 */
function pruneMissing() {
  const known = new Set(indexRows.map((row) => row.id))
  const gone = selectedIds(state).filter((id) => !known.has(id))
  for (const id of gone) state = toggleRun(state, id, tokens.maxRuns).state
  if (gone.length) pushUrl()
}

async function boot() {
  tokens = readTokens()
  // readState caps a shared link at its own fallback, which it has to have because it is
  // read before this page has its tokens in hand. The number that actually matters is
  // tokens.maxRuns, one per colour Python published, so the link is cut back to that here.
  // Both are three today; a link written against a wider palette would otherwise ask for a
  // colour that does not exist. readState hands back slots packed from zero, so taking the
  // first few keeps every run on a slot it already held.
  state = clampToPalette(readState(location.search, DEFAULT_TARGET, tokens.maxRuns), tokens.maxRuns)
  // The run column sorts on `label` but shows runName(row), and a run saved without a
  // label has none: 2026-09-03T13-14-53Z in the log is one. Deriving the label once, here,
  // makes the string the table sorts on the same string it prints.
  indexRows = (await loadIndex()).map((row) => ({...row, label: dom.runName(row)}))
  pruneMissing()

  const el = mainEl()
  el.innerHTML = '<section class="card" id="pick"></section><div id="body"></div>'
  el.addEventListener('click', onClick)
  window.addEventListener('resize', onResize)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
  new MutationObserver(applyTheme).observe(document.documentElement,
    {attributes: true, attributeFilter: ['data-theme']})

  renderPicker(false)
  await renderBody()
}

boot().catch(reportFailure)

// ---- debugging a blank page ----------------------------------------------------------------
//
// Open the browser console (F12, then Console) and look for a line starting "pingme
// explorer:" — anything this page throws is logged there and also written into the page.
// If the page is blank with nothing logged, the script itself never ran, and these three
// checks in the console say which part is missing:
//
//   document.getElementById('pingme-tokens')      the JSON block Python writes; null means
//                                                 index.html is older than these modules
//   typeof Plotly                                 'undefined' means assets/plotly-7.0.0.min.js
//                                                 did not load
//   fetch('runs/index.json').then(r => r.status)  anything but 200 and the run list is missing
//
// The Network tab is the fourth check: app.js and its five siblings under assets/ must all
// come back 200 and be served as JavaScript. One module failing to load takes the whole
// import chain with it, silently, and that is what a truly blank page usually means.
