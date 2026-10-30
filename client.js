/**
 * Session-tree plugin, browser half.
 *
 * Renders the branch graph rebuilt from the host `branchTree` projection:
 * one column per branch (with its own header), one row per turn position,
 * dashed edges from the parent turn a branch was cut from to the branch's
 * first own turn.
 *
 * Two entry points share one canvas:
 *   - `conversation.view` tab: the current Session's own family
 *   - `main` panel (`sidebar.panellist` icon): one workspace at a time
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-helix',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		const LABEL = '分支树'
		const PANEL_KEY = 'branch-tree'

		/**
		 * Density is about how much one card carries, not how big it is: the prompt
		 * clamp, the meta row and the answer line are structural, and the base font
		 * only sets the scale. Zoom is a stage-level CSS transform (`--dst-zoom`), so
		 * these numbers stay put while the canvas is scaled around the cursor.
		 */
		const DENSITY = {
			compact: { font: 11, lines: 1, meta: false, answer: false, widthEm: 17 },
			normal: { font: 11.5, lines: 2, meta: true, answer: false, widthEm: 20.5 },
			roomy: { font: 12.5, lines: 3, meta: true, answer: true, widthEm: 21.5 },
		}
		/** Line box heights in em, shared by the CSS and the height computation. */
		const EM = {
			padTop: 0.62,
			padBottom: 0.55,
			head: 0.92 * 1.25,
			gap: 0.26,
			promptLine: 1.4,
			answer: 1.15,
			meta: 0.85 * 1.25,
		}
		const MIN_ZOOM = 0.7
		const MAX_ZOOM = 1.4
		const LAYOUT_KEY = 'dsh-dst.layout.v1'
		const DEFAULT_LAYOUT = {
			inspectorWidth: 372,
			tocWidth: 190,
			tocCollapsed: false,
			density: 'normal',
			zoom: 1,
			boardSplit: 240,
			drawerWidth: 380,
		}

		function clampNumber(value, min, max) {
			return Math.min(max, Math.max(min, value))
		}

		/**
		 * Resolve one (density, zoom) pair into every number the layout math needs.
		 * The live canvas passes density only and scales the stage with CSS; `zoom`
		 * stays for offline measurement of a given visual scale.
		 */
		function makeMetrics(density, zoom) {
			const preset = DENSITY[density] || DENSITY.normal
			const scale = clampNumber(Number(zoom) || 1, MIN_ZOOM, MAX_ZOOM)
			const font = preset.font * scale
			let contentEm = EM.padTop + EM.padBottom + EM.head + EM.gap + preset.lines * EM.promptLine
			if (preset.answer) contentEm += EM.gap + EM.answer
			if (preset.meta) contentEm += EM.gap + EM.meta
			const nodeH = Math.round(contentEm * font) + 2
			const nodeW = Math.round(preset.widthEm * font)
			return {
				density: DENSITY[density] ? density : 'normal',
				scale,
				font: Math.round(font * 10) / 10,
				nodeW,
				nodeH,
				rowH: nodeH + Math.round(font * 1.5),
				laneW: nodeW + Math.round(font * 3),
				pad: Math.round(font * 1.74),
				headH: Math.round(font * 6.4),
				lines: preset.lines,
				meta: preset.meta,
				answer: preset.answer,
			}
		}

		const DEFAULT_METRICS = makeMetrics('normal', 1)

		/** Per-surface layout document: the Tab view and the side panel each keep one. */
		function readLayout(scope) {
			try {
				const raw = window.localStorage.getItem(LAYOUT_KEY)
				const parsed = raw === null ? null : JSON.parse(raw)
				const bucket = parsed && typeof parsed === 'object' ? parsed[scope] : null
				return { ...DEFAULT_LAYOUT, ...(bucket && typeof bucket === 'object' ? bucket : {}) }
			} catch (error) {
				return { ...DEFAULT_LAYOUT }
			}
		}

		function writeLayout(scope, patch) {
			try {
				const raw = window.localStorage.getItem(LAYOUT_KEY)
				const parsed = raw === null ? null : JSON.parse(raw)
				const all = parsed && typeof parsed === 'object' ? parsed : {}
				const next = { ...all, [scope]: { ...readLayout(scope), ...patch } }
				window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
			} catch (error) {
				// storage disabled: the in-memory size still applies for this page
			}
		}

		const LANE_COLORS = [
			'var(--dsw-alias-state-business-primary,#58a6ff)',
			'#d2a8ff',
			'#7ee787',
			'#ffa657',
			'#79c0ff',
			'#f778ba',
		]

		const STATUS = {
			completed: { color: 'var(--dsw-alias-state-success-primary,#3fb950)', label: '已完成' },
			aborted: { color: 'var(--dsw-alias-state-warn-primary,#d29922)', label: '已中止' },
			error: { color: 'var(--dsw-alias-state-error-primary,#f85149)', label: '出错' },
			interrupted: { color: 'var(--dsw-alias-label-secondary,#8b949e)', label: '中断' },
			blocked: { color: 'var(--dsw-alias-state-warn-primary,#d29922)', label: '阻塞' },
			'max-tokens': { color: 'var(--dsw-alias-state-warn-primary,#d29922)', label: '超长' },
			forked: { color: 'var(--dsw-alias-state-business-primary,#a371f7)', label: '分叉' },
			open: { color: 'var(--dsw-alias-state-business-primary,#58a6ff)', label: '进行中' },
		}

		const STYLE_ID = 'dsh-session-helix-style'
		const CSS = `
.dst-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1,#0b0e14);color:var(--dsw-alias-label-primary,#e6edf3)}
.dst-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#21262d);flex:none;font-size:12.5px;color:var(--dsw-alias-label-secondary,#8b949e)}
.dst-bar strong{font-size:13px;color:var(--dsw-alias-label-primary,#e6edf3);font-weight:600}
.dst-bar .dst-grow{flex:1}
.dst-btn{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dst-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
.dst-btn[data-on="true"]{border-color:var(--dsw-alias-state-business-primary,#58a6ff);color:var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-select{height:32px;font-size:13px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:12px;padding:0 8px;max-width:280px}
.dst-body{display:flex;min-height:0;flex:1}
.dst-split-v{flex:none;width:6px;align-self:stretch;cursor:col-resize;background:transparent;position:relative;z-index:3}
.dst-split-h{flex:none;height:6px;align-self:stretch;cursor:row-resize;background:transparent;position:relative;z-index:3}
.dst-split-v:hover,.dst-split-v:focus-visible,.dst-split-h:hover,.dst-split-h:focus-visible{background:var(--dsw-alias-state-business-primary,#58a6ff);outline:none}
.dst-split-v:focus-visible,.dst-split-h:focus-visible{box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#58a6ff)}
body.dst-resizing-v,body.dst-resizing-v *{cursor:col-resize !important;user-select:none !important}
body.dst-resizing-h,body.dst-resizing-h *{cursor:row-resize !important;user-select:none !important}
.dst-toc[data-collapsed="true"]{width:26px;padding:6px 2px;overflow:hidden;border-right:1px solid var(--dsw-alias-border-l2,#21262d)}
.dst-toc-toggle{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#6e7681);cursor:pointer;font:inherit;font-size:13px;padding:2px 4px;border-radius:5px;align-self:flex-start}
.dst-toc-toggle:hover{color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-bg-hover,rgba(127,127,127,.14))}
.dst-toc[data-collapsed="false"]{display:flex;flex-direction:column}
.dst-toc[data-collapsed="false"] .dst-toc-toggle{margin-top:auto}
.dst-zoom{display:flex;align-items:center;gap:2px;flex:none}
.dst-zoom-val{height:32px;min-width:52px;padding:0 6px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#8b949e);font:inherit;font-size:12px;cursor:pointer}
.dst-zoom-val:hover{color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
.dst-toc{width:190px;flex:none;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2,#21262d);padding:10px 8px}
.dst-toc-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7681);padding:0 6px 6px}
.dst-toc-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8b949e);border-radius:6px;padding:6px 8px;font:inherit;font-size:12px;cursor:pointer;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-toc-item:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e6edf3)}
.dst-toc-hint{margin-top:12px;padding:0 6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-toc-item[data-active="true"]{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e6edf3)}
.dst-drawer{flex:none;display:flex;flex-direction:column;min-height:0;width:380px;border-left:1px solid var(--dsw-alias-border-l2,#21262d);background:var(--dsw-alias-bg-layer-1,#0b0e14)}
.dst-drawer>.dst-board{flex:1;min-height:0;height:auto}
.dst-canvas{flex:1;overflow:auto;position:relative;cursor:grab;user-select:none;-webkit-user-select:none;overflow-anchor:none}
.dst-canvas-dragging{cursor:grabbing}
.dst-canvas-dragging .dst-node,.dst-canvas-dragging .dst-node *{cursor:grabbing !important}
.dst-board{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-bg-layer-1,#0b0e14)}
.dst-board-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#21262d);flex:none;color:var(--dsw-alias-label-secondary,#8b949e);font-size:12px}
.dst-board-head strong{color:var(--dsw-alias-label-primary,#e6edf3);font-size:13px;font-weight:600}
.dst-board-head .dst-grow{flex:1}
.dst-board-body{flex:1;min-height:0;overflow:auto;padding:8px 10px}
.dst-board-empty{padding:30px 12px;color:var(--dsw-alias-label-tertiary,#6e7681);text-align:center;line-height:1.7}
.dst-board-list{list-style:none;margin:0 auto;padding:0;display:flex;flex-direction:column;gap:8px;max-width:820px}
.dst-board-item{border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-layer-2,#11161d)}
.dst-board-item-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#8b949e)}
.dst-board-item-head .dst-grow{flex:1}
.dst-board-item-title{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-board-badge{padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#30363d);font-size:9.5px;line-height:14px}
.dst-board-prompt{margin-top:5px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#e6edf3);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dst-board-resp{margin-top:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#8b949e);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.dst-board-assemble{flex:none;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--dsw-alias-border-l2,#21262d);padding:10px 12px 12px;max-height:calc(100% - 132px)}
.dst-board-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7681);margin:0 auto 6px;max-width:820px}
.dst-board-text{display:block;width:100%;max-width:820px;margin:0 auto;box-sizing:border-box;resize:none;flex:1;min-height:0;padding:8px 9px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:12px;line-height:1.55}
.dst-board-text:focus{outline:2px solid var(--dsw-alias-state-business-primary,#58a6ff);outline-offset:-1px}
.dst-board-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px auto 0;max-width:820px}
.dst-board-grip{margin-right:2px;color:var(--dsw-alias-label-tertiary,#6e7681);cursor:grab;letter-spacing:-1px;user-select:none}
.dst-board-item[data-dragging="true"]{opacity:.45}
.dst-board-item[data-drop="true"]{box-shadow:0 -2px 0 0 var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-board-text-body{cursor:text}
.dst-board-text-body:hover .dst-board-prompt{text-decoration:underline;text-decoration-color:var(--dsw-alias-border-l3,#30363d);text-underline-offset:3px}
.dst-board-edit{margin-top:6px}
.dst-board-edit-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6e7681);margin:6px 0 3px}
.dst-board-edit-text{display:block;width:100%;box-sizing:border-box;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#0b0e14);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:11.5px;line-height:1.55}
.dst-board-edit-text:focus{outline:2px solid var(--dsw-alias-state-business-primary,#58a6ff);outline-offset:-1px}
.dst-board-edit-actions{display:flex;gap:8px;margin-top:8px}
.dst-board{position:relative}
.dst-board-count{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7681);white-space:nowrap}
.dst-group{position:relative;flex:1;min-width:0;max-width:200px}
.dst-group-trigger{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:3px 8px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:11.5px;cursor:pointer;text-align:left}
.dst-group-trigger:hover{border-color:var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-group-caret{flex:none;font-size:9px;color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-group-pop{position:absolute;left:0;top:calc(100% + 4px);z-index:30;width:238px;max-height:300px;display:flex;flex-direction:column;padding:6px;border:1px solid var(--dsw-alias-border-l2,#21262d);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#0b0e14);box-shadow:0 12px 34px rgba(0,0,0,.5)}
.dst-group-search{width:100%;box-sizing:border-box;margin-bottom:4px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:11.5px}
.dst-group-search:focus{outline:2px solid var(--dsw-alias-state-business-primary,#58a6ff);outline-offset:-1px}
.dst-group-list{list-style:none;margin:0;padding:0;min-height:0;overflow:auto}
.dst-group-row{display:flex;align-items:center;gap:3px;padding:4px 6px;border-radius:5px;font-size:11.5px;cursor:pointer}
.dst-group-row[data-cursor="true"]{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.14))}
.dst-group-row[data-active="true"] .dst-group-row-name{color:var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-group-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-group-count{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-group-empty{padding:8px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-group-new{width:100%;margin-top:4px;padding:5px 6px 3px;border:0;border-top:1px solid var(--dsw-alias-border-l2,#21262d);background:none;color:var(--dsw-alias-state-business-primary,#58a6ff);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}
.dst-pick{flex:none;margin:0;accent-color:var(--dsw-alias-state-business-primary,#58a6ff);cursor:pointer}
.dst-board-item[data-picked="false"]{opacity:.5}
.dst-dialog-mask{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
.dst-dialog{width:min(300px,calc(100% - 28px));box-sizing:border-box;padding:14px;border:1px solid var(--dsw-alias-border-l2,#21262d);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#0b0e14);box-shadow:0 18px 44px rgba(0,0,0,.55)}
.dst-dialog-title{margin-bottom:8px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3)}
.dst-dialog-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:12px}
.dst-dialog-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#58a6ff);outline-offset:-1px}
.dst-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dst-btn[data-primary="true"]{border-color:var(--dsw-alias-state-business-primary,#58a6ff);color:var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-excerpt-btn{position:fixed;transform:translate(-50%,-100%);z-index:60;padding:5px 10px;border:1px solid var(--dsw-alias-state-business-primary,#58a6ff);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-primary,#e6edf3);font:inherit;font-size:12px;cursor:pointer;box-shadow:var(--dsw-elevation-panel,0 8px 22px rgba(0,0,0,.4))}
.dst-excerpt-btn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.16))}
.dst-sections{display:flex;flex-direction:column;width:max-content;min-width:100%}
.dst-section{position:relative}
.dst-section-head{position:sticky;top:0;left:0;box-sizing:border-box;width:var(--dst-canvas-w,100%);z-index:4;display:flex;align-items:center;gap:8px;padding:7px 14px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#0b0e14) 92%, transparent);backdrop-filter:blur(6px);border-bottom:1px solid var(--dsw-alias-border-l1,#1b2128);font-size:12px;color:var(--dsw-alias-label-secondary,#8b949e)}
.dst-section-head b{color:var(--dsw-alias-label-primary,#e6edf3);font-weight:600;font-size:13px}
.dst-stage-wrap{position:relative;width:calc(var(--dst-stage-w,0px) * var(--dst-zoom,1));height:calc(var(--dst-stage-h,0px) * var(--dst-zoom,1))}
.dst-stage{position:absolute;left:0;top:0;transform:scale(var(--dst-zoom,1));transform-origin:0 0}
.dst-conn{position:absolute;inset:0;pointer-events:none;overflow:visible}
.dst-lane-head{position:absolute;width:var(--dst-node-w,236px);box-sizing:border-box;padding:.5em .7em 0;border-top:2px solid transparent;font-size:var(--dst-font,11.5px)}
.dst-lane-head .dst-lane-id{font-size:.96em;font-weight:700;letter-spacing:.02em;line-height:1.2}
.dst-lane-head .dst-lane-title{font-size:1em;line-height:1.3;color:var(--dsw-alias-label-primary,#e6edf3);margin-top:.15em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-lane-head .dst-lane-origin{font-size:.86em;line-height:1.25;color:var(--dsw-alias-label-tertiary,#6e7681);margin-top:.16em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-node{position:absolute;box-sizing:border-box;width:var(--dst-node-w,236px);height:var(--dst-node-h,80px);border-radius:10px;border:1px solid var(--dsw-alias-border-l3,#30363d);background:var(--dsw-alias-bg-layer-2,#11161d);padding:.62em .78em .55em;cursor:pointer;text-align:left;font:inherit;font-size:var(--dst-font,11.5px);color:inherit;overflow:hidden;display:flex;flex-direction:column;gap:.26em;transition:border-color .12s,box-shadow .12s}
.dst-node:hover{border-color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-node[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary,#58a6ff);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-node[data-focus="true"]::after{content:"";position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#58a6ff)}
.dst-node-head{display:flex;align-items:baseline;gap:.34em;font-size:.92em;flex:none;line-height:1.25;min-width:0}
.dst-node-n{font-weight:700;color:var(--dsw-alias-label-primary,#e6edf3)}
.dst-node-status{margin-left:auto;font-size:.84em;white-space:nowrap}
.dst-node-prompt{font-size:1em;line-height:1.4;flex:1;min-height:0;color:var(--dsw-alias-label-primary,#e6edf3);display:-webkit-box;-webkit-line-clamp:var(--dst-prompt-lines,2);-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dst-node-meta{font-size:.85em;line-height:1.25;flex:none;color:var(--dsw-alias-label-tertiary,#6e7681);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .1s}
.dst-node-answer{display:none;flex:none;font-size:.86em;line-height:1.15;color:var(--dsw-alias-label-secondary,#8b949e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.92}
.dst-root[data-density="roomy"] .dst-node-answer{display:block}
.dst-root[data-density="compact"] .dst-node-meta{display:none}
.dst-root[data-density="compact"] .dst-node-status{font-size:.8em}
.dst-node:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#58a6ff);outline-offset:1px}
.dst-node[data-running="true"]{border-color:var(--dsw-alias-state-business-primary,#58a6ff);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#58a6ff) inset}
.dst-node-actions{position:absolute;right:5px;bottom:4px;display:none;gap:2px;z-index:2}
.dst-node:hover .dst-node-actions,.dst-node:focus-within .dst-node-actions{display:flex}
.dst-node:hover .dst-node-meta,.dst-node:focus-within .dst-node-meta{opacity:0}
.dst-act{display:inline-flex;align-items:center;justify-content:center;width:21px;height:19px;padding:0;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:5px;background:var(--dsw-alias-bg-layer-1,#0b0e14);color:var(--dsw-alias-label-secondary,#8b949e);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.dst-act:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6edf3);border-color:var(--dsw-alias-label-tertiary,#6e7681);background:var(--dsw-alias-bg-hover,rgba(127,127,127,.16))}
.dst-act:disabled{opacity:.35;cursor:default}
.dst-act[data-danger="true"]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#f85149);border-color:var(--dsw-alias-state-error-primary,#f85149)}
.dst-note{font-size:11px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-warn-primary,#d29922)}
.dst-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dst-arch{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;border:1px solid #3d444d;color:var(--dsw-alias-label-secondary,#8b949e);font-size:9.5px;line-height:15px;vertical-align:1px}
@keyframes dst-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.dst-run-dot{display:inline-block;width:6px;height:6px;margin-left:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#58a6ff);animation:dst-pulse 1.4s ease-in-out infinite;vertical-align:1px}
.dst-node[data-running="true"] .dst-node-status::before{content:"● ";animation:dst-pulse 1.4s ease-in-out infinite}
.dst-running{color:var(--dsw-alias-state-business-primary,#58a6ff);font-size:11px}
.dst-hover{position:absolute;z-index:5;width:302px;box-sizing:border-box;pointer-events:none;border:1px solid var(--dsw-alias-border-l3,#30363d);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#11161d);box-shadow:var(--dsw-elevation-panel,0 10px 28px rgba(0,0,0,.45));padding:8px 10px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-hover b{display:block;color:var(--dsw-alias-label-secondary,#8b949e);font-size:11px;font-weight:600;margin-bottom:4px}
.dst-hover-text{color:var(--dsw-alias-label-primary,#e6edf3);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.dst-chip{position:absolute;border:1px dashed var(--dsw-alias-border-l3,#30363d);background:var(--dsw-alias-bg-layer-2,#11161d);color:var(--dsw-alias-label-secondary,#8b949e);border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit}
.dst-chip:hover{color:var(--dsw-alias-label-primary,#e6edf3);border-color:var(--dsw-alias-label-tertiary,#6e7681)}
.dst-inspector{position:relative;width:372px;flex:none;box-sizing:border-box;height:100%;overflow:auto;border-left:1px solid var(--dsw-alias-border-l2,#21262d);background:var(--dsw-alias-bg-layer-1,#0b0e14);padding:16px 16px 20px;font-size:12.5px;line-height:1.65;z-index:2}
.dst-insp-title{font-size:14.5px;font-weight:600;margin:0 22px 3px 0;color:var(--dsw-alias-label-primary,#e6edf3)}
.dst-insp-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6e7681);margin-bottom:14px}
.dst-insp-row{margin-bottom:14px}
.dst-insp-label{font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7681);margin-bottom:3px}
.dst-insp-text{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#e6edf3);font-size:12.5px}
.dst-insp-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.dst-inspector[data-floating="true"]{position:relative}
/* Tab scope: the host lets .viewArea grow with its content and scrolls .scrollBody,
   so the dock cannot size itself from the flex row. Pin it to the scrollport instead;
   the host measures both variables on the composer seat. */
.dst-root[data-scope="tab"] .dst-inspector{position:sticky;top:0;align-self:flex-start;height:calc(var(--dsh-conversation-viewport-height, 70vh) - var(--dsh-composer-height, 0px) - 6px);max-height:100%}
.dst-insp-close{position:absolute;top:12px;right:12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8b949e);font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px}
.dst-insp-close:hover{color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-alias-bg-hover,var(--dsw-alias-bg-hover,rgba(127,127,127,.14)))}
.dst-empty{padding:40px 20px;color:var(--dsw-alias-label-secondary,#8b949e);font-size:13px;text-align:center}
.dst-placeholder{padding:6px 2px;color:var(--dsw-alias-label-tertiary,#6e7681);font-size:12px;line-height:1.6}
`

		function ensureStyle() {
			if (typeof document === 'undefined') return
			if (document.getElementById(STYLE_ID)) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = CSS
			document.head.appendChild(style)
		}

		function shortId(id) {
			return String(id || '').slice(8, 16)
		}

		function formatDuration(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
			if (ms < 1000) return `${Math.round(ms)}ms`
			if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
			return `${Math.round(ms / 60000)}分`
		}

		function statusOf(turn) {
			return STATUS[(turn && turn.r) || 'open'] || STATUS.open
		}

		function useListSnapshot(ctx) {
			return React.useSyncExternalStore(
				(callback) => ctx.sessions.list.subscribe(callback),
				() => ctx.sessions.list.getSnapshot(),
			)
		}

		/* --------------------------------------------------------------- drafts */

		const DRAFT_STORE_KEY = 'dsh-dst.drafts.v1'
		const DRAFT_KIND = 'session-draft'
		const DRAFT_TAB_ID = 'dsh-session-helix/draft'
		const EMPTY_DRAFTS = Object.freeze([])
		const EMPTY_BOARD = Object.freeze({ groups: Object.freeze([]), activeGroupId: '' })
		const DRAFT_HEADING = '## 参考片段'
		const draftListeners = new Set()
		const inputBridges = new Map()
		let draftState = null
		let groupSeq = 0

		function newGroupId() {
			groupSeq += 1
			return `g${Date.now().toString(36)}${groupSeq.toString(36)}`
		}

		function makeGroup(name, items) {
			return { id: newGroupId(), name, items: Array.isArray(items) ? items : [], text: '', manual: false }
		}

		/**
		 * One workspace's board: independent groups, each with its own cards,
		 * selection and edited assembly. A legacy single-list board becomes the
		 * first group, so a reload never loses cards already on it.
		 */
		function normalizeBoard(bucket) {
			if (bucket !== null && typeof bucket === 'object' && Array.isArray(bucket.groups) && bucket.groups.length > 0) {
				const groups = bucket.groups.map((group, index) => ({
					id: typeof group?.id === 'string' && group.id !== '' ? group.id : `g${index}`,
					name: typeof group?.name === 'string' && group.name !== '' ? group.name : `组 ${index + 1}`,
					items: Array.isArray(group?.items) ? group.items : [],
					text: typeof group?.text === 'string' ? group.text : '',
					manual: group?.manual === true,
				}))
				const active = groups.find((group) => group.id === bucket.activeGroupId) || groups[0]
				return { groups, activeGroupId: active.id }
			}
			if (bucket !== null && typeof bucket === 'object' && Array.isArray(bucket.items)) {
				const group = makeGroup('组 1', bucket.items)
				return { groups: [group], activeGroupId: group.id }
			}
			return null
		}

		/** Lazy read of the whole board document; one copy per page load, then memory. */
		function readDraftState() {
			if (draftState !== null) return draftState
			draftState = {}
			try {
				const raw = window.localStorage.getItem(DRAFT_STORE_KEY)
				const parsed = raw === null ? null : JSON.parse(raw)
				if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
					const next = {}
					for (const key of Object.keys(parsed)) {
						const board = normalizeBoard(parsed[key])
						if (board !== null) next[key] = board
					}
					draftState = next
				}
			} catch (error) {
				draftState = {}
			}
			return draftState
		}

		function saveDraftState() {
			try {
				window.localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(draftState))
			} catch (error) {
				// quota or a disabled storage backend: the in-memory copy still works
			}
			for (const listener of draftListeners) listener()
		}

		function subscribeDrafts(listener) {
			draftListeners.add(listener)
			return () => {
				draftListeners.delete(listener)
			}
		}

		/** The board of one workspace; always has at least one group. */
		function boardOf(workspaceId) {
			if (!workspaceId) return EMPTY_BOARD
			const state = readDraftState()
			let board = state[workspaceId]
			if (board === undefined) {
				const group = makeGroup('组 1', [])
				board = { groups: [group], activeGroupId: group.id, updatedAt: Date.now() }
				state[workspaceId] = board
			}
			if (!board.groups.some((group) => group.id === board.activeGroupId)) {
				board = { ...board, activeGroupId: board.groups[0].id }
				state[workspaceId] = board
			}
			return board
		}

		function commitBoard(workspaceId, board) {
			if (!workspaceId) return
			draftState = { ...readDraftState(), [workspaceId]: { ...board, updatedAt: Date.now() } }
			saveDraftState()
		}

		function groupOf(workspaceId, groupId) {
			const board = boardOf(workspaceId)
			return board.groups.find((group) => group.id === groupId) || null
		}

		function activeGroupOf(workspaceId) {
			const board = boardOf(workspaceId)
			return board.groups.find((group) => group.id === board.activeGroupId) || board.groups[0] || null
		}

		function patchGroup(workspaceId, groupId, patch) {
			const board = boardOf(workspaceId)
			const index = board.groups.findIndex((group) => group.id === groupId)
			if (index < 0) return
			const current = board.groups[index]
			const next = { ...current, ...patch }
			const changed = next.items !== current.items || next.name !== current.name
				|| next.text !== current.text || next.manual !== current.manual
			if (!changed) return
			const groups = board.groups.slice()
			groups[index] = next
			commitBoard(workspaceId, { ...board, groups })
		}

		function addDraft(workspaceId, groupId, item) {
			const group = groupOf(workspaceId, groupId)
			if (group === null) return
			if (group.items.some((existing) => existing.id === item.id)) return
			patchGroup(workspaceId, groupId, { items: group.items.concat([{ picked: true, ...item }]) })
		}

		function removeDraft(workspaceId, groupId, id) {
			const group = groupOf(workspaceId, groupId)
			if (group === null) return
			patchGroup(workspaceId, groupId, { items: group.items.filter((item) => item.id !== id) })
		}

		/** Drag-to-reorder: drop `movingId` onto `overId`, landing before it. */
		function reorderDraft(workspaceId, groupId, movingId, overId) {
			const group = groupOf(workspaceId, groupId)
			if (group === null) return
			const items = group.items
			const from = items.findIndex((item) => item.id === movingId)
			if (from < 0 || movingId === overId) return
			const next = items.slice()
			const moved = next.splice(from, 1)[0]
			const to = next.findIndex((item) => item.id === overId)
			next.splice(to < 0 ? next.length : to, 0, moved)
			patchGroup(workspaceId, groupId, { items: next })
		}

		/** Saving an edit marks the card: it enters the prompt as plain text. */
		function updateDraft(workspaceId, groupId, id, patch) {
			const group = groupOf(workspaceId, groupId)
			if (group === null) return
			let changed = false
			const next = group.items.map((item) => {
				if (item.id !== id) return item
				changed = true
				return { ...item, ...patch, edited: true }
			})
			if (changed) patchGroup(workspaceId, groupId, { items: next })
		}

		function togglePick(workspaceId, groupId, id) {
			const group = groupOf(workspaceId, groupId)
			if (group === null) return
			patchGroup(workspaceId, groupId, {
				items: group.items.map((item) => (
					item.id === id ? { ...item, picked: item.picked === false } : item
				)),
			})
		}

		function addGroup(workspaceId, name) {
			const board = boardOf(workspaceId)
			const group = makeGroup(name, [])
			commitBoard(workspaceId, {
				...board,
				groups: board.groups.concat([group]),
				activeGroupId: group.id,
			})
			return group.id
		}

		function renameGroup(workspaceId, groupId, name) {
			patchGroup(workspaceId, groupId, { name })
		}

		function deleteGroup(workspaceId, groupId) {
			const board = boardOf(workspaceId)
			if (board.groups.length <= 1) return false
			const groups = board.groups.filter((group) => group.id !== groupId)
			const activeGroupId = board.activeGroupId === groupId ? groups[0].id : board.activeGroupId
			commitBoard(workspaceId, { groups, activeGroupId })
			return true
		}

		function setActiveGroup(workspaceId, groupId) {
			const board = boardOf(workspaceId)
			if (board.activeGroupId === groupId) return
			if (!board.groups.some((group) => group.id === groupId)) return
			commitBoard(workspaceId, { ...board, activeGroupId: groupId })
		}

		function useBoard(workspaceId) {
			const getSnapshot = React.useCallback(() => boardOf(workspaceId), [workspaceId])
			return React.useSyncExternalStore(subscribeDrafts, getSnapshot)
		}

		/** The active group's cards; the same array reference until that group changes. */
		function useDrafts(workspaceId) {
			const getSnapshot = React.useCallback(() => {
				const group = activeGroupOf(workspaceId)
				return group === null ? EMPTY_DRAFTS : group.items
			}, [workspaceId])
			return React.useSyncExternalStore(subscribeDrafts, getSnapshot)
		}

		/* ------------------------------------------------------------- assembly */

		/** The composer's own blockquote formatter, byte for byte. */
		function quoteText(text) {
			return String(text ?? '').replace(/\r\n?/gu, '\n')
				.split('\n').map((line) => `> ${line}`).join('\n')
		}

		function cardTitle(item) {
			return item.sessionTitle || shortId(item.sessionId)
		}

		function cardBody(item) {
			if (item.kind === 'excerpt') return String(item.text ?? '')
			const parts = []
			if (item.prompt) parts.push(item.prompt)
			if (item.response) parts.push(item.response)
			return parts.join('\n\n')
		}

		function cardHeader(item) {
			const title = cardTitle(item)
			if (item.kind === 'excerpt') return `\u3010${title} \u00b7 \u6458\u5f55${item.turnN ? ` \u00b7 T${item.turnN}` : ''}\u3011`
			return `\u3010${title} \u00b7 T${item.turnN}\u3011`
		}

		/**
		 * Turn the selected cards into one prompt: a fixed heading, then a source
		 * line and body per card. Unedited cards ride as atomic quote nodes, edited
		 * cards as literal Markdown blockquotes; both serialize identically, so
		 * `text` is exactly what the model will read.
		 */
		function buildPlan(items) {
			const blocks = []
			const segments = []
			for (const item of items || []) {
				if (item.picked === false) continue
				const body = cardBody(item)
				if (body.trim() === '') continue
				const head = cardHeader(item)
				const leading = blocks.length === 0 ? `${DRAFT_HEADING}\n\n` : '\n\n'
				blocks.push(`${head}\n\n${quoteText(body)}`)
				if (item.edited === true) {
					segments.push({ t: 'text', text: `${leading}${head}\n\n${quoteText(body)}` })
				} else {
					segments.push({ t: 'text', text: `${leading}${head}\n\n` })
					segments.push({ t: 'quote', text: body })
				}
			}
			return {
				text: blocks.length === 0 ? '' : `${DRAFT_HEADING}\n\n${blocks.join('\n\n')}`,
				segments,
				count: blocks.length,
			}
		}

		/* --------------------------------------------------------------- fill-in */

		/**
		 * The composer's public action face is only reachable as a slot prop, so
		 * one invisible overlay per Session parks it here for the board's button.
		 */
		function InputBridge(props) {
			const sessionId = props.sessionId
			const actions = props.inputActions
			React.useLayoutEffect(() => {
				if (!sessionId || !actions) return undefined
				const entry = { actions }
				inputBridges.set(sessionId, entry)
				return () => {
					if (inputBridges.get(sessionId) === entry) inputBridges.delete(sessionId)
				}
			}, [sessionId, actions])
			return null
		}

		/**
		 * Append one assembled plan to the Session's composer. The first segment is
		 * always text: it seeds the draft through native initialization, the only
		 * append path that keeps the user's existing chips. Later segments go in at
		 * the caret, so order is preserved without computing offsets.
		 */
		function fillSession(sessionId, plan) {
			const ctx = ctxRef.current
			const bridge = inputBridges.get(sessionId)
			const conversation = ctx === null ? undefined : ctx.get('conversation')
			const binding = ctx === null ? undefined : ctx.sessions.binding(sessionId)
			if (!ctx || !bridge || !conversation || !binding) return 'no-input'
			const segments = plan !== null && Array.isArray(plan.segments) ? plan.segments : []
			if (segments.length === 0) return 'empty'
			const input = conversation.input.for(binding.ctx)
			const draft = input.state.getSnapshot().draft
			const seed = (draft === '' || draft.endsWith('\n') ? '' : '\n') + segments[0].text
			const result = conversation.input.requestDraftInitialization(binding, {
				prompt: seed,
				whenDraftExists: 'append',
			})
			if (result !== 'applied') return result
			for (let index = 1; index < segments.length; index += 1) {
				const segment = segments[index]
				const span = bridge.actions.captureInsertion()
				const applied = segment.t === 'quote'
					? bridge.actions.insertQuote(segment.text)
					: bridge.actions.insertText(segment.text, span)
				if (!applied) {
					const rest = segments.slice(index)
					const text = rest.map((item) => (item.t === 'quote' ? quoteText(item.text) : item.text)).join('')
					if (!bridge.actions.insertText(text, bridge.actions.captureInsertion())) return 'blocked'
					input.focus()
					return 'degraded'
				}
				if (bridge.actions.captureInsertion().start <= span.start) return 'stalled'
			}
			bridge.actions.persistDraft()
			input.focus()
			return 'done'
		}

		function workspaceIdOfSession(items, sessionId) {
			if (!Array.isArray(items) || !sessionId) return ''
			for (const item of items) {
				if (Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) return item.workspaceId
			}
			return ''
		}

		function copyText(text, report) {
			if (!text) {
				report('\u6ca1\u6709\u53ef\u590d\u5236\u7684\u5185\u5bb9')
				return
			}
			try {
				Promise.resolve(navigator.clipboard.writeText(text)).then(
					() => report('\u5df2\u590d\u5236'),
					() => report('\u590d\u5236\u5931\u8d25'),
				)
			} catch (error) {
				report('\u590d\u5236\u5931\u8d25')
			}
		}

		/* ---------------------------------------------------------------- model */

		function buildModel(list, allowedIds) {
			const ids = allowedIds
				? (list.ids || []).filter((id) => allowedIds.has(id))
				: (list.ids || [])
			const nodes = []
			const byId = new Map()
			for (const id of ids) {
				const row = list.byId?.[id]
				if (!row) continue
				const value = row.projectionValues?.branchTree
					?? list.projectionsBySession?.[id]?.values?.branchTree
				const node = {
					id,
					displayTitle: row.displayTitle || shortId(id),
					title: value?.title || row.displayTitle || shortId(id),
					createdAt: value?.createdAt ?? row.updatedAt ?? 0,
					seeded: value?.seeded === true,
					cut: value?.cut ?? 0,
					turns: Array.isArray(value?.turns) ? value.turns : [],
					anchors: Array.isArray(value?.anchors) ? value.anchors : [],
					ready: value !== undefined,
					running: row.running === true,
					parent: null,
					children: [],
				}
				nodes.push(node)
				byId.set(id, node)
			}

			// A fork inherits an exact event prefix, so the child's rolling hash at the
			// cut boundary equals the parent's: match anchors to rebuild the edge.
			for (const node of nodes) {
				if (!node.seeded || node.cut <= 0) continue
				const target = node.cut - 1
				let anchor = null
				for (const pair of node.anchors) {
					if (Array.isArray(pair) && pair[0] <= target) anchor = pair
				}
				if (!anchor) continue
				const candidates = nodes.filter((other) => (
					other !== node
					&& other.createdAt <= node.createdAt
					&& other.anchors.some((pair) => Array.isArray(pair) && pair[0] === anchor[0] && pair[1] === anchor[1])
				))
				if (candidates.length === 0) continue
				candidates.sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))
				node.parent = candidates[0]
				node.exact = anchor[0] === target
			}

			// A fork can cut inside a Turn its source only inherited — forking from a
			// branch at a point before that branch's own cut. The Turn is drawn in an
			// ancestor's lane, so the child hangs off the nearest ancestor that renders
			// it; the cut prefix is byte-identical, so the edge is exact either way.
			for (const node of nodes) {
				if (!node.parent) continue
				const boundary = node.cut - 1
				const source = node.parent
				let host = source
				let depth = 0
				while (host && !ownTurnAt(host, boundary) && host.parent && depth < 64) {
					host = host.parent
					depth += 1
				}
				if (host && host !== source && ownTurnAt(host, boundary)) {
					node.forkedFrom = source
					node.parent = host
				}
			}

			for (const node of nodes) {
				if (node.parent) node.parent.children.push(node)
			}
			// Order sibling lanes by where they attach, so a lane that branches off an
			// earlier Turn is drawn before one that branches off a later Turn.
			for (const node of nodes) node.children.sort((a, b) => ((a.cut - b.cut) || (a.createdAt - b.createdAt)))

			return { nodes, byId, roots: nodes.filter((node) => !node.parent) }
		}

		function descendantsOf(node, out = []) {
			for (const child of node.children) {
				out.push(child)
				descendantsOf(child, out)
			}
			return out
		}

		function ancestorsOf(node) {
			const out = []
			let current = node?.parent
			while (current) {
				out.push(current)
				current = current.parent
			}
			return out
		}

		/**
		 * The Turn a Session draws itself at `seq`: one it owns, not one it only
		 * inherited through its own seed prefix. `null` when the point predates its cut.
		 */
		function ownTurnAt(node, seq) {
			if (!node || !Array.isArray(node.turns)) return null
			let owner = null
			for (const turn of node.turns) {
				if ((turn.s ?? 0) <= seq) owner = turn
			}
			if (!owner) return null
			if ((owner.s ?? 0) < node.cut) return null
			return owner
		}

		function branchTurnOf(child) {
			const parent = child.parent
			if (!parent) return null
			const owner = ownTurnAt(parent, child.cut - 1)
			if (!owner) return null
			const midTurn = owner.e == null || owner.e >= child.cut
			return { turn: owner, midTurn }
		}

		function layoutSection(root, visible, metrics) {
			const m = metrics || DEFAULT_METRICS
			const order = []
			const walk = (node) => {
				if (!visible(node)) return
				order.push(node)
				for (const child of node.children) walk(child)
			}
			walk(root)
			if (order.length === 0) return null

			let maxCol = 0
			for (const node of order) {
				const parentInfo = node.parent ? branchTurnOf(node) : null
				const base = parentInfo ? parentInfo.turn.col ?? 0 : -1
				const midTurn = parentInfo ? parentInfo.midTurn : false
				let col = base + (midTurn ? 0.55 : 1)
				node.firstCol = node.parent ? col : 0
				for (const turn of node.turns) {
					if ((turn.s ?? 0) < node.cut) continue
					turn.col = col
					col += 1
				}
				maxCol = Math.max(maxCol, col - 1)
			}

			return {
				order,
				width: m.pad * 2 + m.laneW * order.length,
				height: m.pad * 2 + m.headH + m.rowH * (maxCol + 1),
				maxCol,
			}
		}

		function nodeX(lane, metrics) {
			const m = metrics || DEFAULT_METRICS
			return m.pad + lane * m.laneW
		}

		function nodeY(col, metrics) {
			const m = metrics || DEFAULT_METRICS
			return m.pad + m.headH + col * m.rowH + m.nodeH / 2
		}

		/* ------------------------------------------------------------ components */

		/**
		 * Draggable separator. Reports signed pixel deltas while dragging and on
		 * arrow keys, resets on double click, and paints the whole document with the
		 * resize cursor so a drag that leaves the handle still feels right.
		 */
		function Splitter({ orientation, onDelta, onReset, label }) {
			const vertical = orientation !== 'horizontal'
			const last = React.useRef(null)
			const finish = (element, pointerId) => {
				last.current = null
				document.body.classList.remove('dst-resizing-v', 'dst-resizing-h')
				try {
					element.releasePointerCapture(pointerId)
				} catch (error) {
					// nothing was captured
				}
			}
			return h('div', {
				className: vertical ? 'dst-split-v' : 'dst-split-h',
				role: 'separator',
				tabIndex: 0,
				'aria-label': label,
				'aria-orientation': vertical ? 'vertical' : 'horizontal',
				title: `${label}（双击复位，方向键微调）`,
				onPointerDown: (event) => {
					if (event.button !== 0) return
					event.preventDefault()
					event.stopPropagation()
					last.current = vertical ? event.clientX : event.clientY
					document.body.classList.add(vertical ? 'dst-resizing-v' : 'dst-resizing-h')
					try {
						event.currentTarget.setPointerCapture(event.pointerId)
					} catch (error) {
						// keep tracking inside the element
					}
				},
				onPointerMove: (event) => {
					if (last.current === null) return
					const current = vertical ? event.clientX : event.clientY
					const delta = current - last.current
					last.current = current
					if (delta !== 0) onDelta(delta)
				},
				onPointerUp: (event) => finish(event.currentTarget, event.pointerId),
				onPointerCancel: (event) => finish(event.currentTarget, event.pointerId),
				onDoubleClick: () => {
					if (onReset) onReset()
				},
				onKeyDown: (event) => {
					const step = event.shiftKey ? 32 : 16
					const back = vertical ? 'ArrowLeft' : 'ArrowUp'
					const forward = vertical ? 'ArrowRight' : 'ArrowDown'
					if (event.key !== back && event.key !== forward) return
					event.preventDefault()
					onDelta(event.key === back ? -step : step)
				},
			})
		}

		function SectionView({ root, byId, focusId, showAll, hideEmpty, metrics, onSelect, onExpand, onToggleExpand, expandedIds, hovered, onHover, onLeave, selected, registerRef, isArchived, draftedKeys, onOpen, onFork, onArchive, onDraft, forking }) {
			const m = metrics || DEFAULT_METRICS
			const isRevealed = React.useCallback((node) => {
				if (!expandedIds || expandedIds.size === 0) return false
				let current = node.parent
				while (current) {
					if (expandedIds.has(current.id)) return true
					current = current.parent
				}
				return false
			}, [expandedIds])

			/** A lane is empty when every Turn it lists was inherited before its cut. */
			const hasOwnTurn = (node) => node.turns.some((turn) => (turn.s ?? 0) >= node.cut)
			/** Empty lanes are dropped, unless they are the focus or host a non-empty fork. */
			const isEmptyBranch = (node) => hideEmpty && node.id !== focusId && !hasOwnTurn(node)
				&& !descendantsOf(node).some((item) => hasOwnTurn(item))

			const visible = React.useCallback((node) => {
				if (isEmptyBranch(node)) return false
				if (showAll || !focusId) return true
				if (node.id === focusId) return true
				const focus = byId.get(focusId)
				if (!focus) return true
				if (ancestorsOf(focus).some((item) => item.id === node.id)) return true
				if (descendantsOf(focus).some((item) => item.id === node.id)) return true
				if (isRevealed(node)) return true
				return false
			}, [showAll, focusId, byId, isRevealed, hideEmpty])

			const layout = React.useMemo(() => layoutSection(root, visible, m), [root, visible, m])
			if (!layout) return null

			const hiddenByParent = new Map()
			for (const node of byId.values()) {
				if (node.parent && visible(node.parent) && !visible(node) && !isEmptyBranch(node)) {
					const bucket = hiddenByParent.get(node.parent.id) || []
					bucket.push(node)
					hiddenByParent.set(node.parent.id, bucket)
				}
			}

			const ordered = layout.order
			const parts = []
			const heads = []
			const connectors = []

			for (let index = 0; index < ordered.length; index += 1) {
				const node = ordered[index]
				const lane = index
				node.lane = lane
				const x = nodeX(lane, m)
				const color = LANE_COLORS[lane % LANE_COLORS.length]
				const parentInfo = node.parent ? branchTurnOf(node) : null

				heads.push(h('div', {
					key: `h:${node.id}`,
					className: 'dst-lane-head',
					style: { left: x, top: m.pad - 2, borderTopColor: color },
				},
					h('div', { className: 'dst-lane-id', style: { color } },
						shortId(node.id),
						node.running ? h('span', { className: 'dst-run-dot', title: '进行中' }) : null,
						isArchived && isArchived(node.id) ? h('span', { className: 'dst-arch' }, '已归档') : null),
					h('div', { className: 'dst-lane-title', title: node.title }, node.title),
					h('div', { className: 'dst-lane-origin', title: node.title },
						node.parent
							? `⑂ 分叉自 ${shortId((node.forkedFrom || node.parent).id)}${node.forkedFrom ? ` · 落点属 ${shortId(node.parent.id)}` : ''} · T${parentInfo ? parentInfo.turn.n : '?'}${parentInfo && parentInfo.midTurn ? '轮中' : '轮后'} · cut@${node.cut}`
							: '根会话'),
				))

				const turns = node.turns.filter((turn) => (turn.s ?? 0) >= node.cut)
				for (const turn of turns) {
					parts.push(h(turnNode, {
						key: `${node.id}:${turn.n}`,
						session: node,
						turn,
						x: x + m.nodeW / 2,
						y: nodeY(turn.col, m),
						nodeW: m.nodeW,
						nodeH: m.nodeH,
						laneColor: color,
						lane,
						focus: node.id === focusId,
						selected: selected && selected.sessionId === node.id && selected.turn && selected.turn.n === turn.n,
						archived: isArchived ? isArchived(node.id) : false,
						onSelect: () => onSelect({ sessionId: node.id, turn, session: node }),
						onOpen: () => onOpen(node.id),
						onFork: (at) => onFork(node.id, at),
						forking: forking === true,
						onArchive: () => onArchive(node.id),
						onHover: () => onHover(node.id, turn.n),
						onLeave,
						drafted: draftedKeys ? draftedKeys.has(`${node.id}:${turn.n}`) : false,
						onDraft: () => onDraft(node, turn),
					}))
					if (turn.col > node.firstCol) {
						connectors.push({
							kind: 'chain',
							x: x + m.nodeW / 2,
							y1: nodeY(turn.col - 1, m) + m.nodeH / 2,
							y2: nodeY(turn.col, m) - m.nodeH / 2,
						})
					}
				}

				if (turns.length === 0) {
					parts.push(h(emptyNode, {
						key: `${node.id}:empty`,
						session: node,
						x: x + m.nodeW / 2,
						y: nodeY(node.firstCol ?? 0, m),
						nodeW: m.nodeW,
						nodeH: m.nodeH,
						onSelect: () => onSelect({ sessionId: node.id, turn: null, session: node }),
					}))
				}

				if (hovered && hovered.sessionId === node.id) {
					const turn = turns.find((item) => item.n === hovered.turnN)
					if (turn) {
						// Place beside the node, never over it: right, then left, and when a
						// narrow stage has room for neither, right outside the stage instead of
						// clamping back onto the node it describes.
						const rightEdge = x + m.nodeW
						const fitsRight = rightEdge + 14 + 302 <= layout.width
						const fitsLeft = x - 14 - 302 >= 0
						const left = fitsRight || !fitsLeft ? rightEdge + 14 : x - 14 - 302
						const status = statusOf(turn)
						parts.push(h('div', {
							key: `${node.id}:hover`,
							className: 'dst-hover',
							style: { left, top: nodeY(turn.col, m) - m.nodeH / 2 },
						},
							h('b', null, `${shortId(node.id)} · T${turn.n} · ${status.label}${turn.d ? ` · ${formatDuration(turn.d)}` : ''}${turn.c ? ` · ${turn.c} 次工具` : ''}`),
							h('div', { className: 'dst-hover-text' }, turn.x && turn.x.trim() ? turn.x : '（这一轮没有回答文本）'),
							h('div', { style: { marginTop: 6, fontSize: 10.5 } }, '点击这一轮看全文'),
						))
					}
				}

				if (parentInfo && node.parent.lane !== undefined) {
					connectors.push({
						kind: 'branch',
						x1: nodeX(node.parent.lane, m) + m.nodeW,
						y1: parentInfo.turn.col === undefined ? m.pad + m.headH * 0.6 : nodeY(parentInfo.turn.col, m) + 12,
						x2: x,
						y2: turns.length > 0 ? nodeY(turns[0].col, m) : nodeY(node.firstCol ?? 0, m),
						label: `cut@${node.cut}`,
					})
				}

				const hidden = hiddenByParent.get(node.id) || []
				if (hidden.length > 0) {
					const anchorTurn = turns.length > 0 ? turns[turns.length - 1] : null
					const y = (anchorTurn ? nodeY(anchorTurn.col, m) : nodeY(node.firstCol ?? 0, m)) + m.nodeH / 2 + 4
					parts.push(h('button', {
						key: `${node.id}:hidden`,
						className: 'dst-chip',
						type: 'button',
						style: { left: x, top: y, position: 'absolute' },
						onClick: () => onToggleExpand(node.id),
						title: hidden.map((item) => item.title).join('\n'),
					}, `⑂ 另有 ${hidden.length} 条分支`))
				}
			}

			return h('section', {
				className: 'dst-section',
				ref: (element) => registerRef(root.id, element),
			},
				h('div', { className: 'dst-section-head' },
					h('b', null, root.title),
					h('span', null, `${ordered.length} 条分支`),
					h('span', { style: { flex: 1 } }),
					h('span', null, shortId(root.id)),
				),
				h('div', {
					className: 'dst-stage-wrap',
					style: {
						'--dst-stage-w': `${layout.width}px`,
						'--dst-stage-h': `${layout.height}px`,
					},
				},
					h('div', { className: 'dst-stage', style: { width: layout.width, height: layout.height } },
						h('svg', { className: 'dst-conn', width: layout.width, height: layout.height },
							connectors.map((connector, index) => (connector.kind === 'chain'
								? h('line', {
									key: `c${index}`,
									x1: connector.x, y1: connector.y1, x2: connector.x, y2: connector.y2,
									stroke: 'var(--dsw-alias-border-l3,#30363d)', strokeWidth: 2,
								})
								: h(branchPath, { key: `b${index}`, ...connector }))),
						),
						heads,
						parts,
					),
				),
			)
		}

		/**
		 * Zoom rides on `--dst-zoom` only, so the sections must not re-render when it
		 * changes: that is what keeps a pinch from re-shaping 80 node labels a frame.
		 */
		const Section = React.memo(SectionView)

		function branchPath({ x1, y1, x2, y2, label }) {
			const midX = (x1 + x2) / 2
			const d = `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`
			return h('g', null,
				h('path', {
					d,
					fill: 'none',
					stroke: 'var(--dsw-alias-label-tertiary,#6e7681)',
					strokeWidth: 1.5,
					strokeDasharray: '5 4',
				}),
				h('polygon', {
					points: `${x2},${y2} ${x2 - 7},${y2 - 4} ${x2 - 7},${y2 + 4}`,
					fill: 'var(--dsw-alias-label-tertiary,#6e7681)',
				}),
				label ? h('text', {
					x: midX + 5,
					y: y1 - 5,
					fill: 'var(--dsw-alias-label-tertiary,#6e7681)',
					fontSize: 9,
				}, label) : null,
			)
		}

		function turnNode({
			session, turn, x, y, laneColor, lane, nodeW, nodeH, focus, selected, archived, drafted, forking,
			onSelect, onOpen, onFork, onArchive, onDraft, onHover, onLeave,
		}) {
			const width = nodeW || DEFAULT_METRICS.nodeW
			const height = nodeH || DEFAULT_METRICS.nodeH
			const status = statusOf(turn)
			const running = turn.e == null
			const closed = turn.e != null
			const activate = () => onSelect()
			const keydown = (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return
				event.preventDefault()
				activate()
			}
			const action = (name, label, handler, options) => {
				const settings = options || {}
				return h('button', {
					key: name,
					type: 'button',
					className: 'dst-act',
					'data-danger': settings.danger ? 'true' : 'false',
					disabled: settings.disabled ? true : undefined,
					title: settings.hint || label,
					onClick: (event) => {
						event.stopPropagation()
						handler()
					},
				}, label)
			}
			return h('div', {
				role: 'button',
				tabIndex: 0,
				className: 'dst-node',
				'data-selected': selected ? 'true' : 'false',
				'data-focus': focus ? 'true' : 'false',
				'data-running': running ? 'true' : 'false',
				'data-lane': String(lane ?? 0),
				'data-col': String(turn.col ?? 0),
				style: { left: x - width / 2, top: y - height / 2, borderLeft: `3px solid ${laneColor}` },
				onClick: activate,
				onKeyDown: keydown,
				onMouseEnter: onHover,
				onMouseLeave: onLeave,
				title: `${session.title} · 第 ${turn.n} 轮\n${turn.p || ''}`,
			},
				h('div', { className: 'dst-node-head' },
					h('span', { className: 'dst-node-n' }, `T${turn.n}`),
					archived ? h('span', { style: { fontSize: '.86em', color: 'var(--dsw-alias-label-tertiary,#6e7681)' } }, '归档') : null,
					h('span', { className: 'dst-node-status', style: { color: status.color } }, status.label),
				),
				h('div', { className: 'dst-node-prompt' }, turn.p || '（无提问）'),
				h('div', { className: 'dst-node-answer' }, turn.x && turn.x.trim() ? turn.x : '（无回答）'),
				h('div', { className: 'dst-node-meta' },
					`${formatDuration(turn.d)} · ${turn.c ?? 0} 次工具 · seq ${turn.s}`),
				h('div', { className: 'dst-node-actions' },
					action('fork', forking ? '…' : '⑂', () => onFork(turn), {
						disabled: !closed || archived || forking,
						hint: forking
							? '正在分叉，请稍候'
							: closed
								? (archived ? '归档中的会话不能分叉，先恢复' : `从第 ${turn.n} 轮之后分叉，原会话保留`)
								: '这一轮还没结束，不能在这里分叉',
					}),
					action('open', '↗', () => onOpen(), { hint: '打开会话' }),
					action('draft', drafted ? '✓' : '＋', () => onDraft(), {
						hint: drafted ? '从草稿板移出这一轮' : '把这一轮的提问和回答收进草稿板',
					}),
					action('archive', archived ? '↺' : '⌫', () => onArchive(), {
						danger: !archived,
						hint: archived ? '取消归档' : '归档这个会话',
					}),
				),
			)
		}

		function emptyNode({ session, x, y, nodeW, nodeH, onSelect }) {
			const width = nodeW || DEFAULT_METRICS.nodeW
			const height = nodeH || DEFAULT_METRICS.nodeH
			return h('button', {
				type: 'button',
				className: 'dst-node',
				style: {
					left: x - width / 2, top: y - height / 2,
					borderStyle: 'dashed', opacity: 0.78,
				},
				onClick: onSelect,
			},
				h('div', { className: 'dst-node-head' },
					h('span', { className: 'dst-node-n' }, '∅ 空分支'),
				),
				h('div', { className: 'dst-node-prompt' }, '切点之后没有产生自有轮次'),
				h('div', { className: 'dst-node-meta' }, shortId(session.id)),
			)
		}

		/**
		 * Selection-to-card inside the inspector: a mouse-up with a non-empty
		 * selection that lives in this aside raises a floating 摘录 button at the
		 * selection, which turns the exact passage into a board card.
		 */
		function Inspector({ width, selection, onOpen, onFork, onArchive, onDraft, onExcerpt, drafted, archived, fullTurn, floating, onClose, forking }) {
			const asideRef = React.useRef(null)
			const [picked, setPicked] = React.useState(null)

			React.useEffect(() => {
				const dismiss = () => setPicked(null)
				document.addEventListener('mousedown', dismiss)
				return () => document.removeEventListener('mousedown', dismiss)
			}, [])

			const onMouseUp = () => {
				if (!onExcerpt) return
				const selected = typeof window !== 'undefined' ? window.getSelection() : null
				if (!selected || selected.isCollapsed || selected.rangeCount === 0) {
					setPicked(null)
					return
				}
				const host = asideRef.current
				const anchor = selected.anchorNode
				const focus = selected.focusNode
				if (!host || !anchor || !focus || !host.contains(anchor) || !host.contains(focus)) {
					setPicked(null)
					return
				}
				const text = selected.toString().trim()
				if (text.length < 2) {
					setPicked(null)
					return
				}
				let rect = null
				try {
					rect = selected.getRangeAt(0).getBoundingClientRect()
				} catch (error) {
					rect = null
				}
				setPicked({
					text,
					left: rect ? rect.left + rect.width / 2 : 200,
					top: rect ? Math.max(48, rect.top - 8) : 200,
				})
			}

			if (!selection) {
				return h('aside', { ref: asideRef, onMouseUp, className: 'dst-inspector', 'data-floating': floating ? 'true' : 'false', style: width ? { width: `${width}px` } : undefined },
					h('div', { className: 'dst-placeholder' }, '点左侧任一轮次节点，这里显示它的完整提问与回答。'),
				)
			}
			const { turn, session } = selection
			const fullPrompt = fullTurn && fullTurn.p ? fullTurn.p : turn && turn.p
			const fullResponse = fullTurn && fullTurn.x ? fullTurn.x : turn && turn.x
			if (!turn) {
				return h('aside', { ref: asideRef, onMouseUp, className: 'dst-inspector', 'data-floating': floating ? 'true' : 'false', style: width ? { width: `${width}px` } : undefined },
					onClose ? h('button', { type: 'button', className: 'dst-insp-close', onClick: onClose, 'aria-label': '关闭' }, '×') : null,
				picked && onExcerpt && selection ? h('button', {
					type: 'button',
					className: 'dst-excerpt-btn',
					style: { left: `${picked.left}px`, top: `${picked.top}px` },
					onMouseDown: (event) => event.stopPropagation(),
					onClick: () => {
						onExcerpt({
							sessionId: selection.sessionId,
							sessionTitle: selection.session && selection.session.title,
							turnN: selection.turn ? selection.turn.n : null,
							text: picked.text,
						})
						const live = typeof window !== 'undefined' ? window.getSelection() : null
						if (live) live.removeAllRanges()
						setPicked(null)
					},
				}, `＋ 摘录 ${picked.text.length} 字到草稿板`) : null,
					h('div', { className: 'dst-insp-title' }, `${session.title} · 空分支`),
					h('div', { className: 'dst-insp-sub' }, shortId(session.id)),
					h('div', { className: 'dst-placeholder' }, '这个会话建立于切点之后，但没有产生任何自有轮次。'),
					h('div', { className: 'dst-insp-actions' },
						h('button', { type: 'button', className: 'dst-btn', onClick: () => onOpen(session.id) }, archived ? '恢复并打开' : '打开会话'),
						h('button', { type: 'button', className: 'dst-btn', onClick: () => onArchive(session.id) }, archived ? '取消归档' : '归档'),
					),
				)
			}
			const status = statusOf(turn)
			return h('aside', { ref: asideRef, onMouseUp, className: 'dst-inspector', 'data-floating': floating ? 'true' : 'false', style: width ? { width: `${width}px` } : undefined },
				onClose ? h('button', { type: 'button', className: 'dst-insp-close', onClick: onClose, 'aria-label': '关闭' }, '×') : null,
				picked && onExcerpt && selection ? h('button', {
					type: 'button',
					className: 'dst-excerpt-btn',
					style: { left: `${picked.left}px`, top: `${picked.top}px` },
					onMouseDown: (event) => event.stopPropagation(),
					onClick: () => {
						onExcerpt({
							sessionId: selection.sessionId,
							sessionTitle: selection.session && selection.session.title,
							turnN: selection.turn ? selection.turn.n : null,
							text: picked.text,
						})
						const live = typeof window !== 'undefined' ? window.getSelection() : null
						if (live) live.removeAllRanges()
						setPicked(null)
					},
				}, `＋ 摘录 ${picked.text.length} 字到草稿板`) : null,
				h('div', { className: 'dst-insp-title' }, `${session.title} · 第 ${turn.n} 轮`),
				h('div', { className: 'dst-insp-sub' },
					h('span', { style: { color: status.color } }, status.label),
					` · ${formatDuration(turn.d)} · ${turn.c ?? 0} 次工具 · 输出 ${turn.u ?? 0} tok · seq ${turn.s}→${turn.e ?? '—'}`,
				),
				h('div', { className: 'dst-insp-row' },
					h('div', { className: 'dst-insp-label' }, '提问'),
					h('div', { className: 'dst-insp-text' }, fullPrompt || '（无）'),
				),
				h('div', { className: 'dst-insp-row' },
					h('div', { className: 'dst-insp-label' }, '回答'),
					h('div', { className: 'dst-insp-text' }, fullResponse || '（无）'),
				),
				h('div', { className: 'dst-insp-actions' },
					h('button', { type: 'button', className: 'dst-btn', onClick: () => onOpen(session.id) }, archived ? '恢复并打开' : '打开会话'),
					turn.e != null && !archived
						? h('button', {
							type: 'button',
							className: 'dst-btn',
							disabled: forking === true,
							onClick: () => onFork(session.id, turn),
							title: forking === true ? '正在分叉，请稍候' : `从这里分叉，原会话保留`,
						}, forking === true ? '正在分叉…' : '⑂ 从此轮分叉')
						: null,
					h('button', {
						type: 'button',
						className: 'dst-btn',
						onClick: () => onDraft(session, turn),
						title: drafted ? '从草稿板移出这一轮' : '把这一轮的提问和回答收进草稿板',
					}, drafted ? '✓ 已在草稿板' : '＋ 收进草稿板'),
					h('button', {
						type: 'button',
						className: 'dst-btn',
						onClick: () => onArchive(session.id),
					}, archived ? '取消归档' : '归档'),
					archived ? h('span', { style: { color: 'var(--dsw-alias-label-secondary,#8b949e)', fontSize: 11 } }, '已归档，需先恢复') : null,
				),
			)
		}

		/* ------------------------------------------------------------- persisted */

		function readFlag(key, fallback) {
			try {
				const raw = window.sessionStorage.getItem(key)
				return raw === null ? fallback : raw === '1'
			} catch (error) {
				return fallback
			}
		}

		function writeFlag(key, value) {
			try {
				window.sessionStorage.setItem(key, value ? '1' : '0')
			} catch (error) {
				// private mode or a disabled storage backend: the toggle still works
			}
		}

		function TreeCanvas({ ctx, focusSessionId, workspaces, workspaceId, archivedIds }) {
			const scope = focusSessionId ? 'tab' : 'panel'
			const list = useListSnapshot(ctx)
			const [selected, setSelected] = React.useState(null)
			const [showAll, setShowAll] = React.useState(() => readFlag(`dsh-dst.showAll.${scope}`, !focusSessionId))
			const [hideEmpty, setHideEmpty] = React.useState(() => readFlag(`dsh-dst.hideEmpty.${scope}`, false))

			const initialLayout = React.useMemo(() => readLayout(scope), [scope])
			const [inspectorWidth, setInspectorWidth] = React.useState(initialLayout.inspectorWidth)
			const [drawerWidth, setDrawerWidth] = React.useState(initialLayout.drawerWidth)
			const [tocWidth, setTocWidth] = React.useState(initialLayout.tocWidth)
			const [tocCollapsed, setTocCollapsed] = React.useState(initialLayout.tocCollapsed === true)
			const [density, setDensity] = React.useState(initialLayout.density)
			const [zoom, setZoom] = React.useState(initialLayout.zoom)
			// Zoom is a compositor scale on the stage, not a layout size: keeping the
			// metrics density-only means a wheel tick never re-shapes the node text.
			const metrics = React.useMemo(() => makeMetrics(density), [density])
			const bodyRef = React.useRef(null)
			const tocWidthRef = React.useRef(tocWidth)
			const zoomRef = React.useRef(zoom)
			tocWidthRef.current = tocWidth
			zoomRef.current = zoom

			React.useEffect(() => {
				writeLayout(scope, { inspectorWidth, drawerWidth, tocWidth, tocCollapsed, density, zoom })
			}, [scope, inspectorWidth, drawerWidth, tocWidth, tocCollapsed, density, zoom])

			const resizeInspector = React.useCallback((delta) => {
				setInspectorWidth((current) => {
					const host = bodyRef.current
					const limit = host ? Math.max(320, host.clientWidth - 260) : 760
					return clampNumber(Math.round(current - delta), 280, Math.min(760, limit))
				})
			}, [])

			const resizeDrawer = React.useCallback((delta) => {
				setDrawerWidth((current) => {
					const host = bodyRef.current
					const limit = host ? Math.max(300, host.clientWidth - 320) : 720
					return clampNumber(Math.round(current - delta), 280, Math.min(720, limit))
				})
			}, [])

			const resizeToc = React.useCallback((delta) => {
				const next = Math.round(tocWidthRef.current + delta)
				if (next < 120) {
					setTocCollapsed(true)
					return
				}
				setTocCollapsed(false)
				setTocWidth(clampNumber(next, 150, 320))
			}, [])

			const [expanded, setExpanded] = React.useState(() => new Set())
			const [pickedWs, setPickedWs] = React.useState(null)
			const [notice, setNotice] = React.useState(null)
			const [boardOpen, setBoardOpen] = React.useState(false)
			/**
			 * One fork in flight at a time: the Host copies the whole inherited prefix
			 * (~4.6 MB for a 48-turn Session), so a second click would queue another
			 * full copy and flood the tree with duplicate branches.
			 */
			const [forking, setForking] = React.useState(null)
			const forkRef = React.useRef(false)
			const refs = React.useRef(new Map())
			const scroller = React.useRef(null)
			const requested = React.useRef(new Set())
			const zoomAnchor = React.useRef(null)
			const zoomQueue = React.useRef(null)
			const zoomFrame = React.useRef(0)

			React.useEffect(() => {
				writeFlag(`dsh-dst.showAll.${scope}`, showAll)
			}, [showAll, scope])

			React.useEffect(() => {
				writeFlag(`dsh-dst.hideEmpty.${scope}`, hideEmpty)
			}, [hideEmpty, scope])

			/**
			 * The stage under one viewport point: `fx`/`fy` are fractions of that
			 * stage's box, so the point survives any scale change without touching the
			 * layout math. Stages are few (one per root), so a linear scan is fine.
			 */
			const stageUnder = (host, viewX, viewY) => {
				let best = null
				for (const element of host.querySelectorAll('.dst-stage')) {
					const rect = element.getBoundingClientRect()
					if (rect.width <= 0 || rect.height <= 0) continue
					const outside = viewY < rect.top ? rect.top - viewY
						: viewY > rect.bottom ? viewY - rect.bottom : 0
					if (best === null || outside < best.outside) {
						best = {
							outside,
							element,
							fx: (viewX - rect.left) / rect.width,
							fy: (viewY - rect.top) / rect.height,
						}
						if (outside === 0) break
					}
				}
				return best
			}

			/**
			 * Record where the zoom point sits inside a stage before the scale changes;
			 * the layout effect below puts that same stage point back under it.
			 */
			const applyZoom = React.useCallback((delta, point) => {
				const next = clampNumber(Math.round((zoomRef.current + delta) * 200) / 200, MIN_ZOOM, MAX_ZOOM)
				if (next === zoomRef.current) return
				const host = scroller.current
				// Update the ref first: a burst of wheel events in one frame must not
				// each compute from the same stale zoom.
				zoomRef.current = next
				if (!host) {
					setZoom(next)
					return
				}
				const hostRect = host.getBoundingClientRect()
				const x = point ? point.x : host.clientWidth / 2
				const y = point ? point.y : host.clientHeight / 2
				const stage = stageUnder(host, hostRect.left + x, hostRect.top + y)
				zoomAnchor.current = stage === null ? null : { ...stage, x, y }
				setZoom(next)
			}, [])

			const zoomBy = React.useCallback((delta) => applyZoom(delta, null), [applyZoom])
			const zoomReset = React.useCallback(() => applyZoom(1 - zoomRef.current, null), [applyZoom])

			// One scale write per animation frame, however many wheel events arrive.
			const queueZoom = React.useCallback((delta, point) => {
				const queued = zoomQueue.current
				zoomQueue.current = { delta: (queued ? queued.delta : 0) + delta, point }
				if (zoomFrame.current !== 0) return
				zoomFrame.current = requestAnimationFrame(() => {
					zoomFrame.current = 0
					const job = zoomQueue.current
					zoomQueue.current = null
					if (!job) return
					applyZoom(clampNumber(job.delta, -0.1, 0.1), job.point)
				})
			}, [applyZoom])

			React.useEffect(() => () => {
				if (zoomFrame.current !== 0) cancelAnimationFrame(zoomFrame.current)
			}, [])

			React.useLayoutEffect(() => {
				const anchor = zoomAnchor.current
				if (!anchor) return
				zoomAnchor.current = null
				const host = scroller.current
				if (!host) return
				const rect = anchor.element.getBoundingClientRect()
				if (rect.width <= 0 || rect.height <= 0) return
				const hostRect = host.getBoundingClientRect()
				host.scrollLeft += (rect.left + anchor.fx * rect.width) - hostRect.left - anchor.x
				host.scrollTop += (rect.top + anchor.fy * rect.height) - hostRect.top - anchor.y
			}, [zoom])

			// Ctrl+wheel (and trackpad pinch) zooms the canvas instead of the host page.
			// Bound through the canvas ref callback: the empty state renders no canvas,
			// so a mount-time effect would miss the element that appears later.
			const wheelRef = React.useRef(null)
			const canvasObserver = React.useRef(null)
			const attachCanvas = React.useCallback((element) => {
				const previous = scroller.current
				if (previous && wheelRef.current) previous.removeEventListener('wheel', wheelRef.current)
				wheelRef.current = null
				if (canvasObserver.current) {
					canvasObserver.current.disconnect()
					canvasObserver.current = null
				}
				scroller.current = element || null
				if (!element || typeof element.addEventListener !== 'function') return
				// The section head is exactly as wide as the visible canvas, so it can
				// stay pinned to the left edge while the tree is panned sideways.
				const trackWidth = (width) => {
					if (width > 0) element.style.setProperty('--dst-canvas-w', `${width}px`)
				}
				trackWidth(element.clientWidth)
				if (typeof ResizeObserver === 'function') {
					const observer = new ResizeObserver((entries) => {
						const entry = entries[0]
						trackWidth(entry ? entry.contentRect.width : element.clientWidth)
					})
					observer.observe(element)
					canvasObserver.current = observer
				}
				const onWheel = (event) => {
					if (!event.ctrlKey) return
					event.preventDefault()
					const rect = element.getBoundingClientRect()
					const magnitude = clampNumber(Math.abs(event.deltaY) * 0.0005, 0.01, 0.05)
					queueZoom(event.deltaY < 0 ? magnitude : -magnitude, {
						x: event.clientX - rect.left - (element.clientLeft || 0),
						y: event.clientY - rect.top - (element.clientTop || 0),
					})
				}
				wheelRef.current = onWheel
				element.addEventListener('wheel', onWheel, { passive: false })
			}, [queueZoom])

			const toggleExpand = React.useCallback((id) => {
				setExpanded((previous) => {
					const next = new Set(previous)
					if (next.has(id)) next.delete(id)
					else next.add(id)
					return next
				})
			}, [])

			const collapseAll = React.useCallback(() => setExpanded(new Set()), [])
			const expandAll = React.useCallback(() => setShowAll(true), [])

			/**
			 * Arrow keys walk the canvas: up/down stay in the lane by row, left/right
			 * cross lanes at the same height. Everything is read back from the DOM, so
			 * no parallel index has to be kept in sync with the layout.
			 */
			const onCanvasKeyDown = React.useCallback((event) => {
				if (event.key === 'Escape') {
					setSelected(null)
					return
				}
				const isArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown'
					|| event.key === 'ArrowLeft' || event.key === 'ArrowRight'
				if (!isArrow) return
				const host = scroller.current
				if (!host) return
				const current = document.activeElement
				if (!current || !current.classList || !current.classList.contains('dst-node')) return
				const nodes = Array.from(host.querySelectorAll('.dst-node'))
				const lane = Number(current.dataset.lane)
				const col = Number(current.dataset.col)
				const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
				let target = null
				let best = null
				for (const node of nodes) {
					if (node === current) continue
					const otherLane = Number(node.dataset.lane)
					const otherCol = Number(node.dataset.col)
					if (vertical) {
						if (otherLane !== lane) continue
						const delta = otherCol - col
						if (event.key === 'ArrowUp' ? delta >= 0 : delta <= 0) continue
						if (best === null || Math.abs(delta) < best) { best = Math.abs(delta); target = node }
					} else {
						if (event.key === 'ArrowLeft' ? otherLane >= lane : otherLane <= lane) continue
						const score = Math.abs(otherLane - lane) * 1000 + Math.abs(otherCol - col)
						if (best === null || score < best) { best = score; target = node }
					}
				}
				if (!target) return
				event.preventDefault()
				target.focus()
			}, [])

			// Hovering shows the answer snippet that already rides the compact
			// projection; nothing extra is read for it.
			const hoverTimer = React.useRef(null)
			const [hovered, setHovered] = React.useState(null)
			const onHover = React.useCallback((sessionId, turnN) => {
				if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
				hoverTimer.current = setTimeout(() => {
					hoverTimer.current = null
					setHovered({ sessionId, turnN })
				}, 240)
			}, [])
			const onLeave = React.useCallback(() => {
				if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
				hoverTimer.current = null
				setHovered(null)
			}, [])
			React.useEffect(() => () => {
				if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
			}, [])

			/**
			 * Drag-to-pan. A press that travels more than a few pixels scrolls every
			 * scrollable ancestor (the canvas for horizontal, the host scroll body for
			 * vertical in the Tab scope) and swallows the click that would otherwise
			 * select the node under the cursor.
			 */
			const pan = React.useRef(null)
			const suppressClick = React.useRef(false)

			const onCanvasPointerDown = React.useCallback((event) => {
				suppressClick.current = false
				if (event.button !== 0) return
				const host = scroller.current
				if (!host) return
				if (event.target && typeof event.target.closest === 'function'
					&& event.target.closest('.dst-act, .dst-chip')) return
				const targets = []
				let element = host
				while (element) {
					const style = window.getComputedStyle(element)
					const scrollX = /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1
					const scrollY = /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
					if (scrollX || scrollY) {
						targets.push({
							element,
							left: element.scrollLeft,
							top: element.scrollTop,
							scrollX,
							scrollY,
						})
					}
					element = element.parentElement
				}
				if (targets.length === 0) return
				pan.current = { x: event.clientX, y: event.clientY, targets, moved: false, pointerId: event.pointerId, host }
			}, [])

			const onCanvasPointerMove = React.useCallback((event) => {
				const state = pan.current
				if (!state) return
				const dx = event.clientX - state.x
				const dy = event.clientY - state.y
				if (!state.moved) {
					if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
					state.moved = true
					suppressClick.current = true
					if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
					hoverTimer.current = null
					setHovered(null)
					state.host.classList.add('dst-canvas-dragging')
					try {
						state.host.setPointerCapture(state.pointerId)
					} catch (error) {
						// capture is an optimisation: the drag still tracks inside the canvas
					}
				}
				for (const target of state.targets) {
					if (target.scrollX) target.element.scrollLeft = target.left - dx
					if (target.scrollY) target.element.scrollTop = target.top - dy
				}
			}, [])

			const endPan = React.useCallback(() => {
				const state = pan.current
				pan.current = null
				if (!state) return
				state.host.classList.remove('dst-canvas-dragging')
				try {
					state.host.releasePointerCapture(state.pointerId)
				} catch (error) {
					// nothing was captured
				}
			}, [])

			const onCanvasClickCapture = React.useCallback((event) => {
				if (!suppressClick.current) return
				suppressClick.current = false
				event.stopPropagation()
				event.preventDefault()
			}, [])

			React.useEffect(() => {
				if (!notice) return undefined
				const timer = setTimeout(() => setNotice(null), 6000)
				return () => clearTimeout(timer)
			}, [notice])

			const activeWorkspace = React.useMemo(() => {
				if (!workspaces || workspaces.length === 0) return null
				const chosen = workspaces.find((item) => item.workspaceId === pickedWs)
				if (chosen) return chosen
				let best = workspaces[0]
				let bestAt = -1
				for (const item of workspaces) {
					for (const id of item.sessionIds || []) {
						const at = list.byId?.[id]?.updatedAt ?? 0
						if (at > bestAt) { bestAt = at; best = item }
					}
				}
				return best
			}, [workspaces, pickedWs, list])

			const allowedIds = React.useMemo(() => (
				activeWorkspace ? new Set(activeWorkspace.sessionIds || []) : null
			), [activeWorkspace])

			const model = React.useMemo(() => buildModel(list, allowedIds), [list, allowedIds])
			// Fork checks read the current model without making the callback identity
			// follow every list update (that would re-render every memoized section).
			const modelRef = React.useRef(model)
			modelRef.current = model
			const focus = focusSessionId ? model.byId.get(focusSessionId) : null
			const pending = model.nodes.filter((node) => !node.ready)
			const runningCount = model.nodes.filter((node) => node.running).length
			const resolvedWorkspaceId = (activeWorkspace && activeWorkspace.workspaceId) || workspaceId || ''
			const drafts = useDrafts(resolvedWorkspaceId)
			const draftKeys = React.useMemo(() => new Set(drafts.map((item) => item.id)), [drafts])

			const sections = React.useMemo(() => {
				if (focus) return [[focus, ...ancestorsOf(focus)].pop()]
				return model.roots
			}, [focus, model])

			// A read returns every projection key of a Session, full text included, so
			// this pass is limited to rows that carry no value at all. Full text is
			// fetched by the selection effect below, one Session at a time.
			React.useEffect(() => {
				for (const node of model.nodes) {
					if (node.ready || requested.current.has(node.id)) continue
					requested.current.add(node.id)
					Promise.resolve(ctx.sessions.refreshProjections(node.id)).catch(() => {})
				}
			}, [model])

			// Full prompt/response text lives in the non-summary unit, so it is read
			// only for the Session whose inspector is open.
			React.useEffect(() => {
				const sessionId = selected && selected.sessionId
				if (!sessionId) return
				if (list.projectionsBySession?.[sessionId]?.values?.branchTreeFull !== undefined) return
				Promise.resolve(ctx.sessions.refreshProjections(sessionId)).catch(() => {})
			}, [selected, list, ctx])

			const registerRef = React.useCallback((id, element) => {
				if (element) refs.current.set(id, element)
				else refs.current.delete(id)
			}, [])

			const archivedSet = React.useMemo(() => new Set(archivedIds || []), [archivedIds])
			const isArchived = React.useCallback((id) => archivedSet.has(id), [archivedSet])

			const openSession = React.useCallback((id) => {
				if (!archivedSet.has(id)) {
					ctx.uiWorkspace.openSession(id)
					return
				}
				Promise.resolve(ctx.uiWorkspace.unarchiveSession(id))
					.catch(() => {})
					.then(() => ctx.uiWorkspace.openSession(id))
			}, [ctx, archivedSet])

			/**
			 * Fork a Session right after one closed Turn. The original keeps its own
			 * line in the graph: archiving it here would delete the branch point the
			 * user is standing on.
			 */
			const forkTurn = React.useCallback(async (sessionId, turn) => {
				if (forkRef.current) return
				if (!turn || turn.e == null) {
					setNotice({ text: '这一轮还没结束，不能在这里分叉' })
					return
				}
				if (archivedSet.has(sessionId)) {
					setNotice({ text: '已归档的会话不能分叉，请先恢复' })
					return
				}
				// Only an unarchived fork that never grew a turn of its own is worth
				// asking about: it is either the result of a slow click or a branch the
				// user deliberately kept empty. A used or archived branch is not a
				// duplicate, so the fork proceeds without a dialog.
				const emptyForks = modelRef.current.nodes.filter((node) => (
					node.cut === turn.e + 1
					&& ancestorsOf(node).some((item) => item.id === sessionId)
					&& !archivedSet.has(node.id)
					&& !node.turns.some((item) => (item.s ?? 0) >= node.cut)
				))
				if (emptyForks.length > 0 && typeof window !== 'undefined') {
					const names = emptyForks.map((node) => shortId(node.id)).join('、')
					if (!window.confirm(`这个位置还有 ${emptyForks.length} 个未归档的空分叉（${names}），还要再分叉一次吗？`)) return
				}
				forkRef.current = true
				setForking({ sessionId, turnN: turn.n })
				setNotice({ text: `正在从第 ${turn.n} 轮分叉，请稍候…` })
				try {
					const childId = await ctx.sessions.fork({ sessionId, atSeq: turn.e, increaseTitle: true })
					setSelected(null)
					setNotice({ kind: 'ok', text: `已从第 ${turn.n} 轮分叉 → ${shortId(childId)}` })
					ctx.uiWorkspace.openSession(childId)
				} catch (error) {
					setNotice({ text: `分叉失败：${(error && error.message) || String(error)}` })
				} finally {
					forkRef.current = false
					setForking(null)
				}
			}, [ctx, archivedSet])

			const archiveSession = React.useCallback((sessionId) => {
				const archived = archivedSet.has(sessionId)
				if (!archived && typeof window !== 'undefined'
					&& !window.confirm(`归档 ${shortId(sessionId)}？归档后不能打开，之后可以在分支树里恢复。`)) return
				const action = archived
					? ctx.uiWorkspace.unarchiveSession(sessionId)
					: ctx.uiWorkspace.archiveSession(sessionId)
				Promise.resolve(action)
					.then(() => setNotice({ kind: 'ok', text: archived ? '已取消归档' : '已归档' }))
					.catch((error) => setNotice({ text: `操作失败：${(error && error.message) || String(error)}` }))
			}, [ctx, archivedSet])

			/**
			 * Collect one Turn into the workspace draft board. The full text lives in a
			 * non-summary unit, so a Session that was never inspected is read first and
			 * the node preview stands in until that read lands.
			 */
			const addToDrafts = React.useCallback((node, turn) => {
				if (!turn) return
				if (!resolvedWorkspaceId) {
					setNotice({ text: '这个会话不属于任何工作区，没法放进草稿板' })
					return
				}
				const group = activeGroupOf(resolvedWorkspaceId)
				if (group === null) {
					setNotice({ text: '草稿板还没有组，先打开草稿板新建一个' })
					return
				}
				const id = `${node.id}:${turn.n}`
				if (draftKeys.has(id)) {
					removeDraft(resolvedWorkspaceId, group.id, id)
					setNotice({ kind: 'ok', text: `已从「${group.name}」移除 T${turn.n}` })
					return
				}
				const readFull = () => {
					const turns = list.projectionsBySession?.[node.id]?.values?.branchTreeFull?.turns
					if (!Array.isArray(turns)) return null
					return turns.find((item) => item.n === turn.n) || null
				}
				const commit = () => {
					const full = readFull()
					addDraft(resolvedWorkspaceId, group.id, {
						id,
						kind: 'turn',
						sessionId: node.id,
						sessionTitle: node.title,
						turnN: turn.n,
						prompt: (full && full.p) || turn.p || '',
						response: (full && full.x) || turn.x || '',
						truncated: full === null,
						at: Date.now(),
					})
					setNotice({ kind: 'ok', text: `已收进「${group.name}」 · T${turn.n}` })
				}
				if (readFull()) commit()
				else Promise.resolve(ctx.sessions.refreshProjections(node.id)).then(commit, commit)
			}, [ctx, list, resolvedWorkspaceId, draftKeys])

			/** A text selection inside the inspector becomes its own board card. */
			const addExcerpt = React.useCallback((payload) => {
				if (!resolvedWorkspaceId) {
					setNotice({ text: '这个会话不属于任何工作区，没法放进草稿板' })
					return
				}
				const group = activeGroupOf(resolvedWorkspaceId)
				if (group === null) {
					setNotice({ text: '草稿板还没有组，先打开草稿板新建一个' })
					return
				}
				addDraft(resolvedWorkspaceId, group.id, {
					id: `excerpt:${payload.sessionId}:${Date.now()}`,
					kind: 'excerpt',
					sessionId: payload.sessionId,
					sessionTitle: payload.sessionTitle,
					turnN: payload.turnN,
					text: payload.text,
					at: Date.now(),
				})
				setNotice({ kind: 'ok', text: `已摘录 ${payload.text.length} 字到「${group.name}」` })
			}, [resolvedWorkspaceId])

			/**
			 * The draft board lives in the right Sidebar, which is per Session: a global
			 * main panel has no Session on screen, so the column has nothing to open into.
			 * There the board renders in this page instead, so it is never unreachable.
			 */
			const openDrafts = React.useCallback(() => {
				const mounted = ctx.sidebarRight && ctx.sidebarRight.mounted
				const onScreen = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
				if (!onScreen) {
					setBoardOpen((open) => !open)
					return
				}
				try {
					ctx.sidebarRight.openTab(DRAFT_KIND)
				} catch (error) {
					setBoardOpen((open) => !open)
					setNotice({ text: `右侧栏打不开，暂时在这里显示：${(error && error.message) || String(error)}` })
				}
			}, [ctx])

			const jump = React.useCallback((id) => {
				const element = refs.current.get(id)
				if (!element || !scroller.current) return
				scroller.current.scrollTo({ top: element.offsetTop - 4, behavior: 'smooth' })
			}, [])

			const loadAll = React.useCallback(() => {
				for (const node of pending) {
					Promise.resolve(ctx.sessions.refreshProjections(node.id)).catch(() => {})
				}
			}, [pending, ctx])

			const bar = h('div', { className: 'dst-bar' },
				h('strong', null, focus ? '分支树' : '全部分支'),
				workspaces && workspaces.length > 0 ? h('select', {
					className: 'dst-select',
					value: activeWorkspace ? activeWorkspace.workspaceId : '',
					onChange: (event) => setPickedWs(event.target.value),
					title: activeWorkspace ? activeWorkspace.path : '',
				}, workspaces.map((item) => h('option', {
					key: item.workspaceId,
					value: item.workspaceId,
				}, `${item.title} · ${(item.sessionIds || []).length}`))) : null,
				h('span', null, `${model.nodes.length} 个会话`),
				h('select', {
					className: 'dst-select',
					style: { maxWidth: '92px' },
					value: density,
					onChange: (event) => setDensity(event.target.value),
					title: '节点密度',
				}, [['compact', '紧凑'], ['normal', '标准'], ['roomy', '宽松']].map(([value, label]) => h('option', {
					key: value,
					value,
				}, label))),
				h('div', { className: 'dst-zoom' },
					h('button', {
						type: 'button',
						className: 'dst-act',
						title: '缩小（也可 Ctrl+滚轮）',
						onClick: () => zoomBy(-0.05),
					}, '−'),
					h('button', {
						type: 'button',
						className: 'dst-zoom-val',
						title: '重置缩放',
						onClick: () => zoomReset(),
					}, `${Math.round(zoom * 100)}%`),
					h('button', {
						type: 'button',
						className: 'dst-act',
						title: '放大（也可 Ctrl+滚轮）',
						onClick: () => zoomBy(0.05),
					}, '＋')),
				runningCount > 0 ? h('span', { className: 'dst-running' }, `${runningCount} 个进行中`) : null,
				h('span', { className: 'dst-grow' }),
				notice ? h('span', {
					className: 'dst-note',
					'data-kind': notice.kind || 'warn',
					title: notice.text,
				}, notice.text) : null,
				pending.length > 0 ? h('button', {
					type: 'button',
					className: 'dst-btn',
					onClick: loadAll,
				}, `载入其余 ${pending.length} 个`) : null,
				expanded.size > 0 ? h('button', {
					type: 'button',
					className: 'dst-btn',
					onClick: collapseAll,
				}, `收起额外 ${expanded.size} 条`) : null,
				h('button', {
					type: 'button',
					className: 'dst-btn',
					'data-on': boardOpen || drafts.length > 0 ? 'true' : 'false',
					onClick: openDrafts,
					title: boardOpen ? '收起内嵌草稿板' : '打开草稿板',
				}, drafts.length > 0 ? `草稿板 ${drafts.length}` : '草稿板'),
				h('button', {
					type: 'button',
					className: 'dst-btn',
					'data-on': hideEmpty ? 'true' : 'false',
					onClick: () => setHideEmpty((value) => !value),
					title: hideEmpty ? '显示没有自己轮次的分支' : '隐藏没有自己轮次的分支（空分叉）',
				}, hideEmpty ? '显示空分支' : '不显示空分支'),
				focus ? h('button', {
					type: 'button',
					className: 'dst-btn',
					'data-on': showAll ? 'true' : 'false',
					onClick: () => setShowAll((value) => !value),
				}, showAll ? '只看当前分支' : '显示全部分支') : null,
			)

			const rootProps = {
				className: 'dst-root',
				'data-scope': scope,
				'data-density': metrics.density,
				style: {
					'--dst-font': `${metrics.font}px`,
					'--dst-node-w': `${metrics.nodeW}px`,
					'--dst-node-h': `${metrics.nodeH}px`,
					'--dst-prompt-lines': String(metrics.lines),
					'--dst-zoom': String(zoom),
				},
			}

			if (!model.nodes.length) {
				return h('div', rootProps, bar,
					h('div', { className: 'dst-empty' }, '这个工作区还没有会话。'))
			}

			return h('div', rootProps,
				bar,
				h('div', { className: 'dst-body', ref: bodyRef },
					h('nav', {
						className: 'dst-toc',
						'data-collapsed': tocCollapsed ? 'true' : 'false',
						style: { width: `${tocCollapsed ? 26 : tocWidth}px` },
					},
						tocCollapsed
							? h('button', {
								type: 'button',
								className: 'dst-toc-toggle',
								title: '展开目录',
								onClick: () => setTocCollapsed(false),
							}, '»')
							: [
								h('div', { key: 'title', className: 'dst-toc-title' }, '目录'),
								sections.map((root) => h('button', {
									key: root.id,
									type: 'button',
									className: 'dst-toc-item',
									'data-active': focus && root.id === focus.id ? 'true' : 'false',
									onClick: () => jump(root.id),
									title: root.title,
								}, root.title)),
								h('div', { key: 'hint', className: 'dst-toc-hint' }, selected
									? '点详情面板的 × 关掉'
									: '点任一节点，右侧展开完整提问与回答'),
								h('button', {
									key: 'collapse',
									type: 'button',
									className: 'dst-toc-toggle',
									title: '收起目录',
									onClick: () => setTocCollapsed(true),
								}, '«'),
							],
					),
					tocCollapsed ? null : h(Splitter, {
						orientation: 'vertical',
						label: '目录宽度',
						onDelta: resizeToc,
						onReset: () => {
							setTocCollapsed(false)
							setTocWidth(DEFAULT_LAYOUT.tocWidth)
						},
					}),
					h('div', {
						className: 'dst-canvas',
						ref: attachCanvas,
						onKeyDown: onCanvasKeyDown,
						onPointerDown: onCanvasPointerDown,
						onPointerMove: onCanvasPointerMove,
						onPointerUp: endPan,
						onPointerCancel: endPan,
						onClickCapture: onCanvasClickCapture,
					},
						h('div', { className: 'dst-sections' },
							sections.map((root) => h(Section, {
								key: root.id,
								root,
								byId: model.byId,
								focusId: focusSessionId,
								showAll,
								hideEmpty,
								metrics,
								expandedIds: expanded,
								hovered,
								onHover,
								onLeave,
								onSelect: setSelected,
								onExpand: expandAll,
								onToggleExpand: toggleExpand,
								selected,
								registerRef,
								isArchived,
								draftedKeys: draftKeys,
								forking: forking !== null,
								onOpen: openSession,
								onFork: forkTurn,
								onArchive: archiveSession,
								onDraft: addToDrafts,
							})),
						),
					),
					boardOpen ? h(Splitter, {
						orientation: 'vertical',
						label: '草稿板宽度',
						onDelta: resizeDrawer,
						onReset: () => setDrawerWidth(DEFAULT_LAYOUT.drawerWidth),
					}) : null,
					boardOpen ? h('aside', {
						className: 'dst-drawer',
						style: { width: `${drawerWidth}px` },
					},
						h(DraftBoardView, {
							ctx,
							workspaceId: resolvedWorkspaceId,
							onClose: () => setBoardOpen(false),
						})) : null,
					selected ? h(Splitter, {
						orientation: 'vertical',
						label: '详情栏宽度',
						onDelta: resizeInspector,
						onReset: () => setInspectorWidth(DEFAULT_LAYOUT.inspectorWidth),
					}) : null,
					selected ? h(Inspector, {
						width: inspectorWidth,
						selection: selected,
						onOpen: openSession,
						onFork: forkTurn,
						onArchive: archiveSession,
						onDraft: addToDrafts,
						onExcerpt: addExcerpt,
						drafted: selected.turn ? draftKeys.has(`${selected.sessionId}:${selected.turn.n}`) : false,
						archived: isArchived(selected.sessionId),
						fullTurn: selected.turn
							? (list.projectionsBySession?.[selected.sessionId]?.values?.branchTreeFull?.turns || []).find((item) => item.n === selected.turn.n) || null
							: null,
						floating: Boolean(focusSessionId),
						forking: forking !== null,
						onClose: () => setSelected(null),
					}) : null,
				),
			)
			}

			function DraftCard({ item, editing, dragging, dropTarget, picked, onTogglePick, onStartEdit, onCancelEdit, onChangeEdit, onSaveEdit, onDragStart, onDragEnd, onDragOver, onDrop, onRemove }) {
				const open = editing !== null && editing.id === item.id
				const isExcerpt = item.kind === 'excerpt'
				return h('li', {
					className: 'dst-board-item',
					'data-picked': picked ? 'true' : 'false',
					draggable: open ? false : true,
					'data-dragging': dragging ? 'true' : 'false',
					'data-drop': dropTarget ? 'true' : 'false',
					onDragStart: (event) => {
						if (open) return
						event.dataTransfer.effectAllowed = 'move'
						try {
							event.dataTransfer.setData('text/plain', item.id)
						} catch (error) {
							// Firefox needs a payload; older engines may refuse
						}
						onDragStart(item.id)
					},
					onDragEnd,
					onDragOver: (event) => {
						if (open) return
						event.preventDefault()
						event.dataTransfer.dropEffect = 'move'
						onDragOver(item.id)
					},
					onDrop: (event) => {
						event.preventDefault()
						onDrop(item.id)
					},
				},
					h('div', { className: 'dst-board-item-head' },
						h('input', {
							type: 'checkbox',
							className: 'dst-pick',
							checked: picked,
							title: picked ? '不拼进提示词' : '拼进提示词',
							onChange: () => onTogglePick(item.id),
							onClick: (event) => event.stopPropagation(),
						}),
						h('span', { className: 'dst-board-grip', title: '拖动排序' }, '⋮⋮'),
						h('b', null, isExcerpt ? '摘录' : `T${item.turnN}`),
						h('span', { className: 'dst-board-item-title', title: item.sessionTitle }, item.sessionTitle || shortId(item.sessionId)),
						item.edited ? h('span', { className: 'dst-board-badge', title: '文字改过：以纯文本引用进入提示词' }, '已改') : null,
						item.truncated ? h('span', { className: 'dst-board-badge', title: '还没取到全文，这里只是节点上的预览' }, '预览') : null,
						h('span', { className: 'dst-grow' }),
						open
							? null
							: h('button', {
								type: 'button',
								className: 'dst-act',
								title: '点开编辑',
								onClick: () => onStartEdit(item),
							}, '✎'),
						h('button', {
							type: 'button',
							className: 'dst-act',
							'data-danger': 'true',
							title: '移出草稿板',
							onClick: () => onRemove(item.id),
						}, '×'),
					),
					open
						? h('div', { className: 'dst-board-edit' },
							isExcerpt
								? h('textarea', {
									className: 'dst-board-edit-text',
									value: editing.text,
									rows: 5,
									autoFocus: true,
									onChange: (event) => onChangeEdit({ text: event.target.value }),
								})
								: [
									h('div', { key: 'p', className: 'dst-board-edit-label' }, '提问'),
									h('textarea', {
										key: 'pt',
										className: 'dst-board-edit-text',
										value: editing.prompt,
										rows: 3,
										autoFocus: true,
										onChange: (event) => onChangeEdit({ prompt: event.target.value }),
									}),
									h('div', { key: 'r', className: 'dst-board-edit-label' }, '回答'),
									h('textarea', {
										key: 'rt',
										className: 'dst-board-edit-text',
										value: editing.response,
										rows: 6,
										onChange: (event) => onChangeEdit({ response: event.target.value }),
									}),
								],
							h('div', { className: 'dst-board-edit-actions' },
								h('button', { type: 'button', className: 'dst-btn', onClick: onSaveEdit }, '保存'),
								h('button', { type: 'button', className: 'dst-btn', onClick: onCancelEdit }, '取消'),
							),
						)
						: h('div', {
							className: 'dst-board-text-body',
							onClick: () => onStartEdit(item),
							title: '点开编辑',
						},
							isExcerpt
								? h('div', { className: 'dst-board-prompt' }, item.text || '（空摘录）')
								: [
									item.prompt ? h('div', { key: 'p', className: 'dst-board-prompt' }, item.prompt) : null,
									item.response ? h('div', { key: 'r', className: 'dst-board-resp' }, item.response) : null,
								],
						),
				)
			}

			/**
			 * One small modal inside the board: create or rename a group. The name starts
			 * selected so typing replaces it; Enter confirms and Escape cancels.
			 */
			function GroupDialog({ title, initial, onConfirm, onCancel }) {
				const [value, setValue] = React.useState(initial)
				const inputRef = React.useRef(null)

				React.useEffect(() => {
					const input = inputRef.current
					if (input === null) return
					input.focus()
					input.select()
				}, [])

				const confirm = () => {
					const name = value.trim()
					onConfirm(name === '' ? initial : name)
				}

				return h('div', {
					className: 'dst-dialog-mask',
					onPointerDown: (event) => {
						if (event.target === event.currentTarget) onCancel()
					},
				},
					h('div', { className: 'dst-dialog' },
						h('div', { className: 'dst-dialog-title' }, title),
						h('input', {
							ref: inputRef,
							className: 'dst-dialog-input',
							value,
							onChange: (event) => setValue(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') {
									event.preventDefault()
									confirm()
								} else if (event.key === 'Escape') {
									event.preventDefault()
									onCancel()
								}
							},
						}),
						h('div', { className: 'dst-dialog-actions' },
							h('button', { type: 'button', className: 'dst-btn', onClick: onCancel }, '取消'),
							h('button', { type: 'button', className: 'dst-btn', 'data-primary': 'true', onClick: confirm }, '确定'),
						),
					),
				)
			}

			/** Searchable group switcher: current name on the trigger, list plus create in the popover. */
			function GroupPicker({ groups, activeId, onSelect, onCreate, onRename, onDelete }) {
				const [open, setOpen] = React.useState(false)
				const [query, setQuery] = React.useState('')
				const [cursor, setCursor] = React.useState(0)
				const rootRef = React.useRef(null)
				const active = groups.find((group) => group.id === activeId) || groups[0] || null
				const filtered = React.useMemo(() => {
					const needle = query.trim().toLowerCase()
					if (needle === '') return groups
					return groups.filter((group) => group.name.toLowerCase().includes(needle))
				}, [groups, query])

				React.useEffect(() => {
					if (!open) return undefined
					const onDown = (event) => {
						if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
					}
					document.addEventListener('pointerdown', onDown, true)
					return () => document.removeEventListener('pointerdown', onDown, true)
				}, [open])

				React.useEffect(() => {
					setCursor(0)
				}, [query, open])

				if (active === null) return null
				const choose = (id) => {
					setOpen(false)
					onSelect(id)
				}
				const create = () => {
					setOpen(false)
					onCreate(query.trim())
				}
				return h('div', { className: 'dst-group', ref: rootRef },
					h('button', {
						type: 'button',
						className: 'dst-group-trigger',
						title: '切换或新建组',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value) => !value),
					},
						h('span', { className: 'dst-group-name' }, active.name),
						h('span', { className: 'dst-group-caret' }, '▾'),
					),
					open ? h('div', { className: 'dst-group-pop' },
						h('input', {
							className: 'dst-group-search',
							value: query,
							autoFocus: true,
							placeholder: '搜索组…',
							onChange: (event) => setQuery(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'ArrowDown') {
									event.preventDefault()
									setCursor((value) => Math.min(value + 1, Math.max(filtered.length - 1, 0)))
								} else if (event.key === 'ArrowUp') {
									event.preventDefault()
									setCursor((value) => Math.max(value - 1, 0))
								} else if (event.key === 'Enter') {
									event.preventDefault()
									const target = filtered[cursor]
									if (target !== undefined) choose(target.id)
									else create()
								} else if (event.key === 'Escape') {
									event.preventDefault()
									setOpen(false)
								}
							},
						}),
						h('ul', { className: 'dst-group-list' },
							filtered.length === 0
								? h('li', { className: 'dst-group-empty' }, '没有匹配的组')
								: filtered.map((group, index) => h('li', {
									key: group.id,
									className: 'dst-group-row',
									'data-active': group.id === activeId ? 'true' : 'false',
									'data-cursor': index === cursor ? 'true' : 'false',
									onPointerDown: (event) => {
										event.preventDefault()
										choose(group.id)
									},
								},
									h('span', { className: 'dst-group-row-name' }, group.name),
									h('span', { className: 'dst-group-count' }, String(group.items.length)),
									h('button', {
										type: 'button',
										className: 'dst-act',
										title: '重命名',
										onPointerDown: (event) => {
											event.preventDefault()
											event.stopPropagation()
											setOpen(false)
											onRename(group)
										},
									}, '✎'),
									groups.length > 1 ? h('button', {
										type: 'button',
										className: 'dst-act',
										'data-danger': 'true',
										title: '删除组和组里的卡片',
										onPointerDown: (event) => {
											event.preventDefault()
											event.stopPropagation()
											setOpen(false)
											onDelete(group)
										},
									}, '×') : null,
								)),
						),
						h('button', {
							type: 'button',
							className: 'dst-group-new',
							onPointerDown: (event) => {
								event.preventDefault()
								create()
							},
						}, '＋ 新建组…'),
					) : null,
				)
			}

			/** The Session the main column currently shows; undefined when a panel fills it. */
			function useMountedSession(ctx) {
				const subscribe = React.useCallback((listener) => {
					const mounted = ctx.sidebarRight && ctx.sidebarRight.mounted
					if (!mounted || typeof mounted.subscribe !== 'function') return () => {}
					return mounted.subscribe(listener)
				}, [ctx])
				const getSnapshot = React.useCallback(() => {
					const mounted = ctx.sidebarRight && ctx.sidebarRight.mounted
					if (!mounted || typeof mounted.getSnapshot !== 'function') return undefined
					return mounted.getSnapshot()
				}, [ctx])
				return React.useSyncExternalStore(subscribe, getSnapshot)
			}

			/**
			 * The board is workspace-scoped, but its only door was the right Sidebar,
			 * which is per Session: a global main panel has no Session on screen, so
			 * that column cannot host it. This view therefore takes the workspace id
			 * from its host and is what both the Sidebar tab and the in-page drawer render.
			 */
			function DraftBoardView({ ctx, workspaceId, onClose }) {
				const board = useBoard(workspaceId)
				const active = board.groups.find((group) => group.id === board.activeGroupId) || board.groups[0] || null
				const items = active === null ? EMPTY_DRAFTS : active.items
				const plan = React.useMemo(() => buildPlan(items), [items])
				const pickedCount = React.useMemo(() => items.filter((item) => item.picked !== false).length, [items])
				const preview = active !== null && active.manual === true ? active.text : plan.text
				const sessionId = useMountedSession(ctx)
				const [flash, setFlash] = React.useState('')
				const [editing, setEditing] = React.useState(null)
				const [boardSplit, setBoardSplit] = React.useState(() => readLayout('board').boardSplit)
				const [dragging, setDragging] = React.useState(null)
				const [dropTarget, setDropTarget] = React.useState(null)
				const [dialog, setDialog] = React.useState(null)
				const dragged = React.useRef(false)
				const filling = React.useRef(false)
				const groupId = active === null ? '' : active.id

				React.useEffect(() => {
					if (!flash) return undefined
					const timer = setTimeout(() => setFlash(''), 1800)
					return () => clearTimeout(timer)
				}, [flash])

				React.useEffect(() => {
					writeLayout('board', { boardSplit })
				}, [boardSplit])

				React.useEffect(() => {
					setEditing(null)
					setDragging(null)
					setDropTarget(null)
					setDialog(null)
				}, [workspaceId, groupId])

				const saveEdit = () => {
					if (editing === null || active === null) return
					updateDraft(workspaceId, active.id, editing.id, editing.kind === 'excerpt'
						? { text: editing.text }
						: { prompt: editing.prompt, response: editing.response, truncated: false })
					setEditing(null)
				}

				const fill = () => {
					if (filling.current || active === null) return
					if (!sessionId) {
						setFlash('当前没有打开的会话')
						return
					}
					const target = active.manual === true
						? { segments: [{ t: 'text', text: active.text }], text: active.text }
						: plan
					if (target.segments.length === 0 || target.text.trim() === '') {
						setFlash(active.manual === true ? '拼装内容为空' : '没有勾选可拼装的卡片')
						return
					}
					filling.current = true
					try {
						const result = fillSession(sessionId, target)
						const messages = {
							done: '已填入当前会话',
							degraded: '已填入，部分内容为纯文本',
							stalled: '填入中断，内容可能不完整',
							blocked: '输入框正忙，稍后再试',
							'no-input': '没找到当前会话的输入框',
							empty: '拼装内容为空',
							preserved: '草稿没有改动',
						}
						setFlash(messages[result] || '没有填入')
					} catch (error) {
						setFlash(`填入失败：${(error && error.message) || String(error)}`)
					} finally {
						filling.current = false
					}
				}

				const clearGroup = () => {
					if (active === null || active.items.length === 0) return
					if (!window.confirm(`清空「${active.name}」里的 ${active.items.length} 张卡片？`)) return
					patchGroup(workspaceId, active.id, { items: [] })
				}

				const openCreate = (seedName) => {
					setDialog({ mode: 'create', value: seedName || `组 ${board.groups.length + 1}` })
				}

				const confirmDialog = (name) => {
					if (dialog === null) return
					if (dialog.mode === 'create') addGroup(workspaceId, name)
					else renameGroup(workspaceId, dialog.id, name)
					setDialog(null)
				}

				const fillDisabled = active === null || !sessionId || preview.trim() === ''
				const fillReason = active === null ? '草稿板没有组'
					: !sessionId ? '当前没有打开的会话'
						: preview.trim() === ''
							? (active.manual === true ? '拼装内容为空' : '先勾选要拼进去的卡片')
							: '追加到当前会话的输入框'

				return h('div', { className: 'dst-board' },
					h('div', { className: 'dst-board-head' },
						h('strong', null, '草稿板'),
						active !== null ? h(GroupPicker, {
							groups: board.groups,
							activeId: active.id,
							onSelect: (id) => setActiveGroup(workspaceId, id),
							onCreate: openCreate,
							onRename: (group) => setDialog({ mode: 'rename', id: group.id, value: group.name }),
							onDelete: (group) => {
								if (group.items.length > 0
									&& !window.confirm(`删除「${group.name}」和组里的 ${group.items.length} 张卡片？`)) return
								if (!deleteGroup(workspaceId, group.id)) setFlash('至少要保留一个组')
							},
						}) : h('span', { className: 'dst-board-count' }, '未关联工作区'),
						h('span', { className: 'dst-grow' }),
						flash ? h('span', { className: 'dst-running' }, flash) : null,
						active !== null && items.length > 0 ? h('button', {
							type: 'button',
							className: 'dst-btn',
							onClick: clearGroup,
						}, '清空') : null,
						onClose ? h('button', {
							type: 'button',
							className: 'dst-act',
							title: '收起草稿板',
							onClick: onClose,
						}, '×') : null,
					),
					h('div', { className: 'dst-board-body' },
						active === null
							? h('div', { className: 'dst-board-empty' }, '这个面板没有关联到工作区，草稿板不可用。')
							: items.length === 0
								? h('div', { className: 'dst-board-empty' },
									'当前组还没有卡片。',
									h('br'),
									'在分支树的节点上点 ＋，或者选中详情里的文字点「摘录」。',
									h('br'),
									'顶部可以切换或新建组，组之间互不影响。')
								: h('ul', { className: 'dst-board-list' }, items.map((item) => h(DraftCard, {
									key: item.id,
									item,
									editing,
									picked: item.picked !== false,
									dragging: dragging === item.id,
									dropTarget: dropTarget === item.id,
									onTogglePick: (id) => togglePick(workspaceId, active.id, id),
									onStartEdit: (target) => {
										if (dragged.current) return
										setEditing(target.kind === 'excerpt'
											? { id: target.id, kind: 'excerpt', text: target.text || '' }
											: { id: target.id, kind: 'turn', prompt: target.prompt || '', response: target.response || '' })
									},
									onCancelEdit: () => setEditing(null),
									onChangeEdit: (patch) => setEditing((current) => (current === null ? null : { ...current, ...patch })),
									onSaveEdit: saveEdit,
									onRemove: (id) => {
										if (editing !== null && editing.id === id) setEditing(null)
										removeDraft(workspaceId, active.id, id)
									},
									onDragStart: (id) => {
										dragged.current = true
										setDragging(id)
									},
									onDragEnd: () => {
										setDragging(null)
										setDropTarget(null)
										setTimeout(() => {
											dragged.current = false
										}, 0)
									},
									onDragOver: (id) => {
										if (dragging !== null && dragging !== id) setDropTarget(id)
									},
									onDrop: (id) => {
										if (dragging !== null) reorderDraft(workspaceId, active.id, dragging, id)
										setDragging(null)
										setDropTarget(null)
									},
								}))),
					),
					h(Splitter, {
						orientation: 'horizontal',
						label: '拼装区高度',
						onDelta: (delta) => setBoardSplit((current) => clampNumber(Math.round(current - delta), 120, 620)),
						onReset: () => setBoardSplit(DEFAULT_LAYOUT.boardSplit),
					}),
					h('div', { className: 'dst-board-assemble', style: { height: `${boardSplit}px` } },
						h('div', { className: 'dst-board-label' },
							active !== null && active.manual === true
								? '拼装的提示词（已手改）'
								: `拼装的提示词（只含勾选的 ${pickedCount} 张）`),
						h('textarea', {
							className: 'dst-board-text',
							value: preview,
							rows: 9,
							disabled: active === null,
							placeholder: '勾选卡片后这里会自动拼装；也可以直接改。',
							onChange: (event) => {
								if (active === null) return
								patchGroup(workspaceId, active.id, { manual: true, text: event.target.value })
							},
						}),
						h('div', { className: 'dst-board-actions' },
							h('button', {
								type: 'button',
								className: 'dst-btn',
								'data-primary': 'true',
								disabled: fillDisabled,
								title: fillReason,
								onClick: fill,
							}, '填入当前会话'),
							h('button', {
								type: 'button',
								className: 'dst-btn',
								disabled: !preview,
								onClick: () => copyText(preview, setFlash),
							}, '复制'),
							h('button', {
								type: 'button',
								className: 'dst-btn',
								disabled: !(active !== null && active.manual === true),
								onClick: () => {
									if (active !== null) patchGroup(workspaceId, active.id, { manual: false, text: '' })
								},
							}, '重新拼装'),
							h('span', { className: 'dst-grow' }),
							h('span', { className: 'dst-board-count' }, `${items.length} 张 · 已选 ${pickedCount} · ${preview.length} 字符`),
						),
					),
					dialog !== null ? h(GroupDialog, {
						title: dialog.mode === 'create' ? '新建组' : '重命名组',
						initial: dialog.value,
						onConfirm: confirmDialog,
						onCancel: () => setDialog(null),
					}) : null,
				)
			}

			function DraftBoard(props) {
				const items = props.useWorkspaces((state) => state.items)
				return h(DraftBoardView, {
					ctx: ctxRef.current,
					workspaceId: workspaceIdOfSession(items, props.sessionId),
				})
			}

			function BranchTreeTab(props) {
				const archived = props.useWorkspaces((state) => state.archivedSessionIds)
				const workspaces = props.useWorkspaces((state) => state.items)
				return h(TreeCanvas, {
					ctx: ctxRef.current,
					focusSessionId: props.sessionId,
					workspaces: null,
					workspaceId: workspaceIdOfSession(workspaces, props.sessionId),
					archivedIds: archived,
				})
			}

			function BranchTreePanel(props) {
				const items = props.useWorkspaces((state) => state.items)
				const archived = props.useWorkspaces((state) => state.archivedSessionIds)
				return h(TreeCanvas, {
					ctx: ctxRef.current,
					focusSessionId: null,
					workspaces: items,
					workspaceId: '',
					archivedIds: archived,
				})
			}

			function PanelIcon({ size }) {
				return h('svg', {
					width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
					stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
					'aria-hidden': 'true',
				},
					h('path', { d: 'M6 3v12a3 3 0 0 0 3 3h9' }),
					h('circle', { cx: 6, cy: 3, r: 1.6, fill: 'currentColor', stroke: 'none' }),
					h('circle', { cx: 6, cy: 15, r: 1.6, fill: 'currentColor', stroke: 'none' }),
					h('circle', { cx: 18, cy: 18, r: 1.6, fill: 'currentColor', stroke: 'none' }),
					h('circle', { cx: 18, cy: 9, r: 1.6, fill: 'currentColor', stroke: 'none' }),
					h('path', { d: 'M6 9h9a3 3 0 0 1 3 3v3' }),
				)
			}

			const ctxRef = { current: null }

			function apply(ctx) {
				ensureStyle()
				ctxRef.current = ctx

				ctx.slots.inject('conversation.view', () => ctx.slots.register({
					name: 'conversation.view',
					id: PANEL_KEY,
					order: 20,
					label: () => LABEL,
					inject: (sessionId) => ({ sessionId }),
				}, BranchTreeTab))

				ctx.slots.inject('main', () => ctx.slots.register({
					name: 'main',
					key: PANEL_KEY,
				}, BranchTreePanel))

				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: PANEL_KEY,
					order: 30,
					label: () => LABEL,
				}, PanelIcon))

				// Draft board: one page per kind lives in the right Sidebar. `keepMounted`
				// keeps the edited prompt while the tab is hidden.
				const registerDraftTab = () => ctx.sidebarRightTabs.register({
					id: DRAFT_TAB_ID,
					kind: DRAFT_KIND,
					keepMounted: true,
					priority: 'extension',
					title: () => '草稿板',
					// A tab type alone is invisible: the right Sidebar's "+" opens the guide
					// page, and this capsule is what lists the board there.
					guide: [{
						id: 'draft-board',
						order: 40,
						title: () => '草稿板',
						description: () => '把分支树里的轮次收进来，拼成一段提示词',
					}],
				})
				if (typeof ctx.effect === 'function') ctx.effect(registerDraftTab, 'session-tree: draft tab type')
				else registerDraftTab()

				ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab',
					key: DRAFT_TAB_ID,
				}, DraftBoard))

				// The board's fill button needs the composer's action face, which is only
				// published as a slot prop. This invisible seat parks it per Session.
				ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
					name: 'conversation.input.overlay',
					id: 'session-tree-input-bridge',
					order: 90,
				}, InputBridge))
			}

			exports.inject = ['slots', 'sessions', 'uiWorkspace', 'sidebarRightTabs', 'sidebarRight']
			// Reached only by the offline harness in PROGRESS.md; the Slot loader ignores it.
			exports.__internals = { buildModel, layoutSection, branchTurnOf, ownTurnAt, ancestorsOf, makeMetrics, DENSITY, buildPlan, quoteText, normalizeBoard, boardOf }
			exports.apply = apply
			return module.exports
		},
	})
