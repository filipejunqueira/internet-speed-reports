// What the explorer page has ticked: which runs are selected, which colour slot each one
// holds, which target the drill-down is showing, and how the picker table is sorted.
//
// The slot is the whole point of this file. Slot 0, 1 or 2 picks the colour a run wears on
// every chart below the table, so the colour has to follow the run itself and never its
// position in the list: unticking the first of two runs must leave the other one exactly
// the colour it already had. A shared link is the one exception, because the query string
// carries the ids in slot order but not the slot numbers: a link written while a middle
// slot stood free opens with the runs packed back onto the lowest slots, same order,
// different colours. Every function here is pure — same input, same output, no state kept in the
// module — so node can test it without a browser.

export const DEFAULT_TARGET = 'sao-paulo'

// How many runs may be ticked at once when the caller does not say. The page passes its
// own number from the tokens block; this is only the fallback.
const DEFAULT_MAX_RUNS = 3

// The target names a URL is allowed to ask for. This repeats TARGET_ORDER in
// src/pingme/render_web.py deliberately: readState has to judge "?target=..." before the
// page's tokens block is in hand, so it cannot ask Python for the list. Keep the two in
// step when a target is added.
const KNOWN_TARGETS = ['router', 'isp-hop', 'london', 'madrid', 'us-east', 'sao-paulo']

const DEFAULT_SORT_KEY = 'timestamp'
const DEFAULT_SORT_DIR = 'desc'

// A sort key is whatever the picker's header cells carry in their data-sort attribute,
// which is the table's business and not this file's, so anything shaped like a column name
// is accepted. An unrecognised key simply sorts nothing.
const SORT_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

/** A fresh state: nothing ticked, the given target, newest run first. */
export function emptyState(defaultTarget) {
  return {
    selected: [],
    target: defaultTarget || DEFAULT_TARGET,
    sort: {key: DEFAULT_SORT_KEY, dir: DEFAULT_SORT_DIR}
  }
}

/**
 * Tick or untick one run.
 *
 * Ticking gives the run the lowest slot nobody is using, so a freed colour is reused
 * before a new one is spent. Unticking frees that run's slot and leaves every other run on
 * the slot it already had. Ticking one run too many changes nothing and comes back with
 * refused true, which is the page's cue to explain why.
 *
 * Returns {state, refused}.
 */
export function toggleRun(state, id, maxRuns) {
  const cap = Number.isInteger(maxRuns) && maxRuns > 0 ? maxRuns : DEFAULT_MAX_RUNS
  const kept = state.selected.filter(entry => entry.id !== id)
  if (kept.length < state.selected.length) {
    return {state: {...state, selected: kept}, refused: false}
  }
  const slot = lowestFreeSlot(state.selected, cap)
  if (slot === null) return {state, refused: true}
  const selected = [...state.selected, {id, slot}].sort((a, b) => a.slot - b.slot)
  return {state: {...state, selected}, refused: false}
}

function lowestFreeSlot(selected, cap) {
  const taken = new Set(selected.map(entry => entry.slot))
  for (let slot = 0; slot < cap; slot += 1) {
    if (!taken.has(slot)) return slot
  }
  return null
}

/** The colour slot this run holds, or null when it is not ticked. */
export function slotOf(state, id) {
  const entry = state.selected.find(item => item.id === id)
  return entry ? entry.slot : null
}

export function isSelected(state, id) {
  return state.selected.some(entry => entry.id === id)
}

/** The ticked run ids in slot order, which is also the order they are written to the URL. */
export function selectedIds(state) {
  return [...state.selected].sort((a, b) => a.slot - b.slot).map(entry => entry.id)
}

/**
 * What is different between two states, and so how much of the page has to be redrawn:
 * "structure", "target" or "none".
 *
 * "structure" means the whole thing below the picker has to be built again: the view kind
 * changed (nothing ticked, one ticked, several), or the ticked runs changed, or one of
 * them changed colour. "target" means only the chosen target moved, so the same runs are
 * still on screen wearing the same colours and only the headings, tables and figures that
 * follow the target have to be redone. That is the load-bearing reason the target path may
 * reuse the run records already fetched and leave every chart div where it is: "target"
 * guarantees the ids and the slots are untouched.
 *
 * Sorting the picker is neither. The picker redraws itself the moment a header is clicked
 * and nothing below it reads the order.
 *
 * A missing state counts as "structure": the first render has nothing on screen to keep.
 */
