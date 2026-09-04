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
 *
 * What a click costs is decided in one place: state.whatChanged() says whether the ticked
 * runs moved, only the target moved, or nothing that shows moved at all. A target change
 * edits the comparison where it stands — a few headings, two tables, and the three figures
 * that follow the target handed to Plotly.react — because rebuilding the container would
 * throw seven live figures away and build seven more, which is what used to freeze the
 * page after a handful of clicks.
 */

import * as dom from './dom.js'
import {
  DEFAULT_TARGET, readState, selectedIds, slotOf, sortRows, toggleRun, whatChanged, writeState
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

// The parts of the comparison that name or list the chosen target, each with an id of its
// own so that picking another target can rewrite exactly those and leave every figure div
// where it is. Nothing else in the comparison is written from the target.
const HEAD_DIFF = 'head-diff'
const HEAD_HISTOGRAM = 'head-histogram'
const HEAD_TIMELINE = 'head-timeline'
const HEAD_MAP = 'head-map'
const BOX_DIFF = 'box-diff'
const BOX_HOPS = 'box-hops'
const MAP_NOTE = 'map-note'

// Everything the page knows, kept in module variables because there is exactly one page.
let tokens = null
let indexRows = []
let state = null
// Every render takes a number. A fetch that finishes after a later tick has already
// started rendering must not overwrite it, so it checks its number before writing.
let renderSeq = 0
// The state the page below the picker was actually drawn from, so the next click can be
// told what changed. Written only by a render that reached the end without being
// overtaken, because it has to describe what is on screen rather than what was asked for.
let rendered = null
// The comparison currently on screen: the ticked runs with their slots attached, the
// targets they have between them, and the one target the drill-down is showing. Null
// whenever the body holds anything else — nothing ticked, one run, or the failure
// sentence — because those three views never name a target.
let drawn = null
// The plotly config every figure is drawn with, built in boot() once the tokens block is
// in hand. Until then it is the constant above.
let plotlyConfig = PLOTLY_CONFIG
// Fetched run records, so re-ticking a run, or switching target, costs nothing.
const cache = new Map()

// ---- reading what the page was given -----------------------------------------------------

function mainEl() {
  return document.querySelector('main')
}

/**
 * Put new HTML into a container, taking any live figures inside it apart first.
 *
 * Plotly keeps its own state for every div it has drawn into and hangs a window resize
 * listener off it, and none of that goes away when the element is dropped: overwriting the
 * innerHTML of a container that holds figures leaks all of it, and the leak is per figure
 * per click. That is why the page used to degrade into a freeze rather than merely being
 * slow — the first click was survivable, the sixth was not. Every place on this page that
 * replaces the contents of a container goes through here, including the ones that put the
 * empty card, the single-run frame or a failure sentence on screen, because each of those
 * may be replacing a comparison with seven figures in it.
 */
function replaceHtml(container, html) {
  if (!container) return
  purgeFigures(container)
  container.innerHTML = html
}

/**
 * Hand every plotly figure inside this element back to plotly.
 *
 * A div plotly has drawn into carries the class js-plotly-plot; the _fullLayout check is
 * the second half of the same question, because that property is what plotly puts on a div
 * it is actually holding state for. Purging a div that was never drawn into does nothing,
 * so the check only saves the call, but it also keeps this honest about what it is asking.
 */
function purgeFigures(container) {
  if (!container || typeof Plotly === 'undefined' || !Plotly.purge) return
  container.querySelectorAll('.js-plotly-plot').forEach((div) => {
    if (div._fullLayout) Plotly.purge(div)
  })
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
  replaceHtml(document.getElementById('pick'), dom.pickerTable(rows, state, tokens) + note)
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
 * Draw whatever the last click actually changed, and nothing else.
 *
 * Three answers, from state.whatChanged(): the ticked runs moved and the page below the
 * picker is built again; only the target moved and the comparison already on screen is
 * edited in place, which is the difference between a click that costs a few milliseconds
 * and one that tears down seven figures and builds them again; or nothing that shows
 * changed at all, and nothing is drawn.
 */
async function renderBody() {
  const change = whatChanged(rendered, state)
  if (change === 'none') return
  if (change === 'target') {
    // A target only shows in the comparison. With nothing ticked, or one run ticked, the
    // card and the frame below say nothing about it, so there is nothing to redraw.
    if (drawn) return retarget()
    rendered = state
    return
  }
  return rebuildBody()
}

/**
 * Nothing ticked, one ticked or several: the three views, and the fetch in between.
 *
 * The previous view stays on screen, dimmed by the `loading` class, until the numbers for
 * the newly ticked run have arrived. Nothing here ever empties the page first.
 */
async function rebuildBody() {
  const seq = ++renderSeq
  // Claimed before the first await, not after the last one. These two lines describe what
  // the newest render is drawing, not what finished drawing: with them at the end, a click
  // back to the previous target while a redraw was in flight read as "nothing changed" and
  // was dropped, and the render already running then committed over it. The page ended up
  // showing one target while the address bar named another, and the next click did nothing.
  rendered = state
  const ids = selectedIds(state)
  const body = document.getElementById('body')

  if (ids.length === 0) {
    setLoading(false)
    replaceHtml(body, dom.emptyCard())
    drawn = null
    rendered = state
    return
  }
  if (ids.length === 1) {
    setLoading(false)
    renderDetail(body, ids[0])
    drawn = null
    rendered = state
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
  const context = await renderComparison(body, runs, failed)
  // Drawing the figures is another wait, so the check is worth repeating: only a render
  // that got this far without being overtaken may say what is on screen.
  if (seq !== renderSeq) return
  drawn = context
  rendered = state
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
  replaceHtml(body, dom.detailFrame(id))
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
 *
 * Returns what it drew — the runs with their slots, the targets they have between them and
 * the target the drill-down landed on — so that picking another target can work from it
 * without fetching or rebuilding anything. Nothing to draw returns null.
 */
async function renderComparison(body, runs, failed) {
  if (runs.length === 0) {
    replaceHtml(body, failedNote(failed))
    return null
  }
  const live = liveTargets(runs, tokens.targetOrder)
  const target = resolveTarget(live)
  const yRange = sharedYRange(runs, target)
  const named = dom.prettyTarget(target)

  replaceHtml(body, failedNote(failed) +
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
      // The table sits in a box of its own because a target change replaces the table
      // itself, so the id it is found by has to be on something that outlives it.
      `<div id="${BOX_DIFF}">` +
      dom.diffTable(diffRows(runs, target), runs, target, tokens) + '</div>', HEAD_DIFF) +
    dom.chartCard(`Where the round trips to ${named} fell`,
      figureDiv('fig-histogram') +
      '<p class="note">Counts of probes, so a longer run draws a taller outline. Compare ' +
      'the shapes and where they sit, not their heights.</p>', HEAD_HISTOGRAM) +
    dom.chartCard(`Round trip to ${named} through each run`,
      timelinePanels(runs) +
      '<p class="note">Side by side rather than one on top of the other: the runs are ' +
      'different lengths and their speed tests start at different seconds. The shaded bands ' +
      'are the download and the upload; the crosses along the floor are probes that never ' +
      'came back.</p>', HEAD_TIMELINE) +
    dom.chartCard(`The route to ${named}`,
      figureDiv('fig-map', MAP_HEIGHT_PX) +
      `<p class="note" id="${MAP_NOTE}">${mapNoteText(runs, target)}</p>` +
      // Empty when no ticked run has a route to this target, so the box has to be here
      // whether there is a table in it or not: a target change may put one back.
      `<div id="${BOX_HOPS}">${dom.hopTable(hopRows(runs, target), tokens)}</div>`, HEAD_MAP))

  const figures = [
    plot('fig-overview', overviewFigure(runs, tokens)),
    plot('fig-penalty', penaltyFigure(runs, tokens)),
    plot('fig-histogram', histogramFigure(runs, target, tokens)),
    plot('fig-map', mapFigure(runs, target, tokens))
  ]
  runs.forEach((run, i) => {
    figures.push(plot(timelineId(i), timelineFigure(run, run.slot, target, yRange, tokens)))
  })
  await Promise.all(figures)
  applyTheme() // the figures were built from the light tokens, so this is where dark lands
  return {runs, live, target}
}

/**
 * The reader picked a different target while a comparison is already on screen.
 *
 * Nothing about the runs has changed — state.whatChanged() only says "target" when the
 * ticked ids and their colour slots are identical — so the container is left exactly where
 * it is and only the parts that name or draw the target are touched: the four headings
 * that carry its name, the difference table, the map note, the hop tables and the pressed
 * segment of the selector, and then plotly is handed the new numbers for the histogram,
 * the map and each timeline panel. Because those figure divs are never discarded,
 * Plotly.react can diff against what is already drawn instead of building it again.
 *
 * The two overview charts are not touched at all. overviewFigure(runs, tokens) and
 * penaltyFigure(runs, tokens) take no target: they draw every target at once, from the
 * runs and the token order alone, so nothing in them can have changed.
 */
async function retarget() {
  const {runs, live} = drawn
  const target = resolveTarget(live)
  // Two states can ask for the same drawn target: a link naming São Paulo, opened against
  // runs that only reached the router, resolves back to the router either way.
  if (target === drawn.target) {
    rendered = state
    return
  }
  const seq = ++renderSeq
  rendered = state // claimed before the awaits, for the reason given in rebuildBody
  const named = dom.prettyTarget(target)
  setHeading(HEAD_DIFF, `Every figure for ${named}`)
  setHeading(HEAD_HISTOGRAM, `Where the round trips to ${named} fell`)
  setHeading(HEAD_TIMELINE, `Round trip to ${named} through each run`)
  setHeading(HEAD_MAP, `The route to ${named}`)
  setBox(BOX_DIFF, dom.diffTable(diffRows(runs, target), runs, target, tokens))
  setBox(MAP_NOTE, mapNoteText(runs, target))
  setBox(BOX_HOPS, dom.hopTable(hopRows(runs, target), tokens))
  pressSegment(target)

  const yRange = sharedYRange(runs, target)
  const figures = [
    plot('fig-histogram', histogramFigure(runs, target, tokens)),
    plot('fig-map', mapFigure(runs, target, tokens))
  ]
  runs.forEach((run, i) => {
    figures.push(plot(timelineId(i), timelineFigure(run, run.slot, target, yRange, tokens)))
  })
  await Promise.all(figures)
  // A second target click while these were drawing owns the page now.
  if (seq !== renderSeq) return
  drawn = {...drawn, target}
  // The redrawn figures come back in their light colours and the table and hop tables
  // carry fresh swatches, both of which this puts right in dark mode. Only the figures this
  // function redrew are named: the overview and the penalty were never touched and still
  // wear the colours the last full render gave them.
  applyTheme(['fig-histogram', 'fig-map', ...runs.map((_, i) => timelineId(i))])
}

/** The text of one card heading. Assigning textContent escapes the target name for us. */
function setHeading(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

/** Refill one box that holds no figures. Everything in `html` has already been escaped. */
function setBox(id, html) {
  const el = document.getElementById(id)
  if (el) el.innerHTML = html
}

/**
 * Move the pressed segment of the target selector.
 *
 * The segments themselves cannot change here — which targets are offered depends on the
 * runs, not on the one chosen — so this moves the "on" class rather than rewriting the
 * control, which keeps the markup identical to what dom.targetSelector() writes.
 */
function pressSegment(target) {
  document.querySelectorAll('.seg [data-target]').forEach((segment) => {
    segment.classList.toggle('on', segment.dataset.target === target)
  })
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

/**
 * What the map leaves out: a run measured without `--web` or `--publish` has no route.
 *
 * The sentence only, without the paragraph around it: the paragraph stays on the page
 * across a target change and has its contents replaced with this.
 */
function mapNoteText(runs, target) {
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
  return 'Each point is where a hop answered from, which is not the same as ' +
    'where the cable goes. A dashed leg jumps over hops that did not answer.' + omitted
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

/**
 * Draw one figure. Returns the promise so the caller can wait before restyling for dark.
 *
 * Plotly.react rather than Plotly.newPlot: same arguments, but it works out the difference
 * between what it is given and what is already in the div instead of taking the figure
 * apart and building it again. On a div that has never been drawn into there is no
 * difference between the two, so this is safe as the only call the page makes.
 */
function plot(id, figure) {
  const div = document.getElementById(id)
  if (!div || !figure) return Promise.resolve()
  return Plotly.react(div, figure.data, figure.layout, plotlyConfig)
}

/**
 * The plotly config, with the map's topology file added when the site carries its own.
 *
 * publish() vendors plotly's world map into the site's assets and writes the folder into
 * the tokens block as topojsonUrl; plotly joins that straight onto the file name, so the
 * string is passed exactly as Python wrote it, trailing slash and all. When the key is
 * absent or null the option is left out altogether and plotly fetches the map from its own
 * CDN, which is what the page did before the file was vendored.
 */
function configFor(loaded) {
  const url = loaded && typeof loaded.topojsonUrl === 'string' ? loaded.topojsonUrl : ''
  return url ? {...PLOTLY_CONFIG, topojsonURL: url} : PLOTLY_CONFIG
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
function applyTheme(ids) {
  const dark = isDark()
  const roles = themeRoles(tokens, dark)
  const chrome = tokens.chrome[dark ? 'dark' : 'light']
  // js-plotly-plot is the class plotly.js sets on a div it has drawn into. The report pages
  // carry plotly-graph-div as well, but that one is written by plotly's Python HTML writer,
  // not by the library, so looking for it here found nothing at all and every figure on this
  // page kept its light colours on a dark screen.
  const figures = ids
    ? ids.map((id) => document.getElementById(id)).filter(Boolean)
    : Array.from(document.querySelectorAll('.js-plotly-plot'))
  figures.forEach((div) => restyleFigure(div, roles, chrome, dark))
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
  // Through replaceHtml like everything else: this may be replacing a whole comparison,
  // and a page that has just failed is the last place to leak seven figures.
  replaceHtml(el, '<section class="card empty"><b>This page could not build itself</b>' +
    `<p>${dom.esc(error && error.message ? error.message : String(error))}</p>` +
    '<p>The runs themselves are fine: the list of them is at ' +
    '<a href="runs/index.json">runs/index.json</a>, and every run has its own page under ' +
    '<code>runs/</code>.</p></section>')
  drawn = null
  rendered = null
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
  plotlyConfig = configFor(tokens)
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
  replaceHtml(el, '<section class="card" id="pick"></section><div id="body"></div>')
  el.addEventListener('click', onClick)
  window.addEventListener('resize', onResize)
  // Wrapped, both of them: each would otherwise hand its own argument (an Event, a list of
  // mutations) to applyTheme, which reads its first argument as a list of figure ids.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme())
  new MutationObserver(() => applyTheme()).observe(document.documentElement,
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
