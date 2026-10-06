<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import LanternPreview from '../components/LanternPreview.vue'
import ChecksPanel from '../components/ChecksPanel.vue'
import { getLantern, distributeLayers, syncLayerDiameters, applyReverseResult } from '../core/store'
import { computeAll } from '../core/checks'
import { DEFAULT_LOFT_OPTIONS } from '../core/paginate'
import { buildGeometry, polyhedronInfo, r1 } from '../core/geometry'
import { COVERINGS, CRAFT, coveringSpec, kindLabel } from '../core/craft'
import { reverseFromRib, reverseFromRing, type ReverseResult } from '../core/reverse'
import type { Lantern, Panel } from '../core/types'

const route = useRoute()
const lantern = computed(() => getLantern(route.params.id as string))
const mode = ref<'front' | 'top' | 'iso'>('front')

const loft = computed(() => ({
  ...DEFAULT_LOFT_OPTIONS,
  paper: lantern.value?.pageSize || 'A4',
  overlapMm: lantern.value?.overlapMm || 10
}))

const full = computed(() => {
  const l = lantern.value
  if (!l) return null
  return computeAll(l, loft.value)
})

const geo = computed(() => (lantern.value ? buildGeometry(lantern.value) : null))
const shoulderPct = computed(() => (geo.value ? ((geo.value.kTop + geo.value.kBot) * 100).toFixed(0) : '0'))

/** 边界提示：收口/底口直径不应超过最大直径（几何会按最大直径截断） */
const diameterWarn = computed(() => {
  const l = lantern.value
  if (!l) return ''
  const msgs: string[] = []
  if (l.mouthStyle !== 'flat' && l.mouthDiameterMm > l.maxDiameterMm) {
    msgs.push(`收口直径 ${l.mouthDiameterMm}mm 已超过最大直径 ${l.maxDiameterMm}mm，超出部分按最大直径计算`)
  }
  if (l.bottomStyle !== 'flat' && l.baseDiameterMm > l.maxDiameterMm) {
    msgs.push(`底口直径 ${l.baseDiameterMm}mm 已超过最大直径 ${l.maxDiameterMm}mm，超出部分按最大直径计算`)
  }
  return msgs.join('；')
})

const poly = computed(() => {
  const l = lantern.value
  if (!l || l.kind !== 'polyhedron' || !geo.value) return null
  return polyhedronInfo(geo.value)
})

function onTotalHeight(e: Event) {
  const l = lantern.value
  if (!l) return
  const v = Math.max(40, Number((e.target as HTMLInputElement).value) || 0)
  l.totalHeightMm = v
  distributeLayers(l)
}

function onLayerCount(e: Event) {
  const l = lantern.value
  if (!l) return
  const n = Math.max(1, Math.min(12, Math.round(Number((e.target as HTMLInputElement).value) || 1)))
  l.layers = Array.from({ length: n }, () => ({ heightMm: l.totalHeightMm / n, diameterMm: 0 }))
  distributeLayers(l)
}

function onLayerHeight(i: number, e: Event) {
  const l = lantern.value
  if (!l) return
  const v = Math.max(10, Number((e.target as HTMLInputElement).value) || 0)
  l.layers[i].heightMm = r1(v)
  syncLayerDiameters(l)
}

/** 最大直径 / 上口 / 底口直接改数：各层直径立即按新轮廓重算（三处同源，不留老数） */
function onDiameterField(which: 'max' | 'mouth' | 'base', e: Event) {
  const l = lantern.value
  if (!l) return
  const v = Math.max(10, Number((e.target as HTMLInputElement).value) || 0)
  if (which === 'max') l.maxDiameterMm = Math.round(v)
  else if (which === 'mouth') l.mouthDiameterMm = Math.round(v)
  else l.baseDiameterMm = Math.round(v)
  syncLayerDiameters(l)
}

