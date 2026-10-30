/**
 * Session-tree plugin, host half.
 *
 * Registers two session projection units over the same fold:
 *
 *   branchTree      summary:true   compact previews (tree structure, card heads)
 *   branchTreeFull  summary:false  full prompt / response text for one session,
 *                                  read on demand through `session.projections`
 *
 * The rolling hash of the whole event prefix, anchored at every `turn/end`, is
 * what lets the browser rebuild fork edges without reading logs: a forked
 * session's inherited prefix is a byte-identical copy of its parent's prefix,
 * so both reach the same hash at the cut boundary.
 *
 * Pure synchronous folds; no subscriptions, no timers.
 */

export const name = 'dsh-session-helix'
export const inject = ['sessionProjections']

export const PROJECTION_KEY = 'branchTree'
export const PROJECTION_FULL_KEY = 'branchTreeFull'
const VIEW_VERSION = 1
const MAX_TURNS = 240

/** Only `parse` is used by the registry; a permissive validator keeps this package dependency-free. */
const anySchema = {
	parse(value) {
		return value
	},
}

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619

function fnv1a(text, previous) {
	let hash = previous >>> 0
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, FNV_PRIME)
	}
	return hash >>> 0
}

function signature(event) {
	return `${event.seq}\u0001${event.time}\u0001${event.type}`
}

function textOf(blocks) {
	if (!Array.isArray(blocks)) return ''
	let out = ''
	for (const block of blocks) {
		if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
	}
	return out
}

function clip(text, limit) {
	const flat = String(text ?? '').trim()
	if (limit <= 0) return flat
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function makeTurn(number, seq, time) {
	return { n: number, s: seq, e: null, r: null, t0: time, t1: null, d: null, p: '', x: '', u: 0, c: 0 }
}

function openTurnIndex(turns) {
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		if (turns[i].e === null) return i
	}
	return -1
}

/**
 * Build one projection unit whose fold keeps previews clipped to the given
 * budgets and whose wire view publishes `seeded/cut/createdAt/title/turns/anchors`.
 */
function makeUnit(key, promptLimit, responseLimit) {
	const publish = (state) => {
		const turns = state.turns.length > MAX_TURNS ? state.turns.slice(-MAX_TURNS) : state.turns
		state.v = {
			v: VIEW_VERSION,
			seeded: state.seeded,
			cut: state.cut,
			createdAt: state.createdAt,
			cwd: state.cwd,
			title: state.title,
			turns: turns.map((turn) => ({ ...turn })),
			anchors: state.anchors.map((anchor) => [anchor[0], anchor[1]]),
		}
		return state
	}

	return {
		key,
		stateVersion: 1,
		stateSchema: anySchema,
		init(header, inheritedEventCount) {
			const state = {
				h: FNV_OFFSET,
				seeded: header.isSeeded === true,
				cut: inheritedEventCount ?? 0,
				createdAt: header.createdAt,
				cwd: header.cwd ?? null,
				title: null,
				turns: [],
				anchors: [],
				v: null,
			}
			state.v = {
				v: VIEW_VERSION,
				seeded: state.seeded,
				cut: state.cut,
				createdAt: state.createdAt,
				cwd: state.cwd,
				title: null,
				turns: [],
				anchors: [],
			}
			return state
		},
		apply(state, event) {
			const hash = fnv1a(signature(event), state.h)
			let dirty = false
			let turns = state.turns
			let anchors = state.anchors
			let title = state.title

			switch (event.type) {
				case 'turn/start':
					turns = turns.concat([makeTurn(event.data?.turn ?? turns.length + 1, event.seq, event.time)])
					dirty = true
					break
				case 'turn/end': {
					const index = openTurnIndex(turns)
					if (index >= 0) {
						turns = turns.slice()
						turns[index] = {
							...turns[index],
							e: event.seq,
							r: event.data?.reason?.kind ?? 'completed',
							t1: event.time,
							d: event.time - turns[index].t0,
						}
					}
					anchors = anchors.concat([[event.seq, hash]])
					dirty = true
					break
				}
				case 'session/title':
					if (typeof event.data?.title === 'string') {
						title = event.data.title
						dirty = true
					}
					break
				case 'user/message': {
					if (event.data?.source?.kind === 'user') {
						const text = textOf(event.data?.content)
						const index = openTurnIndex(turns)
						if (text !== '' && index >= 0 && turns[index].p === '') {
							turns = turns.slice()
							turns[index] = { ...turns[index], p: clip(text, promptLimit) }
							dirty = true
						}
					}
					break
				}
				case 'assistant/message': {
					const text = textOf(event.data?.message?.content)
					const index = openTurnIndex(turns)
					if (text !== '' && index >= 0) {
						const usage = event.data?.usage ?? {}
						turns = turns.slice()
						turns[index] = {
							...turns[index],
							x: clip(text, responseLimit),
							u: turns[index].u + (Number(usage.outputTokens) || 0),
						}
						dirty = true
					}
					break
				}
				case 'tool/call': {
					const index = openTurnIndex(turns)
					if (index >= 0) {
						turns = turns.slice()
						turns[index] = { ...turns[index], c: turns[index].c + 1 }
						dirty = true
					}
					break
				}
				default:
					break
			}

			if (!dirty) return { ...state, h: hash }

			return publish({
				h: hash,
				seeded: state.seeded,
				cut: state.cut,
				createdAt: state.createdAt,
				cwd: state.cwd,
				title,
				turns,
				anchors,
				v: state.v,
			})
		},
		wire: {
			viewSchema: anySchema,
			view(state) {
				return state.v
			},
		},
	}
}

export function apply(ctx) {
	const compact = makeUnit(PROJECTION_KEY, 96, 150)
	compact.wire.summary = true
	const full = makeUnit(PROJECTION_FULL_KEY, 0, 0)
	full.wire.summary = false
	return Promise.all([
		ctx.sessionProjections.register(compact),
		ctx.sessionProjections.register(full),
	])
}