export function whatChanged(previous, next) {
  if (!previous || !next) return 'structure'
  const before = selectedKeys(previous)
  const after = selectedKeys(next)
  if (before.length !== after.length) return 'structure'
  if (before.some((key, i) => key !== after[i])) return 'structure'
  if ((previous.target || DEFAULT_TARGET) !== (next.target || DEFAULT_TARGET)) return 'target'
  return 'none'
}

/**
 * Each ticked run as "id:slot", in slot order.
 *
 * The slot is in the key as well as the id because it is the run's colour: two states that
 * tick the same runs in the same order but hand them different colours are as different to
 * the charts as a tick would be.
 */
function selectedKeys(state) {
  return [...(state.selected || [])]
    .sort((a, b) => a.slot - b.slot)
    .map(entry => `${entry.id}:${entry.slot}`)
}

/**
 * Read the state back out of a query string such as "?runs=a,b&target=london&sort=p95:asc".
 * Anything unknown or malformed falls back to the default rather than throwing, because
 * this string is whatever somebody happened to paste into the address bar.
 */
export function readState(search, defaultTarget, maxRuns) {
  const state = emptyState(defaultTarget)
  // The caller passes the palette size from the tokens block. The module constant is
  // only the fallback, for a call made before those tokens are in hand.
  const cap = Number.isInteger(maxRuns) && maxRuns > 0 ? maxRuns : DEFAULT_MAX_RUNS
  const params = new URLSearchParams(typeof search === 'string' ? search : '')

  // Slots come from the order the ids are written in, which is why writeState emits them
  // in slot order: a bookmarked comparison opens with the runs in the same order, packed
  // onto the lowest slots.
  const seen = new Set()
  for (const id of (params.get('runs') || '').split(',')) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    if (state.selected.length >= cap) break
    state.selected.push({id: trimmed, slot: state.selected.length})
  }

  const target = params.get('target')
  if (target && KNOWN_TARGETS.includes(target)) state.target = target

  const sort = params.get('sort')
  if (sort) {
    const [key, dir] = sort.split(':')
    if (SORT_KEY_RE.test(key || '') && (dir === 'asc' || dir === 'desc')) {
      state.sort = {key, dir}
    }
  }
  return state
}

/**
 * The query string for this state, leading "?" included, or "" when there is nothing worth
 * putting in the address bar.
 *
 * This cannot know the page's own default target — the page falls back to the first live
 * relay when Sao Paulo is not among the ticked runs — so it measures against
 * DEFAULT_TARGET. The worst that costs is a URL naming a target the page would have picked
 * anyway, which still reads back the same.
 */
export function writeState(state) {
  const ids = selectedIds(state)
  const target = state.target || DEFAULT_TARGET
  const parts = []
  if (ids.length) parts.push('runs=' + ids.map(encodeURIComponent).join(','))
  if (target !== DEFAULT_TARGET) parts.push('target=' + encodeURIComponent(target))
  const sort = state.sort || {}
  if (sort.key && (sort.key !== DEFAULT_SORT_KEY || sort.dir !== DEFAULT_SORT_DIR)) {
    const dir = sort.dir === 'asc' ? 'asc' : 'desc'
    parts.push('sort=' + encodeURIComponent(sort.key) + ':' + dir)
  }
  return parts.length ? '?' + parts.join('&') : ''
}

/**
 * A new array of the rows sorted by one column. The original array is left alone.
 *
 * Rows with no value for the column sink to the bottom whichever way the column is sorted.
 * That matters for the burst column: a run published before bursts were counted has no
 * figure at all, and it must not float to the top of the table as if it were the best or
 * the worst. Equal rows keep the order they came in, in both directions.
 */
export function sortRows(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({row, index, value: row == null ? undefined : row[key]}))
    .sort((a, b) => {
      const missingA = isMissing(a.value)
      const missingB = isMissing(b.value)
      if (missingA || missingB) {
        if (missingA && missingB) return a.index - b.index
        return missingA ? 1 : -1
      }
      const order = compareValues(a.value, b.value)
      return order === 0 ? a.index - b.index : order * sign
    })
    .map(entry => entry.row)
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Number(a) - Number(b)
  }
  return String(a).localeCompare(String(b))
}