function onCovering(e: Event) {
  const l = lantern.value
  if (!l) return
  const v = (e.target as HTMLSelectElement).value as Lantern['covering']
  l.covering = v
  l.wasteRatio = coveringSpec(v).wasteRatio
}

function setSides(e: Event) {
  const l = lantern.value
  if (!l) return
  l.sides = Math.max(3, Math.min(l.kind === 'revolution' ? 24 : 12, Math.round(Number((e.target as HTMLInputElement).value) || 3)))
}

// ---- 尺寸反推（§5）：竖篾 / 横篾统一走 core/reverse.ts 同一套算法 ----
const ribInput = ref(700)
const ringInput = ref(1000)

const ribRev = computed<ReverseResult>(() => {
  const l = lantern.value
  if (!l) {
    return {
      ok: false,
      error: '',
      rawDiameterMm: 0,
      roundedDiameterMm: 0,
      mouthDiameterMm: 0,
      baseDiameterMm: 0,
      netStockMm: 0,
      fittedNetMm: 0,
      allowanceMm: 0,
      capped: false
    }
  }
  return reverseFromRib(l, Number(ribInput.value) || 0)
})

const ringRev = computed<ReverseResult>(() => {
  const l = lantern.value
  if (!l) return ribRev.value
  return reverseFromRing(l, Number(ringInput.value) || 0)
})

/** 最近一次反推写回的来源（用于让被刷新的格子闪一下，直观看出三处都跟着动了） */
const flash = ref<{ kind: string; n: number } | null>(null)
function applyReverse(r: ReverseResult, source: 'rib' | 'ring') {
  const l = lantern.value
  if (!l || !r.ok) return
  applyReverseResult(l, r)
  flash.value = { kind: source, n: Date.now() }
  window.setTimeout(() => {
    if (flash.value?.kind === source) flash.value = null
  }, 1200)
}

/** 同一份毫米数折成厘米显示（换算只发生在展示层，参与计算的始终是 mm） */
function toCm(mm: number): string {
  return (mm / 10).toFixed(2)
}

/** 某处在最近一次反推后是否应高亮 */
function flashing(kinds: string[]): boolean {
  return !!flash.value && kinds.includes(flash.value.kind)
}

const panelsPreview = computed<Panel[]>(() => full.value?.panels.panels.slice(0, 4) || [])

function onCtrl(v: { which: 1 | 2; x: number; y: number }) {
  const l = lantern.value
  if (!l) return
  if (v.which === 1) l.ctrl1 = { x: v.x, y: v.y }
  else l.ctrl2 = { x: v.x, y: v.y }
}
</script>

