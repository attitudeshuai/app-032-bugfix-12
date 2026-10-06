/**
 * 尺寸反推（规格书 §5）—— 由现有竹篾长度反推最大直径。
 *
 * 取舍（竖篾唯一可选路线）：保住现有轮廓比例与总高——
 * 上口/底口按相对最大直径的比例随反推直径缩放，总高与各分段高不动；
 * 代价是反推直径不是整数。不做「按长度整体等比缩放」，那条路会破坏造型与总高，
 * 且以上一次结果为基数，同一输入反复应用会越按越小。
 *
 * 技术口径（竖篾、横篾两条反推统一遵守）：
 *  - 竖篾备料先扣两端绑扎余量（2 × lashAllowanceMm）再参与二分；
 *  - 横篾整圈合围长先扣接头余量（接头处数与构件表一致：圆形 1 处、多边形 n 处）；
 *  - 多边形一律按棱数用弦长公式：底边长 = 2R sin(π/n)，合围 = n × 底边长；
 *  - 反推结果界面按 1 位小数显示，写回参数按整毫米取整。取整后三元组
 *    （最大/上口/底口直径）必须落在「取整映射」自身的不动点上——把结果喂回去
 *    再反推得到一模一样的三元组，所以同一输入连按任意次结果都相同；
 *  - 扣完余量为负、或净长已不可能容纳时拦截，绝不回写负数/非法直径。
 */
import type { Lantern } from './types'
import { buildGeometry, clamp, ringJoints, r1, segmentInfos, TAU } from './geometry'

/** 反推下限（mm，整毫米），与参数页输入框 min 保持一致 */
export const MIN_DIAMETER_MM = 20
/** 二分上限（mm），覆盖手工作坊可能的巨型灯；反推撞到上限会标 capped */
export const MAX_DIAMETER_MM = 6000
/** 取整后允许的净长超出量（mm），防止整毫米量化把结果顶过料长 */
const FEASIBLE_SLACK_MM = 0.05
const FIXED_POINT_MAX_ITER = 24

export type ReverseSource = 'rib' | 'ring'

export interface ReverseResult {
  /** 反推是否可用（多面体、双平口竖篾、余量不足时为 false） */
  ok: boolean
  /** 不可用原因（界面直接展示） */
  error?: string
  /** 反推最大直径原始值（mm，未取整；界面按 1 位小数显示） */
  rawDiameterMm: number
  /** 写回用整毫米直径（= 取整映射不动点） */
  roundedDiameterMm: number
  /** 不动点三元组里的上口/底口整毫米（平口样式时等于最大直径） */
  mouthDiameterMm: number
  baseDiameterMm: number
  /** 扣掉绑扎/接头余量后的有效净料长（mm） */
  netStockMm: number
  /** 写回后复核出的实际净长/合围（mm，≤ netStockMm + 0.05） */
  fittedNetMm: number
  /** 扣减的余量合计（mm） */
  allowanceMm: number
  /** 反推撞到二分上限（料多长都吃得下） */
  capped: boolean
}

/** 竖篾/母线篾在给定参数下的净折线长（与构件表竖篾 rawLengthMm 同一算法） */
export function ribNetLength(l: Lantern): number {
  return segmentInfos(buildGeometry(l)).reduce((s, x) => s + x.slantMm, 0)
}

interface Ratios {
  mouth: number
  base: number
}

/** 上口/底口相对最大直径的比例（始终取反推发起时的原参数，结果只由输入决定） */
function ratiosOf(l: Lantern): Ratios {
  return {
    mouth: l.mouthStyle === 'flat' ? 1 : clamp(l.mouthDiameterMm / Math.max(1, l.maxDiameterMm), 0, 1),
    base: l.bottomStyle === 'flat' ? 1 : clamp(l.baseDiameterMm / Math.max(1, l.maxDiameterMm), 0, 1)
  }
}

/** 给定最大直径与比例，生成写回用的整毫米三元组（平口样式时口径 = 最大直径） */
function roundTriple(l: Lantern, rawD: number, ratios: Ratios) {
  const d = Math.round(clamp(rawD, MIN_DIAMETER_MM, MAX_DIAMETER_MM))
  const m = l.mouthStyle === 'flat' ? d : Math.round(clamp(ratios.mouth * d, MIN_DIAMETER_MM, d))
  const b = l.bottomStyle === 'flat' ? d : Math.round(clamp(ratios.base * d, MIN_DIAMETER_MM, d))
  return { d, m, b }
}

/** 构造试算用灯样（只换直径三元组，其余参数一律不动） */
function withTriple(l: Lantern, t: { d: number; m: number; b: number }): Lantern {
  return { ...l, maxDiameterMm: t.d, mouthDiameterMm: t.m, baseDiameterMm: t.b }
}

interface FixedPoint {
  triple: { d: number; m: number; b: number }
  /** 不动点三元组对应的净长/合围，是否在料长以内 */
  feasible: boolean
  fittedNet: number
}

