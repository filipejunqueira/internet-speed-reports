// The route map for the comparison view: one traced route per ticked run, drawn on a globe.
//
// The Python side (src/pingme/render_map.py) draws the same shape for a single run, one
// colour per target. Here colour means the run, because the whole comparison view is read
// that way, so two runs to the same relay can be told apart on the map. The geometry —
// which hops become points, where the line goes dashed — is deliberately identical to
// `_segments` in render_map.py, so a route looks the same on both pages.
//
// This module imports nothing and never touches the DOM or Plotly: it returns plain
// objects, so node can test it.

// Two points closer than this in both latitude and longitude are the same place as far as
// a world map is concerned; drawing the second one would add a hop of zero length.
const COLLAPSE_DEG = 0.05

// Where the cables that carry this traffic come ashore. Drawn for reference so a route
// that goes the long way round is visible as such. Matches src/pingme/places.py.
const REFERENCE_POINTS = [
  { name: 'Sines (EllaLink)', lat: 37.95, lon: -8.87 },
  { name: 'Fortaleza (EllaLink)', lat: -3.73, lon: -38.52 },
  { name: 'New York', lat: 40.71, lon: -74.0 },
  { name: 'Miami', lat: 25.77, lon: -80.19 }
]

/** Delay per hop address, so a point on the map can say how long it took to reach it. */
function hopDelays(traceEntry) {
  const out = new Map()
  for (const hop of (traceEntry && traceEntry.hops) || []) {
    if (!hop || !hop.ip) continue
    if (hop.avg_ms !== null && hop.avg_ms !== undefined) out.set(hop.ip, hop.avg_ms)
  }
  return out
}

/** True for a location with nowhere to go on the map: no reply, or a reply we cannot place. */
function undrawable(loc) {
  return loc === null || loc === undefined || loc.lat === null || loc.lat === undefined
}

/** Walk the hop locations into drawable points, keeping the hops that were skipped.
 *
 * Returns the points and `hiddenAfter`: how many hops were skipped after the last drawn
 * one. Those have nowhere to land inside `routePoints`, but they matter — the hops just
 * before a relay are often the ones that do not geolocate — so `mapFigure` carries them
 * onto the final leg to the relay, the way the Python version does.
 */
function walk(traceEntry, origin) {
  if (!origin || origin.length < 2) return { points: [], hiddenAfter: 0 }
  const delays = hopDelays(traceEntry)
  const points = [{ lat: origin[0], lon: origin[1], city: 'you', ip: null, ms: null,
    hiddenBefore: 0 }]
  let hidden = 0
  for (const loc of (traceEntry && traceEntry.locations) || []) {
    if (undrawable(loc)) {
      hidden += 1
      continue
    }
    const last = points[points.length - 1]
    // A hop in the same place as the one before it is not a new point, and it is not a
    // hidden one either: it answered and we know where it is.
    if (Math.abs(loc.lat - last.lat) < COLLAPSE_DEG &&
        Math.abs(loc.lon - last.lon) < COLLAPSE_DEG) continue
    const ms = delays.has(loc.ip) ? delays.get(loc.ip) : null
    points.push({ lat: loc.lat, lon: loc.lon, city: loc.city || null, ip: loc.ip, ms,
      hiddenBefore: hidden })
    hidden = 0
  }
  return { points, hiddenAfter: hidden }
}

/** The points to draw for one traced target: the origin, then every hop we can place.
 *
 * `origin` is the run's own [lat, lon]. `hiddenBefore` on a point counts the hops between
 * it and the point before it that could not be drawn, which is what makes that leg dashed.
 */
export function routePoints(traceEntry, origin) {
  return walk(traceEntry, origin).points
}

function runName(run) {
  return run.label || run.id
}

/** The colour slot a run keeps, falling back to its place among the runs actually drawn.
 *
 * The map and the hop table must agree on this or a row's swatch would point at the wrong
 * line, so both count from the drawn runs and neither from the ticked ones.
 */
function slotFor(run, i) {
  return run.slot === undefined || run.slot === null ? i : run.slot
}

/** Escape text that plotly will render as HTML.
 *
 * Hover text and direct labels go through plotly's own little HTML renderer, and what
 * goes into them is not ours: a city name comes from a geolocation service and a run
 * label is whatever the user typed. dom.js does this for the page, but this module
 * imports nothing, so it keeps its own copy.
 */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function targetRecord(run, target) {
  return ((run && run.targets) || []).find(t => t.name === target) || null
}

