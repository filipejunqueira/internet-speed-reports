// The plotly specifications for the comparison view: what to draw, never how to draw it.
//
// Every function here returns a plain `{data, layout}` object. Nothing calls Plotly, touches
// the document or fetches anything, so node can check the specifications directly.
//
// The visual language is the one src/pingme/render_web.py already uses on a single run's
// page — the same margins, the same hairline grid, bars with a rounded data end, a 10 %
// wash under an outline. One thing changes, and it changes everything: on a run page a
// colour is a target, here a colour is a run. The target is chosen by the selector above
// the chart and named in the axis labels, so the three run slots are free to mean "the
// first run ticked, the second, the third".
//
// Two rules hold throughout. Every trace carries `meta: {role}`, because the page restyles
// by role when the theme changes and a trace without one would stay light-mode blue on a
// dark page. And no colour is written here as a literal: they all come out of the tokens
// block that render_web.explorer_tokens() puts in the page, so the palette lives in one
// place, in Python.

import { binCounts, isSilent, liveTargets, penalty, sharedBins } from './stats.js'

// One target's band on the overview charts: a fixed slice of breathing space plus room for
// each ticked run's bar. Everything about the bar geometry is derived from this, so the
// bars stay under the 14 px cap whether one run is ticked or three.
const BAND_BASE_PX = 18
const BAND_PER_RUN_PX = 16
const MAX_BAR_PX = 14
const BAR_GAP_PX = 2 // the gap of page colour between two runs' bars

// How much of a band the bars may fill. The rest is the gap between one target and the next.
const BAND_FILL = 0.7

// An area fill under a line is a wash, not a block: at a tenth of the line's colour two
// overlapping distributions can both still be read.
const WASH = 0.1

// The phase bands on a timeline are grey, and grey wants a little more presence than a
// coloured wash to register as a region at all.
const BAND_WASH = 0.12

// Enough bins to show the shape of a distribution without turning it into a comb.
const HIST_BINS = 30

/**
 * The colours for one theme, keyed by the role every trace carries.
 *
 * This is what lets the page follow a theme change without rebuilding a single figure: it
 * walks the traces, reads `meta.role`, and restyles from this map. `lost` is the same red
 * in both modes because it is a status colour, not part of the categorical palette.
 */
export function themeRoles(tokens, dark) {
  const slots = dark ? tokens.runSlots.dark : tokens.runSlots.light
  const chrome = dark ? tokens.chrome.dark : tokens.chrome.light
  const roles = { lost: tokens.status.critical, muted: chrome.muted }
  slots.forEach((hex, i) => { roles[`run${i}`] = hex })
  return roles
}

/**
 * Median round trip per target, one bar per ticked run, with each run's p95 as a tick.
 *
 * Targets run down the y axis in the order the tokens block gives, first at the top, and a
 * target that nobody could measure is left out rather than drawn as an empty band.
 */
export function overviewFigure(runs, tokens) {
  const figure = bandedBars(runs, tokens, {
    value: entry => statOf(entry, 'median_ms'),
    mark: entry => statOf(entry, 'p95_ms'),
    what: 'median',
    unit: 'ms',
    axisTitle: 'median round trip with p95 mark, ms'
  })
  return { data: figure.data, layout: figure.layout }
}

/**
 * How much slower each target got while the speed test ran, one bar per ticked run.
 *
 * The two vertical lines are pingme's own thresholds, drawn so a bar can be read against
 * them without looking anything up. They come from the tokens block, like the colours.
 */
export function penaltyFigure(runs, tokens) {
  const figure = bandedBars(runs, tokens, {
    value: entry => penalty(entry),
    mark: null,
    what: 'penalty',
    unit: 'ms',
    axisTitle: 'delay added while the line is busy, ms'
  })
  const chrome = tokens.chrome.light
  const thresholds = tokens.thresholds || {}
  const layout = figure.layout
  layout.shapes = []
  layout.annotations = []
  for (const [value, label] of [[thresholds.penaltyWarn, 'warning'],
    [thresholds.penaltyCrit, 'critical']]) {
    if (!isNumber(value)) continue
    layout.shapes.push({
      type: 'line', xref: 'x', yref: 'paper', x0: value, x1: value, y0: 0, y1: 1,
      line: { color: chrome.axis, width: 1 }, layer: 'below'
    })
    // The label is muted text, not the line's colour: a threshold is chrome, not a series.
    layout.annotations.push({
      x: value, xref: 'x', y: 1, yref: 'paper', text: label, showarrow: false,
      xanchor: 'left', yanchor: 'bottom', font: { size: 10, color: chrome.muted }
    })
  }
  return { data: figure.data, layout }
}