/**
 * 找「原始反推值 → 整毫米三元组」映射的不动点：
 * 把候选三元组当作当前灯样再反推一次，取新三元组，直到相邻两次完全相同。
 * 若取整把直径顶大（合围/净长超过料长），整体往下退 1mm 再取整，直到不超料——
 * 保证写回结果是「能用这根篾做出来」的最大整毫米直径。迭代过程中始终保留最后一个
 * 可行三元组；若连最小直径都超料，交由上层拦截并报加长量。
 */
function resolveFixedPoint(
  l: Lantern,
  rawD: number,
  ratios: Ratios,
  netOfTriple: (t: { d: number; m: number; b: number }) => number,
  rawFromState: (state: Lantern) => number,
  netStock: number,
  closedForm = false
): FixedPoint {
  let state = l
  let basis = rawD
  let triple = roundTriple(l, basis, ratios)
  let lastFeasible: FixedPoint | null = null
  for (let i = 0; i < FIXED_POINT_MAX_ITER; i++) {
    state = withTriple(state, triple)
    const fittedNet = netOfTriple(triple)
    const feasible = fittedNet <= netStock + FEASIBLE_SLACK_MM
    if (feasible) lastFeasible = { triple, feasible: true, fittedNet }

    // 取整超料：以「候选直径 - 1mm」为新基准重取三元组（口/底随比例跟着退）
    if (!feasible && triple.d > MIN_DIAMETER_MM) {
      basis = triple.d - 1
      triple = roundTriple(l, basis, ratios)
      continue
    }

    // 闭式反解（横篾）：反推直径只由料长决定，与灯样状态无关；
    // 三元组经过下降步后已可行且不会再变，即为幂等写回点。
    if (closedForm) {
      return { triple, feasible, fittedNet }
    }

    // 竖篾：以该三元组为当前灯样重新反推原始直径：映射 T(状态) = round(反推(状态))
    const nextRaw = rawFromState(state)
    const next = roundTriple(l, nextRaw, ratios)
    if (next.d === triple.d && next.m === triple.m && next.b === triple.b) {
      return { triple, feasible, fittedNet }
    }
    triple = next
    basis = nextRaw
  }
  // 迭代上限（振荡等）时退回最后一个可行点；没有可行点则返回当前点（上层拦截）
  return (
    lastFeasible ?? {
      triple,
      feasible: false,
      fittedNet: netOfTriple(triple)
    }
  )
}

/** 竖篾反推：保轮廓比例与总高，二分最大直径 */
export function reverseFromRib(l: Lantern, stockMm: number): ReverseResult {
  const lash = Math.max(0, l.lashAllowanceMm)
  const allowance = 2 * lash
  const net = stockMm - allowance
  const blockedBase = blocked(l, stockMm, net, `两端绑扎余量各 ${lash}mm`)
  if (blockedBase) return blockedBase
  // 上下都是平口：竖篾净长恒等于总高，直径无从反推
  if (l.mouthStyle === 'flat' && l.bottomStyle === 'flat') {
    return fail(l, net, allowance, '上下均为平口时竖篾净长恒等于总高，直径不影响篾长，无法按竖篾反推；请改用横篾反推或先选收口样式')
  }

  const ratios = ratiosOf(l)
  const netAtD = (rawD: number) => ribNetLength(withTriple(l, roundTriple(l, rawD, ratios)))
  const netOfTriple = (t: { d: number; m: number; b: number }) => ribNetLength(withTriple(l, t))

  if (netAtD(MIN_DIAMETER_MM) > net + FEASIBLE_SLACK_MM) {
    return fail(
      l,
      net,
      allowance,
      `扣掉两端余量后净料仅 ${r1(net)}mm，比这盏灯收到最小直径（${MIN_DIAMETER_MM}mm）所需竖篾还短；请换更长的篾或减小总高`
    )
  }

  // 二分（净长随最大直径单调增加）
  let lo = MIN_DIAMETER_MM
  let hi = MAX_DIAMETER_MM
  let capped = false
  if (netAtD(hi) <= net) {
    lo = hi
    capped = true
  } else {
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2
      if (netAtD(mid) <= net) lo = mid
      else hi = mid
    }
  }

  // 对「以当前灯样反推」这个映射做不动点迭代，保证反复应用完全一致
  const fp = resolveFixedPoint(
    l,
    lo,
    ratios,
    netOfTriple,
    (state) => bisectRib(state, ratios, net),
    net
  )
  if (!fp.feasible) {
    return fail(
      l,
      net,
      allowance,
      `取整到整毫米后竖篾净长 ${r1(fp.fittedNet)}mm 超过净料 ${r1(net)}mm，请加长 ${r1(Math.ceil((fp.fittedNet - net) * 10) / 10)}mm`
    )
  }

  return {
    ok: true,
    rawDiameterMm: r1(lo),
    roundedDiameterMm: fp.triple.d,
    mouthDiameterMm: fp.triple.m,
    baseDiameterMm: fp.triple.b,
    netStockMm: r1(net),
    fittedNetMm: r1(fp.fittedNet),
    allowanceMm: allowance,
    capped
  }
}