function traceFor(run, target) {
  return (run && run.traces && run.traces[target]) || null
}

function hoverFor(point, name) {
  const noDelay = point.ms === null || point.ms === undefined
  const reached = noDelay ? '' : `, ${Math.round(point.ms)} ms in`
  const where = esc(point.city || '?')
  const address = point.ip ? ` (${esc(point.ip)}${reached})` : ''
  return `${where}${address}<br>${name}`
}

/** The plotly map: one line per ticked run that has a trace to this target.
 *
 * `runs` come in slot order and carry their slot when the page attaches one, so a run
 * keeps its colour when another run above it is unticked.
 */
export function mapFigure(runs, target, tokens) {
  const slots = tokens.runSlots.light
  const chrome = tokens.chrome.light
  const drawn = (runs || []).filter(run => traceFor(run, target))
  const data = []
  drawn.forEach((run, i) => {
    const slot = slotFor(run, i)
    const colour = slots[slot] || slots[0]
    const role = `run${slot}`
    const name = esc(runName(run))
    const origin = (run.analysis && run.analysis.origin) || null
    const walked = walk(traceFor(run, target), origin)
    const points = walked.points.slice()
    const relay = targetRecord(run, target)
    // The relay itself is the end of the route even when the last hops never answered:
    // those hops are carried onto this leg, which draws it dashed.
    if (relay && relay.lat !== null && relay.lat !== undefined) {
      const last = points[points.length - 1]
      const same = last && Math.abs(relay.lat - last.lat) < COLLAPSE_DEG &&
        Math.abs(relay.lon - last.lon) < COLLAPSE_DEG
      if (!same) {
        points.push({ lat: relay.lat, lon: relay.lon, city: relay.city || relay.name,
          ip: relay.ip, ms: null, hiddenBefore: walked.hiddenAfter })
      }
    }
    for (let j = 1; j < points.length; j++) {
      const a = points[j - 1], b = points[j]
      // One trace per leg: plotly dashes a whole line or none of it, and only the legs
      // that jump over hops we could not place should read as a guess.
      data.push({
        type: 'scattergeo', lat: [a.lat, b.lat], lon: [a.lon, b.lon], mode: 'lines',
        line: { width: 2, color: colour, dash: b.hiddenBefore ? 'dash' : 'solid' },
        // Grouped by the slot, not by the name, exactly as figures.js does: the log already
        // holds two runs both labelled "leeds_bt", and grouping those by name would collapse
        // them into one legend entry, so clicking either would hide both routes.
        name, legendgroup: role, showlegend: j === 1 && drawn.length > 1,
        hovertext: b.hiddenBefore ? `${name}: ${b.hiddenBefore} hidden hop(s)` : name,
        hoverinfo: 'text', meta: { role }
      })
    }
    data.push({
      type: 'scattergeo', lat: points.map(p => p.lat), lon: points.map(p => p.lon),
      mode: 'markers+text',
      // The run's name written at the far end of its own line, so identity never rests on
      // colour alone.
      text: points.map((_, j) => (j === points.length - 1 ? name : '')),
      textposition: 'middle right', textfont: { size: 11, color: chrome.ink2 },
      marker: { size: 8, color: colour },
      name, legendgroup: role, showlegend: false,
      hovertext: points.map(p => hoverFor(p, name)), hoverinfo: 'text', meta: { role }
    })
  })
  data.push({
    type: 'scattergeo',
    lat: REFERENCE_POINTS.map(p => p.lat), lon: REFERENCE_POINTS.map(p => p.lon),
    mode: 'markers+text', text: REFERENCE_POINTS.map(p => p.name), textposition: 'bottom center',
    marker: { size: 6, color: chrome.muted, opacity: 0.6, symbol: 'diamond' },
    textfont: { size: 10, color: chrome.muted }, name: 'cable landing points',
    hoverinfo: 'text', showlegend: false, meta: { role: 'muted' }
  })
  const origins = []
  for (const run of drawn) {
    const origin = (run.analysis && run.analysis.origin) || null
    // Runs made in different places have different origins — a Leeds run against a
    // Santander one — so each place gets its own star, and two runs from one house share.
    if (origin && !origins.some(o => o[0] === origin[0] && o[1] === origin[1])) origins.push(origin)
  }
  // The star is grey rather than black because the theme swap only knows the roles the
  // figures use, and a star of its own size and shape is already unmistakable.
  if (origins.length) {
    data.push({
      type: 'scattergeo', lat: origins.map(o => o[0]), lon: origins.map(o => o[1]),
      mode: 'markers+text',
      text: origins.map(() => 'you'), textposition: 'top center',
      marker: { size: 11, color: chrome.muted, symbol: 'star' },
      textfont: { size: 11, color: chrome.ink2 },
      name: 'origin', hoverinfo: 'text', showlegend: false, meta: { role: 'muted' }
    })
  }
  const layout = {
    template: 'none', paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: tokens.font, color: chrome.ink, size: 12 },
    // A map has no axis labels to leave room for, so the margins are only the breathing
    // space the direct labels need at the edges.
    margin: { l: 8, r: 8, t: 8, b: 8 },
    showlegend: drawn.length > 1,
    legend: { x: 0.01, y: 0.99, font: { color: chrome.ink2, size: 11 } },
    // The ground colours are the map's own, not part of the token palette: they are the
    // light-mode values the run pages use, and the page swaps them for the dark ones on a
    // theme change exactly as it does there.
    geo: {
      fitbounds: 'locations', projection: { type: 'natural earth' },
      showcountries: true, showland: true, showocean: true,
      bgcolor: 'rgba(0,0,0,0)', landcolor: '#f2efe9', oceancolor: '#dbe9f6',
      countrycolor: '#bbb', coastlinecolor: '#999'
    }
  }
  return { data, layout }
}