/**
 * The distribution of round trips to one target, one step outline per ticked run.
 *
 * This is the only chart that puts the runs on top of each other, and deliberately so: two
 * distributions on one axis is exactly what a histogram is for. The bins are shared across
 * the runs (stats.sharedBins), so the two outlines are measuring the same thing, and each
 * one is filled at a tenth of its colour so neither run can hide the other.
 */
export function histogramFigure(runs, target, tokens) {
  const list = runs || []
  const slots = tokens.runSlots.light
  const chrome = tokens.chrome.light
  const layout = baseLayout(tokens, 300, list.length > 1)
  layout.xaxis.title = axisTitle('round trip, ms', chrome)
  layout.yaxis.title = axisTitle('probes per bin', chrome)
  const bins = sharedBins(list, target, HIST_BINS)
  // Nothing measured this target in any ticked run: an empty figure, so the page can still
  // put its card and its heading on screen rather than jumping the layout about.
  if (!bins) return { data: [], layout }
  const data = []
  list.forEach((run, i) => {
    const slot = slotFor(run, i)
    const colour = slots[slot] || slots[0]
    const label = esc(runName(run))
    const counts = binCounts(run, target, bins)
    if (!counts.some(count => count > 0)) return
    const peak = counts.indexOf(Math.max(...counts))
    data.push({
      type: 'scatter', mode: 'lines+text',
      // One point per bin edge, held flat across the bin by the "hv" shape; the closing
      // zero draws the right-hand wall of the last bin.
      x: bins.edges.slice(), y: counts.concat([0]),
      line: { shape: 'hv', width: 2, color: colour },
      // A wash has to be spelled out as its own colour: trace opacity would fade the
      // outline with it, and the page's theme swap only restyles line and marker colours,
      // so this fill keeps its light-mode hue. At a tenth, that is invisible either way.
      fill: 'tozeroy', fillcolor: wash(colour, WASH),
      text: counts.map((_, j) => (j === peak ? label : '')).concat(['']),
      textposition: 'top right', textfont: { size: 11, color: chrome.ink2 },
      name: label, legendgroup: `run${slot}`, showlegend: list.length > 1,
      hovertemplate: `%{x:.1f} ms: %{y} probes<extra>${label}</extra>`,
      meta: { role: `run${slot}` }
    })
  })
  return { data, layout }
}

/**
 * One run's round trips against the seconds into that run, for one target.
 *
 * These panels sit side by side rather than on top of each other because the runs in the
 * log are 30 s, 60 s and 600 s long and each one starts its speed test at a different
 * second: overlaid, the phases would not line up and the comparison would be a lie. What
 * makes the panels honest instead is `yRange`, worked out once across every panel and
 * passed in here, so a taller spike really is a slower run.
 */