/** 给定灯样与比例，二分竖篾净长恰好不超过 net 的最大原始直径（不动点迭代内部用） */
function bisectRib(l: Lantern, ratios: Ratios, net: number): number {
  const netAtD = (rawD: number) => ribNetLength(withTriple(l, roundTriple(l, rawD, ratios)))
  if (netAtD(MAX_DIAMETER_MM) <= net) return MAX_DIAMETER_MM
  let lo = MIN_DIAMETER_MM
  let hi = MAX_DIAMETER_MM
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (netAtD(mid) <= net) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * 横篾反推：按灯体最粗处（直段）的一整圈合围长反推外接/圆直径。
 * 输入语义为「一圈所需的整根备料长」：多边形灯 = n 根棱篾合计（合围 n·弦长），
 * 圆形灯 = 单根圈篾长（周长 2πR）；接头余量按同一规则先扣再反算。
 * 闭式解本身是固定映射，但仍走同一不动点流程（取整 + 比例缩放三元组）。
 */
export function reverseFromRing(l: Lantern, stockMm: number): ReverseResult {
  const lash = Math.max(0, l.lashAllowanceMm)
  const polygon = l.kind === 'prism' || l.kind === 'box'
  const n = Math.max(3, Math.round(l.sides))
  const joints = ringJoints(n, polygon)
  const allowance = joints * lash
  const net = stockMm - allowance
  const blockedBase = blocked(l, stockMm, net, polygon ? `${n} 处接头各 ${lash}mm` : `1 处接头 ${lash}mm`)
  if (blockedBase) return blockedBase

  // 最粗处合围：多边形 n·2R sin(π/n)，圆形 2πR
  const perimeter = (d: number) => {
    const r = d / 2
    return polygon ? n * (2 * r * Math.sin(Math.PI / n)) : TAU * r
  }
  // 净合围 → 原始直径：多边形 n·2R sin(π/n) 反解；圆形 2πR 反解
  const rawD = polygon ? net / (n * Math.sin(Math.PI / n)) : net / Math.PI
  if (rawD < MIN_DIAMETER_MM - FEASIBLE_SLACK_MM) {
    return fail(
      l,
      net,
      allowance,
      `扣掉接头余量后净合围仅 ${r1(net)}mm，连最小直径 ${MIN_DIAMETER_MM}mm 的一圈都围不起来；请换更长的横篾`
    )
  }

  const ratios = ratiosOf(l)
  const capped = rawD >= MAX_DIAMETER_MM
  const fp = resolveFixedPoint(
    l,
    Math.min(rawD, MAX_DIAMETER_MM),
    ratios,
    (t) => perimeter(t.d),
    // 环形闭式反解：反推直径只由料长决定（与灯样状态无关），走闭式幂等分支
    () => Math.min(rawD, MAX_DIAMETER_MM),
    net,
    true
  )
  if (!fp.feasible) {
    return fail(
      l,
      net,
      allowance,
      `取整到整毫米后合围 ${r1(fp.fittedNet)}mm 超过净合围 ${r1(net)}mm，请加长 ${r1(Math.ceil((fp.fittedNet - net) * 10) / 10)}mm`
    )
  }

  return {
    ok: true,
    rawDiameterMm: r1(rawD),
    roundedDiameterMm: fp.triple.d,
    mouthDiameterMm: fp.triple.m,
    baseDiameterMm: fp.triple.b,
    netStockMm: r1(net),
    fittedNetMm: r1(fp.fittedNet),
    allowanceMm: allowance,
    capped
  }
}

function blocked(l: Lantern, stock: number, net: number, allowanceText: string): ReverseResult | null {
  if (!(Number.isFinite(stock) && stock > 0)) {
    return fail(l, 0, 0, '请先输入有效的现有篾长（正数，单位 mm）')
  }
  if (l.kind === 'polyhedron') {
    return fail(l, 0, 0, '正多面体灯的棱长按外接球确定，不适用竹篾反推')
  }
  if (net <= 0) {
    return fail(l, 0, Math.max(0, stock - net), `篾长扣完${allowanceText}后余量为 ${r1(net)}mm（≤0），已拦住：请加长篾或减小绑扎余量，不会回写负数`)
  }
  return null
}

function fail(l: Lantern, net: number, allowance: number, error: string): ReverseResult {
  return {
    ok: false,
    error,
    rawDiameterMm: 0,
    roundedDiameterMm: 0,
    mouthDiameterMm: l.mouthDiameterMm,
    baseDiameterMm: l.baseDiameterMm,
    netStockMm: r1(Math.max(0, net)),
    fittedNetMm: 0,
    allowanceMm: Math.max(0, allowance),
    capped: false
  }
}