/** The ticked runs with no route to this target, so the page can say what the map omits. */
export function untracedRuns(runs, target) {
  return (runs || []).filter(run => !traceFor(run, target))
}

/** The same walk as the map, as rows a table can print: one entry per route drawn.
 *
 * Everything the map only says on hover — which address a point is, how long it took to
 * reach it, how many hops before it never answered — has to be readable without a pointer
 * too, so the page prints it underneath. The runs are the ones `mapFigure` draws and in the
 * same order, carrying the slot their colour comes from, so a row and a line match up.
 *
 * `points` is `routePoints` without the origin, numbered from 1, with `step`: how much
 * delay this point added over the previous drawn one. It is null when either end has no
 * timing, and it can come out negative — traceroute times each hop once, so two hops a
 * millisecond apart genuinely swap places. That is passed through rather than tidied to
 * zero, because a table that never shows a negative is a table that has been edited.
 */
export function hopRows(runs, target) {
  const drawn = (runs || []).filter(run => traceFor(run, target))
  return drawn.map((run, i) => {
    const origin = (run.analysis && run.analysis.origin) || null
    const drawnPoints = routePoints(traceFor(run, target), origin)
    // Dropping the origin shifts the indices by one, so `drawnPoints[j]` is the point
    // before the one being turned into a row.
    const points = drawnPoints.slice(1).map((point, j) => {
      const before = drawnPoints[j].ms
      const step = point.ms === null || point.ms === undefined ||
        before === null || before === undefined ? null : point.ms - before
      return { n: j + 1, city: point.city, ip: point.ip, ms: point.ms, step,
        hiddenBefore: point.hiddenBefore }
    })
    // The relay itself ends the route on the map even when the last hops never answered,
    // so it needs a row here too: otherwise its address is readable only by hovering,
    // which is the whole reason this table exists.
    const relay = targetRecord(run, target)
    const last = drawnPoints[drawnPoints.length - 1]
    const placed = relay && relay.lat !== null && relay.lat !== undefined
    const sameSpot = placed && last && Math.abs(relay.lat - last.lat) < COLLAPSE_DEG &&
      Math.abs(relay.lon - last.lon) < COLLAPSE_DEG
    if (placed && !sameSpot) {
      points.push({ n: points.length + 1, city: relay.city || target, ip: relay.ip || null,
        ms: null, step: null, hiddenBefore: walk(traceFor(run, target), origin).hiddenAfter })
    }
    return { id: run.id, label: runName(run), slot: slotFor(run, i), points }
  })
}