<template>
  <div v-if="!lantern" class="missing">
    <p>找不到这个灯样（可能已被删除）。</p>
    <router-link to="/">返回灯型选择</router-link>
  </div>

  <div v-else class="design">
    <section class="params">
      <h2>参数设置</h2>

      <div class="field">
        <label>灯样名称</label>
        <input v-model="lantern.name" type="text" />
      </div>

      <div class="row">
        <div class="field">
          <label>灯型</label>
          <input :value="kindLabel(lantern.kind)" type="text" readonly />
        </div>
        <div class="field">
          <label>{{ lantern.kind === 'revolution' ? '竖篾（母线）根数' : '棱数' }}</label>
          <input
            v-if="lantern.kind !== 'polyhedron'"
            :value="lantern.sides"
            type="number"
            min="3"
            max="24"
            @change="setSides"
          />
          <select v-else v-model.number="lantern.sides">
            <option :value="4">正四面体（4 面）</option>
            <option :value="8">正八面体（8 面）</option>
          </select>
        </div>
      </div>

      <div class="row">
        <div class="field" :class="{ refreshed: flashing(['rib', 'ring']) }">
          <label>最大直径 (mm)</label>
          <input
            :value="lantern.maxDiameterMm"
            type="number"
            min="20"
            max="3000"
            step="1"
            @change="onDiameterField('max', $event)"
          />
        </div>
        <div class="field">
          <label>总高 (mm)</label>
          <input
            :value="lantern.totalHeightMm"
            type="number"
            min="40"
            max="3000"
            step="1"
            :disabled="lantern.kind === 'polyhedron'"
            @change="onTotalHeight"
          />
        </div>
      </div>

      <div class="row">
        <div class="field" :class="{ refreshed: flashing(['rib', 'ring']) }">
          <label>收口直径 (mm)</label>
          <input
            :value="lantern.mouthDiameterMm"
            type="number"
            min="10"
            max="3000"
            step="1"
            :disabled="lantern.mouthStyle === 'flat'"
            @change="onDiameterField('mouth', $event)"
          />
        </div>
        <div class="field" :class="{ refreshed: flashing(['rib', 'ring']) }">
          <label>底口直径 (mm)</label>
          <input
            :value="lantern.baseDiameterMm"
            type="number"
            min="10"
            max="3000"
            step="1"
            :disabled="lantern.bottomStyle === 'flat'"
            @change="onDiameterField('base', $event)"
          />
        </div>
      </div>

      <p v-if="diameterWarn" class="warn-line">⚠ {{ diameterWarn }}</p>

      <div class="row">
        <div class="field">
          <label>上收口方式</label>
          <select v-model="lantern.mouthStyle">
            <option value="flat">平口</option>
            <option value="taper">收口</option>
            <option value="gourd">葫芦口（贝塞尔）</option>
          </select>
        </div>
        <div class="field">
          <label>下收口方式</label>
          <select v-model="lantern.bottomStyle">
            <option value="flat">平口</option>
            <option value="taper">收口</option>
            <option value="gourd">葫芦口（贝塞尔）</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>收口曲线强度 <em>{{ lantern.smoothness.toFixed(2) }}</em></label>
        <input v-model.number="lantern.smoothness" type="range" min="0" max="1" step="0.02" />
        <small>当前收口段合计占总高 {{ shoulderPct }}%（上 + 下）</small>
      </div>

      <div v-if="lantern.kind === 'revolution'" class="field">
        <label>母线等分数 <em>{{ lantern.divisions }} 等分</em></label>
        <input v-model.number="lantern.divisions" type="range" :min="CRAFT.divMin" :max="CRAFT.divMax" step="1" />
        <small>旋转体按 {{ lantern.divisions }} 等分近似展开，等分数可调；等分越少每块越宽，面积核对偏差越大。</small>
      </div>

      <div class="row">
        <div class="field">
          <label>层数（分段）</label>
          <input :value="lantern.layers.length" type="number" min="1" max="12" @change="onLayerCount" />
        </div>
        <div class="field">
          <label>蒙面类型</label>
          <select :value="lantern.covering" @change="onCovering">
            <option v-for="c in COVERINGS" :key="c.id" :value="c.id">
              {{ c.name }}（用胶 {{ c.gluePerM2 }}g/m²）
            </option>
          </select>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label>缝份（每边 mm）</label>
          <input v-model.number="lantern.seamAllowanceMm" type="number" min="0" max="40" step="1" />
        </div>
        <div class="field">
          <label>绑扎余量（每端 mm）</label>
          <input v-model.number="lantern.lashAllowanceMm" type="number" min="0" max="80" step="1" />
        </div>
      </div>

      <h3>分段高度与配色</h3>
      <table class="layers">
        <thead>
          <tr>
            <th>层</th>
            <th>分段高 (mm)</th>
            <th>该层直径 (mm)</th>
            <th>配色</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(ly, i) in lantern.layers" :key="i">
            <td class="mono">{{ i + 1 }}</td>
            <td><input :value="ly.heightMm" type="number" min="10" step="1" @change="onLayerHeight(i, $event)" /></td>
            <td class="mono" :class="{ refreshed: flashing(['rib', 'ring']) }">{{ ly.diameterMm.toFixed(1) }}</td>
            <td>
              <input v-model="lantern.layerColors[i]" type="color" />
            </td>
          </tr>
        </tbody>
      </table>
      <small class="hint">
        分段高之和 = 总高 {{ lantern.totalHeightMm }}mm（反推保造型比例，不动高度）；
        该层直径由轮廓自动推算，改最大/上口/底口直径或点「应用」后立即整列重算。
      </small>

      <h3>批量制灯</h3>
      <div class="row">
        <div class="field">
          <label>数量（个）</label>
          <input v-model.number="lantern.batchCount" type="number" min="1" max="500" step="1" />
        </div>
        <div class="field">
          <label>损耗率 <em>{{ (lantern.wasteRatio * 100).toFixed(0) }}%</em></label>
          <input v-model.number="lantern.wasteRatio" type="range" min="0" max="0.2" step="0.01" />
        </div>
      </div>

      <h3>尺寸反推（由现有竹篾反推尺寸）</h3>
      <div class="reverse">
        <div v-if="lantern.kind === 'polyhedron'" class="rev-blocked">
          正四面体/八面体灯的棱长由外接球直径直接确定，不适用竹篾反推。
        </div>
        <template v-else>
          <div class="rev-row">
            <label>现有竖篾长 (mm)</label>
            <input v-model.number="ribInput" type="number" min="50" step="10" />
            <span v-if="ribRev.ok" class="mono rev-ok">
              → 最大直径 {{ ribRev.rawDiameterMm.toFixed(1) }}mm
              <em>（写回 ⌀{{ ribRev.roundedDiameterMm }} / 上口 ⌀{{ ribRev.mouthDiameterMm }} / 底口 ⌀{{ ribRev.baseDiameterMm }}mm；{{ toCm(ribRev.rawDiameterMm) }}cm）</em>
            </span>
            <span v-else class="rev-err">✋ {{ ribRev.error }}</span>
            <button :disabled="!ribRev.ok" @click="applyReverse(ribRev, 'rib')">应用</button>
          </div>
          <div v-if="ribRev.ok" class="rev-detail">
            已扣两端绑扎余量各 {{ lantern.lashAllowanceMm }}mm（共 {{ ribRev.allowanceMm }}mm），
            净料 {{ ribRev.netStockMm.toFixed(1) }}mm；写回后复核竖篾净长 {{ ribRev.fittedNetMm.toFixed(1) }}mm，不超料。
            <span v-if="ribRev.capped">料极长，已取反推上限，直径可再手工调大。</span>
          </div>

          <div class="rev-row">
            <label>横篾整圈长 (mm)</label>
            <input v-model.number="ringInput" type="number" min="50" step="10" style="width: 90px" />
            <span v-if="ringRev.ok" class="mono rev-ok">
              → 圈直径 {{ ringRev.rawDiameterMm.toFixed(1) }}mm
              <em>（写回 ⌀{{ ringRev.roundedDiameterMm }} / 上口 ⌀{{ ringRev.mouthDiameterMm }} / 底口 ⌀{{ ringRev.baseDiameterMm }}mm；{{ toCm(ringRev.rawDiameterMm) }}cm）</em>
            </span>
            <span v-else class="rev-err">✋ {{ ringRev.error }}</span>
            <button :disabled="!ringRev.ok" @click="applyReverse(ringRev, 'ring')">应用</button>
          </div>
          <div v-if="ringRev.ok" class="rev-detail">
            输入为最粗处一圈合围所需的整根备料长（{{
              lantern.kind === 'prism' || lantern.kind === 'box'
                ? `多边形按 ${lantern.sides} 棱弦长公式，合围 = ${lantern.sides} × 2R·sin(π/${lantern.sides})，接头 ${lantern.sides} 处各扣 ${lantern.lashAllowanceMm}mm`
                : `圆形圈周长 2πR，接头 1 处扣 ${lantern.lashAllowanceMm}mm`
            }}）；
            净合围 {{ ringRev.netStockMm.toFixed(1) }}mm，写回后复核合围 {{ ringRev.fittedNetMm.toFixed(1) }}mm，闭合。
          </div>

          <small class="hint">
            两条反推同一套口径：先扣余量、多边形按棱数走弦长公式、结果按一位小数显示、写回按整毫米取整；
            竖篾选的是<b>保现有收口比例与总高</b>的路线——上口/底口随直径同比例缩放、分段高度不动，
            代价是直径非整数；不做整体等比缩放（那条路保不住造型与总高，同一输入还会越按越小）。
            同一根篾连按任意次结果一模一样；点应用后上方三个直径、各层直径列与右侧放样预览同步刷新，
            被刷新处会短暂高亮，哪处还是老数一眼可辨。
          </small>
        </template>
      </div>
    </section>

    <section class="viewer">
      <div class="tabs">
        <button :class="{ on: mode === 'front' }" @click="mode = 'front'">正视图</button>
        <button :class="{ on: mode === 'top' }" @click="mode = 'top'">俯视图</button>
        <button :class="{ on: mode === 'iso' }" @click="mode = 'iso'">等轴测</button>
        <span v-if="lantern.mouthStyle === 'gourd'" class="tip">拖动绿色控制点可改葫芦口曲线</span>
      </div>

      <div class="canvas">
        <LanternPreview
          :lantern="lantern"
          :mode="mode"
          interactive
          @update-ctrl="onCtrl"
        />
      </div>

      <div v-if="full" class="stats">
        <div class="stat"><span>构件总数</span><b>{{ full.frame.totalQty }}</b></div>
        <div class="stat"><span>竹篾备料</span><b>{{ full.materials.frameM.toFixed(3) }} m</b></div>
        <div class="stat"><span>净长合计</span><b>{{ full.materials.frameRawM.toFixed(3) }} m</b></div>
        <div class="stat"><span>裁片块数</span><b>{{ full.panels.totalQty }}</b></div>
        <div class="stat"><span>蒙面（含缝份）</span><b>{{ full.materials.coveringM2.toFixed(3) }} m²</b></div>
        <div class="stat"><span>灯体表面积</span><b>{{ full.materials.surfaceM2.toFixed(3) }} m²</b></div>
        <div class="stat"><span>灯体体积</span><b>{{ full.materials.volumeL.toFixed(3) }} L</b></div>
        <div class="stat"><span>1:1 图纸</span><b>{{ full.sheets.length }} 页（{{ lantern.pageSize }}）</b></div>
      </div>

      <p v-if="poly" class="poly-note">
        正{{ poly.kind === 'tetra' ? '四' : '八' }}面体：外接球 ⌀{{ (poly.circumR * 2).toFixed(1) }}mm →
        棱长 {{ poly.edgeMm.toFixed(1) }}mm，灯体总高 {{ poly.heightMm.toFixed(1) }}mm（由棱长推算）
      </p>

      <div v-if="panelsPreview.length" class="mini">
        <h4>裁片概览（详见「蒙面裁片」页）</h4>
        <ul>
          <li v-for="p in panelsPreview" :key="p.id">
            <span class="dot" :style="{ background: p.color }" />
            {{ p.label }}：裁切 {{ p.widthTopMm.toFixed(1) }}×{{ p.heightMm.toFixed(1) }}mm × {{ p.qty }} 块
          </li>
        </ul>
      </div>

      <ChecksPanel v-if="full" :checks="full.checks" :elapsed-ms="full.elapsedMs" title="参数自检" />
    </section>
  </div>