export function timelineFigure(run, slot, target, yRange, tokens) {
  const slots = tokens.runSlots.light
  const chrome = tokens.chrome.light
  const colour = slots[slot] || slots[0]
  const label = esc(runName(run || {}))
  const entry = entryOf(run, target)
  const samples = (entry && entry.samples) || []
  const data = [{
    type: 'scatter', mode: 'markers',
    x: samples.map(sample => sample[2]), y: samples.map(sample => sample[1]),
    marker: { color: colour, size: 5 },
    name: label, showlegend: false,
    hovertemplate: `%{x:.1f} s: %{y:.1f} ms<extra>${label}</extra>`,
    meta: { role: `run${slot}` }
  }]
  const lost = ((entry && entry.loss) || {}).lost || []
  if (lost.length) {
    // The floor of the plot, which is not zero: the shared scale usually starts well above
    // it, and a cross at zero would simply fall off the bottom of the panel.
    const floor = yRange && yRange.length ? yRange[0] : 0
    data.push({
      type: 'scatter', mode: 'markers',
      x: lost.map(item => item[1]), y: lost.map(() => floor),
      marker: { color: tokens.status.critical, size: 7, symbol: 'x' },
      name: 'lost', showlegend: false,
      hovertemplate: '%{x:.1f} s: probe lost<extra></extra>',
      meta: { role: 'lost' }
    })
  }
  const layout = baseLayout(tokens, 260, false)
  layout.xaxis.title = axisTitle('seconds', chrome)
  layout.yaxis.title = axisTitle('round trip, ms', chrome)
  if (yRange && yRange.length === 2) layout.yaxis.range = yRange.slice()
  const bands = phaseBands(run, chrome)
  layout.shapes = bands.shapes
  layout.annotations = bands.annotations
  return { data, layout }
}

/**
 * The grouped horizontal bars both overview charts are made of.
 *
 * The bars are placed by hand on a numeric y axis rather than left to plotly's own
 * grouping, for one reason: the p95 marks are scatter points, and plotly only offsets bars
 * within a band, so a scatter point would sit in the middle of the band while the bar it
 * belongs to sat above or below it. Placing both from the same arithmetic keeps a run's
 * mark on a run's bar. The target names go back on the axis as tick labels.
 */
function bandedBars(runs, tokens, opts) {
  const list = runs || []
  const slots = tokens.runSlots.light
  const chrome = tokens.chrome.light
  const names = liveTargets(list, tokens.targetOrder)
    .filter(name => list.some(run => opts.value(entryOf(run, name)) !== null))
  const geometry = bandGeometry(Math.max(list.length, 1))
  const data = []
  list.forEach((run, i) => {
    const slot = slotFor(run, i)
    const colour = slots[slot] || slots[0]
    const label = esc(runName(run))
    const values = names.map(name => opts.value(entryOf(run, name)))
    const ys = names.map((_, j) => j + geometry.offsets[i])
    data.push({
      type: 'bar', orientation: 'h', x: values, y: ys, width: geometry.width,
      marker: { color: colour, cornerradius: 4 },
      name: label, legendgroup: `run${slot}`, showlegend: list.length > 1,
      // The value on the bar, in text ink rather than the bar's colour. A silent target
      // contributes a null, which plotly draws as no bar at all rather than a zero.
      text: values.map(value => (value === null ? '' : value.toFixed(0))),
      textposition: 'outside', cliponaxis: false,
      textfont: { color: chrome.ink2, size: 11 },
      customdata: names,
      hovertemplate: `%{customdata}: ${opts.what} %{x:.1f} ${opts.unit}<extra>${label}</extra>`,
      meta: { role: `run${slot}` }
    })
    if (!opts.mark) return
    const marks = names.map(name => opts.mark(entryOf(run, name)))
    if (!marks.some(value => value !== null)) return
    data.push({
      type: 'scatter', mode: 'markers', x: marks, y: ys,
      marker: { color: colour, size: 12, symbol: 'line-ns', line: { width: 2, color: colour } },
      name: `${label} p95`, legendgroup: `run${slot}`, showlegend: false,
      customdata: names,
      hovertemplate: `%{customdata}: p95 %{x:.1f} ms<extra>${label}</extra>`,
      meta: { role: `run${slot}` }
    })
  })
  const height = 60 + geometry.bandPx * Math.max(names.length, 1)
  const layout = baseLayout(tokens, height, list.length > 1)
  // Overlay, not group: the offsets above have already done the grouping, and letting
  // plotly do it again would shift every bar a second time.
  layout.barmode = 'overlay'
  layout.bargap = 0
  layout.xaxis.title = axisTitle(opts.axisTitle, chrome)
  layout.yaxis.tickmode = 'array'
  layout.yaxis.tickvals = names.map((_, j) => j)
  layout.yaxis.ticktext = names
  layout.yaxis.showgrid = false
  // Reversed, so the first target in the tokens order is at the top of the chart.
  layout.yaxis.range = [Math.max(names.length, 1) - 0.5, -0.5]
  return { data, layout }
}

