/**
 * 尺寸反推（规格书 §5）：由现有竹篾长度反推灯体直径。
 *
 * 竖篾 / 横篾共用同一套算法骨架：
 *   1. 净长 = 篾长 − 接头数 × 绑扎余量
 *      （竖篾两端 2 处；横篾圈圆形 1 处、多边形按棱数 n 处，与 frame.ts 备料口径一致）
 *   2. 净长 ≤ 0 直接拦截，绝不反推出负数直径
 *   3. 用 geometry.ts 的正算公式反解：
 *      - 横篾圈：周长 = π·D（圆）/ n·D·sin(π/n)（多边形弦长公式），解析解
 *      - 竖篾：轮廓折线长随直径单调，按现有收口比例与总高二分求解
 *   4. 显示按 mm 一位小数（附 cm 换算）；写回参数按整毫米，
 *      最大直径向下取整——保证按写回尺寸下料，备料不超出手中篾长
 *
 * 取舍（两条路只择其一）：竖篾反推保住这盏灯的造型比例（上口/底口与最大直径之比）
 * 与总高，代价是反推直径不是整数、要在 mm/cm 之间换算；写回时上口/底口按比例同步
 * 取整，并用写回后的整数参数复解校准到不动点——同一根篾反复按「应用」结果一模一样。
 */
import type { Lantern } from './types'
import {
  buildGeometry,
  effectiveHeight,
  polygonEdge,
  polyhedronInfo,
  r1,
  ringPerimeter,
  segmentInfos
} from './geometry'

/** mm → cm（1cm = 10mm）：界面几处换算统一走这里，保证一致 */
export const MM_PER_CM = 10
export function mmToCm(mm: number): number {
  return mm / MM_PER_CM
}

/** 与参数页输入下限一致 */
export const MIN_MAX_DIAMETER_MM = 20
export const MIN_MOUTH_DIAMETER_MM = 10

/** 反推结果公共部分：净长与余量明细（界面据此把「篾还短一截」算给用户看） */
export interface ReverseBase {
  ok: boolean
  /** 失败原因（篾长不足余量 / 净长不足总高 / 直筒无法反推） */
  error?: string
  /** 输入篾长（mm） */
  stripMm: number
  /** 接头/端头数量 */
  joints: number
  /** 扣掉的绑扎余量合计（mm） */
  lashTotalMm: number
  /** 净长（mm，= 篾长 − 余量合计） */
  netLengthMm: number
}

/** 写回参数用的整毫米三元组（最大/上口/底口同步，造型比例不变） */
export interface DiameterWriteBack {
  maxMm: number
  mouthMm: number
  baseMm: number
}

export interface RibReverse extends ReverseBase {
  /** 反推最大直径（实数解，界面按 1 位小数显示） */
  maxDiameterMm: number
  mouthDiameterMm: number
  baseDiameterMm: number
  /** 按写回尺寸下料的竖篾备料长（mm，含两端余量，≤ 篾长） */
  stockMm: number
  writeBack: DiameterWriteBack
}

export interface RingReverse extends ReverseBase {
  polygon: boolean
  sides: number
  /** 圈直径（外接圆直径，mm，实数解） */
  diameterMm: number
  /** 圈周长净长（mm，便于拿尺子核对圈长） */
  perimeterMm: number
  /** 多边形时每条棱边净长（mm） */
  edgeMm: number
  /** 按写回尺寸下料的整圈备料长（mm，含接头余量，≤ 篾长） */
  stockMm: number
  writeBack: DiameterWriteBack
}

/** 第 1、2 步：扣余量并拦截（两条反推共用） */
function netAfterLash(stripMm: number, joints: number, lashMm: number): ReverseBase {
  const lashTotal = Math.max(0, lashMm) * joints
  const net = stripMm - lashTotal
  const base: ReverseBase = { ok: false, stripMm, joints, lashTotalMm: lashTotal, netLengthMm: net }
  if (!(stripMm > 0)) {
    base.error = '篾长必须是正数'
    return base
  }
  if (!(net > 0)) {
    base.error = `篾长 ${r1(stripMm)}mm 不够扣 ${joints} 处绑扎余量（共 ${r1(lashTotal)}mm）`
    return base
  }
  base.ok = true
  return base
}