</template>

<style scoped>
.design {
  display: grid;
  grid-template-columns: minmax(340px, 420px) 1fr;
  gap: 18px;
  align-items: start;
}

@media (max-width: 1100px) {
  .design {
    grid-template-columns: 1fr;
  }
}

.params,
.viewer > .canvas,
.stats,
.mini {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
}

.params {
  padding: 16px 18px 20px;
}

.params h2 {
  margin: 0 0 14px;
  font-size: 16px;
  color: var(--ink);
  border-left: 4px solid var(--red);
  padding-left: 10px;
}

.params h3 {
  margin: 18px 0 8px;
  font-size: 13px;
  color: var(--ink-soft);
  text-transform: none;
  letter-spacing: 0.4px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.row {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}

label {
  font-size: 12px;
  color: var(--ink-soft);
}

label em {
  font-style: normal;
  font-family: var(--mono);
  color: var(--blue);
}

input[type='text'],
input[type='number'],
select {
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  width: 100%;
  font-family: var(--mono);
}

input[readonly] {
  background: var(--surface-2);
  color: var(--ink-soft);
}

input:disabled {
  background: #f2ece1;
  color: #a89a89;
}

input[type='range'] {
  width: 100%;
  accent-color: var(--red);
}

input[type='color'] {
  width: 44px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: #fff;
}

small {
  font-size: 11px;
  color: var(--ink-soft);
}

.hint {
  display: block;
  margin-top: 6px;
}

.warn-line {
  margin: 10px 0 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #8a4b12;
  background: #fdf3e2;
  border: 1px solid #e8cfa4;
  border-radius: 6px;
}

.layers {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.layers th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
}

.layers td {
  padding: 3px 6px;
  border-bottom: 1px dashed var(--line);
}

.layers input[type='number'] {
  width: 78px;
  padding: 3px 6px;
}

.mono {
  font-family: var(--mono);
}

.reverse {
  background: var(--surface-2);
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  padding: 10px;
}

.rev-blocked {
  font-size: 12px;
  color: var(--ink-soft);
  padding: 6px 2px;
}

.rev-ok em {
  font-style: normal;
  color: var(--ink-soft);
  font-size: 11px;
}

.rev-err {
  flex: 1;
  color: #b03a2e;
  font-size: 11px;
  line-height: 1.45;
}

.rev-detail {
  margin: -2px 0 10px 116px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-soft);
}