/** Where each run's bar sits inside one target's band, and how thick it is. */
function bandGeometry(nRuns) {
  const bandPx = BAND_BASE_PX + BAND_PER_RUN_PX * nRuns
  const barPx = Math.min(MAX_BAR_PX, (bandPx * BAND_FILL) / nRuns)
  const step = (barPx + BAR_GAP_PX) / bandPx
  const offsets = []
  for (let i = 0; i < nRuns; i += 1) offsets.push((i - (nRuns - 1) / 2) * step)
  // A band is one unit of the y axis, so a width in units is a fraction of the band.
  return { bandPx, width: barPx / bandPx, offsets }
}

/** The grey regions marking when the speed test was running, with the phase named above each. */
function phaseBands(run, chrome) {
  const marks = (run || {}).phase_marks_s || {}
  const shapes = []
  const annotations = []
  // Grey, not the download and upload hues the run pages use, because in this view colour
  // is already saying which run a mark belongs to and it cannot say two things at once.
  for (const [name, start, end] of [['download', marks.download, marks.upload],
    ['upload', marks.upload, marks['idle-again']]]) {
    if (!isNumber(start) || !isNumber(end)) continue
    shapes.push({
      type: 'rect', xref: 'x', yref: 'paper', x0: start, x1: end, y0: 0, y1: 1,
      fillcolor: wash(chrome.muted, BAND_WASH), line: { width: 0 }, layer: 'below'
    })
    annotations.push({
      x: start, xref: 'x', y: 1, yref: 'paper', text: name, showarrow: false,
      xanchor: 'left', yanchor: 'bottom', font: { size: 10, color: chrome.muted }
    })
  }
  return { shapes, annotations }
}

/** The chrome every figure shares: transparent, tight margins, a hairline grid, no title. */
function baseLayout(tokens, height, legend) {
  const chrome = tokens.chrome.light
  const axis = {
    gridcolor: chrome.grid, gridwidth: 1, linecolor: chrome.axis, linewidth: 1,
    zeroline: false, tickfont: { color: chrome.muted, size: 11 }
  }
  return {
    template: 'none', paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: tokens.font, color: chrome.ink, size: 12 },
    // No title inside the figure: the card's heading above it already names the chart.
    margin: { l: 56, r: 16, t: 24, b: 40 }, height,
    xaxis: { ...axis }, yaxis: { ...axis },
    showlegend: legend,
    legend: { orientation: 'h', y: 1.08, x: 0, font: { size: 11, color: chrome.ink2 } },
    hoverlabel: { font: { family: tokens.font } }
  }
}

function axisTitle(text, chrome) {
  return { text, font: { size: 11, color: chrome.ink2 } }
}

/** This run's figures for one target, or null when it never measured it or it stayed silent. */
function entryOf(run, target) {
  const entry = ((((run || {}).analysis || {}).targets) || {})[target] || null
  // A silent address is not a slow one: it belongs in the text, not on any chart.
  return entry && !isSilent(entry) ? entry : null
}

function statOf(entry, key) {
  const value = entry && entry.all ? entry.all[key] : null
  return isNumber(value) ? value : null
}

/** The colour slot a run holds, which the page attaches so a colour follows the run. */
function slotFor(run, index) {
  const slot = (run || {}).slot
  return slot === null || slot === undefined ? index : slot
}

function runName(run) {
  return run.label || run.id
}

/** A token hex as an rgba string, for the fills the theme swap does not reach. */
function wash(hex, alpha) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex))
  if (!match) return hex
  const [r, g, b] = match.slice(1).map(pair => parseInt(pair, 16))
  return `rgba(${r},${g},${b},${alpha})`
}

/** Escape text plotly will render through its own little HTML renderer.
 *
 * Trace names, direct labels and hover text all go through it, and a run label is whatever
 * the user typed on the command line. dom.js does this for the page, but this module only
 * imports stats.js, so it keeps its own copy.
 */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}