/** 当前轮廓的收口比例（上口/底口半径与最大半径之比；平口为 1，与几何截断口径一致） */
function mouthBaseRatios(l: Lantern): { rm: number; rb: number } {
  const g = buildGeometry(l)
  return { rm: g.mouthR / g.maxR, rb: g.baseR / g.maxR }
}

/**
 * 指定最大直径与收口比例时的竖篾净长（轮廓折线长，正算公式与 frame.ts 竖篾一致；
 * 多面体为棱长）。总高由分段决定，不随直径变化。
 */
function ribNetLength(l: Lantern, maxMm: number, rm: number, rb: number): number {
  const probe: Lantern = {
    ...l,
    maxDiameterMm: maxMm,
    mouthDiameterMm: maxMm * rm,
    baseDiameterMm: maxMm * rb
  }
  const g = buildGeometry(probe)
  if (g.kind === 'polyhedron') return polyhedronInfo(g).edgeMm
  return segmentInfos(g).reduce((s, x) => s + x.slantMm, 0)
}

/**
 * 二分求解：竖篾净长目标 → 最大直径。
 * 净长关于直径单调不减（直径→0 时收敛到总高；多面体收敛到 0），无解返回 null。
 */
function solveMaxDiameter(l: Lantern, netMm: number, rm: number, rb: number): number | null {
  const minLen = l.kind === 'polyhedron' ? 0 : Math.max(1, effectiveHeight(l))
  if (!(netMm > minLen)) return null
  let lo = 0
  let hi = Math.max(100, l.maxDiameterMm, 1)
  let hiLen = ribNetLength(l, hi, rm, rb)
  while (hiLen < netMm && hi < 1_000_000) {
    hi *= 2
    hiLen = ribNetLength(l, hi, rm, rb)
  }
  if (hiLen < netMm) return null // 平口直筒：竖篾长不随直径变化，反推不出
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (ribNetLength(l, mid, rm, rb) < netMm) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 由反推直径生成写回三元组：最大直径向下取整（保证下料不短），
 * 上口/底口按现有收口比例同步取整（造型比例不变）。
 */
function scaleTriple(l: Lantern, diameterMm: number): DiameterWriteBack {
  const { rm, rb } = mouthBaseRatios(l)
  const maxMm = Math.max(MIN_MAX_DIAMETER_MM, Math.floor(diameterMm))
  return {
    maxMm,
    mouthMm: Math.max(MIN_MOUTH_DIAMETER_MM, Math.round(rm * maxMm)),
    baseMm: Math.max(MIN_MOUTH_DIAMETER_MM, Math.round(rb * maxMm))
  }
}

const EMPTY_WRITE_BACK: DiameterWriteBack = { maxMm: 0, mouthMm: 0, baseMm: 0 }

/** 竖篾反推：保持收口比例与总高，二分求最大直径（含幂等校准与短料兜底） */
export function reverseFromRib(l: Lantern, stripMm: number): RibReverse {
  const lash = Math.max(0, l.lashAllowanceMm)
  const base = netAfterLash(stripMm, 2, lash) // 竖篾两端各 1 处绑扎余量
  const empty = { maxDiameterMm: 0, mouthDiameterMm: 0, baseDiameterMm: 0, stockMm: 0, writeBack: EMPTY_WRITE_BACK }
  if (!base.ok) return { ...base, ...empty }

  const height = Math.max(1, effectiveHeight(l))
  if (l.kind !== 'polyhedron' && !(base.netLengthMm > height)) {
    return {
      ...base,
      ...empty,
      ok: false,
      error: `净长 ${r1(base.netLengthMm)}mm 还没超过总高 ${r1(height)}mm，竖篾至少要比总高长`
    }
  }

  const { rm, rb } = mouthBaseRatios(l)
  const solved = solveMaxDiameter(l, base.netLengthMm, rm, rb)
  if (solved == null) {
    return { ...base, ...empty, ok: false, error: '上下都是平口的直筒：竖篾长只等于总高，反推不出直径，请改用横篾反推' }
  }

  // 写回候选（整毫米、上口/底口按比例同步），再用写回后的整数参数复解校准：
  // 收敛到不动点后，「应用」再反推得到的结果一模一样（幂等）
  let triple = scaleTriple(l, solved)
  const seen = new Set<string>()
  for (let i = 0; i < 8; i++) {
    const key = `${triple.maxMm}/${triple.mouthMm}/${triple.baseMm}`
    if (seen.has(key)) break
    seen.add(key)
    const re = solveMaxDiameter(l, base.netLengthMm, triple.mouthMm / triple.maxMm, triple.baseMm / triple.maxMm)
    if (re == null) break
    const next = scaleTriple(l, re)
    if (next.maxMm === triple.maxMm && next.mouthMm === triple.mouthMm && next.baseMm === triple.baseMm) break
    triple = next
  }

  // 短料兜底：写回尺寸的竖篾净长不得超过可用净长（向下取整已留余量，此处双保险）
  for (let guard = 0; guard < 40 && triple.maxMm > MIN_MAX_DIAMETER_MM; guard++) {
    const net = ribNetLength(l, triple.maxMm, triple.mouthMm / triple.maxMm, triple.baseMm / triple.maxMm)
    if (net <= base.netLengthMm + 1e-9) break
    const rmT = triple.mouthMm / triple.maxMm
    const rbT = triple.baseMm / triple.maxMm
    triple = {
      maxMm: triple.maxMm - 1,
      mouthMm: Math.max(MIN_MOUTH_DIAMETER_MM, Math.round(rmT * (triple.maxMm - 1))),
      baseMm: Math.max(MIN_MOUTH_DIAMETER_MM, Math.round(rbT * (triple.maxMm - 1)))
    }
  }

  // 显示值：用最终写回比例复解的实数解（应用后再看，显示不动）
  const rmF = triple.mouthMm / triple.maxMm
  const rbF = triple.baseMm / triple.maxMm
  const display = solveMaxDiameter(l, base.netLengthMm, rmF, rbF) ?? solved
  const stockMm = ribNetLength(l, triple.maxMm, rmF, rbF) + base.lashTotalMm

  return {
    ...base,
    maxDiameterMm: display,
    mouthDiameterMm: rmF * display,
    baseDiameterMm: rbF * display,
    stockMm,
    writeBack: triple
  }
}

/** 横篾反推：一根篾弯一整圈，扣接头余量后按周长公式反解圈直径 */
export function reverseFromRing(l: Lantern, stripMm: number): RingReverse {
  const g = buildGeometry(l)
  const polygon = g.polygon
  const n = g.n
  // 圆形圈接头 1 处、多边形圈按棱数 n 处（规格书 §8，与 frame.ts 备料口径一致）
  const joints = polygon ? n : 1
  const lash = Math.max(0, l.lashAllowanceMm)
  const base = netAfterLash(stripMm, joints, lash)
  const empty = { polygon, sides: n, diameterMm: 0, perimeterMm: 0, edgeMm: 0, stockMm: 0, writeBack: EMPTY_WRITE_BACK }
  if (!base.ok) return { ...base, ...empty }

  const net = base.netLengthMm
  // 正算：周长 = ringPerimeter(D/2, n, polygon)（圆 2πR / 多边形 n × 2R·sin(π/n)）
  // 反解：圆 D = 周长/π；多边形 D = 周长 / (n·sin(π/n)) —— 弦长公式，棱数必须参与
  const diameter = polygon ? net / (n * Math.sin(Math.PI / n)) : net / Math.PI
  const perimeter = ringPerimeter(diameter / 2, n, polygon) // 应等于净长，界面据此核对
  const edge = polygonEdge(diameter / 2, n)

  const writeBack = scaleTriple(l, diameter)
  // 写回直径（向下取整）对应的整圈备料长，保证 ≤ 手中篾长
  const stockMm = ringPerimeter(writeBack.maxMm / 2, n, polygon) + base.lashTotalMm

  return { ...base, polygon, sides: n, diameterMm: diameter, perimeterMm: perimeter, edgeMm: edge, stockMm, writeBack }
}