/* 反推写回后的三处联动高亮：参数格 / 各层直径列一起闪，老数漏刷一眼可辨 */
.refreshed {
  animation: rev-flash 1.2s ease-out;
  border-radius: 4px;
}

@keyframes rev-flash {
  0% {
    background: #fff2bf;
    box-shadow: 0 0 0 2px rgba(190, 150, 30, 0.55);
  }
  100% {
    background: transparent;
    box-shadow: none;
  }
}

.rev-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}

.rev-row label {
  width: 108px;
}

.rev-row input {
  width: 90px;
}

.rev-row span {
  flex: 1;
  color: var(--blue);
  white-space: nowrap;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  padding: 4px 10px;
  font-size: 12px;
}

button:hover {
  border-color: var(--red);
  color: var(--red);
}

.viewer {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tabs {
  display: flex;
  gap: 6px;
  align-items: center;
}

.tabs button.on {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
  font-weight: 600;
}

.tabs .tip {
  margin-left: auto;
  font-size: 12px;
  color: var(--jade);
}

.canvas {
  height: 440px;
  padding: 8px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
  gap: 1px;
  overflow: hidden;
  background: var(--line);
}

.stat {
  background: var(--surface);
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat span {
  font-size: 11px;
  color: var(--ink-soft);
}

.stat b {
  font-family: var(--mono);
  font-size: 14px;
  color: var(--ink);
}

.poly-note,
.mini {
  margin: 0;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--ink-soft);
}

.mini h4 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--ink);
}

.mini ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  margin-right: 6px;
  border: 1px solid var(--line-strong);
}

.missing {
  padding: 40px;
  text-align: center;
  color: var(--ink-soft);
}
</style>
