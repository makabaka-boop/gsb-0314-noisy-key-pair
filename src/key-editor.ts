import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  buildKey,
  parseFeatures,
  parseSpecies,
  type KeyResult,
  type LeafNode,
  type QuestionNode,
  type TreeNode,
} from './solver/key.js';

interface AnswerStep {
  node: QuestionNode;
  answer: 0 | 1;
}

const DEFAULT_SPECIES = ['ant', 'bat', 'bee', 'cat'].join('\n');
const DEFAULT_FEATURES = ['flying', 'furry'].join('\n');
//         flying furry
// ant       0      0
// bat       1      1
// bee       1      0
// cat       0      1
const DEFAULT_MATRIX: number[][] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

/**
 * 交互式二歧检索表编辑器。
 *
 * - 输入 3–16 个唯一 ASCII 物种、2–16 个唯一 ASCII 二值特征及完整矩阵；
 * - 存在重复特征向量时显示 INDISTINGUISHABLE 与最小 id 物种对，不伪造识别树；
 * - 其余情况生成最小化最坏提问数（其次总路径、特征字节序）的决策树；
 * - 任何编辑都使旧树立即失效（stale），需重新生成。
 */
@customElement('key-editor')
export class KeyEditor extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      color: #1f2933;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1.25rem;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    section.card {
      background: #fff;
      border: 1px solid #d3d9df;
      border-radius: 10px;
      padding: 1rem 1.1rem;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    h2 {
      margin: 0 0 0.6rem;
      font-size: 1rem;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
      padding: 0.5rem;
      border: 1px solid #b8c0c8;
      border-radius: 6px;
      resize: vertical;
    }
    .hint {
      color: #6b7684;
      font-size: 0.78rem;
      margin: 0.3rem 0 0;
    }
    table.matrix {
      border-collapse: collapse;
      margin-top: 0.5rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
    }
    table.matrix th,
    table.matrix td {
      border: 1px solid #cbd2d9;
      padding: 0.25rem 0.55rem;
      text-align: center;
      white-space: nowrap;
    }
    table.matrix th.rowhead,
    table.matrix td.rowhead {
      text-align: left;
    }
    td.cell {
      cursor: pointer;
      user-select: none;
      min-width: 3.2rem;
      font-weight: 600;
    }
    td.cell.one {
      background: #d8effc;
    }
    td.cell.zero {
      background: #f4f6f8;
      color: #98a3af;
    }
    button {
      font: inherit;
      border: 1px solid #2b6cb0;
      background: #2b6cb0;
      color: #fff;
      border-radius: 6px;
      padding: 0.45rem 1rem;
      cursor: pointer;
    }
    button:hover {
      background: #255a94;
    }
    button.secondary {
      background: #fff;
      color: #2b6cb0;
    }
    button.secondary:hover {
      background: #eef4fb;
    }
    .stale {
      background: #fff8e1;
      border: 1px solid #e8c547;
      border-radius: 6px;
      padding: 0.5rem 0.7rem;
      font-size: 0.85rem;
      margin-bottom: 0.7rem;
    }
    .error {
      background: #fde8e8;
      border: 1px solid #e29c9c;
      border-radius: 6px;
      padding: 0.5rem 0.7rem;
      font-size: 0.85rem;
      white-space: pre-wrap;
    }
    .indist {
      background: #fde8e8;
      border: 1px solid #d9534f;
      border-radius: 8px;
      padding: 0.7rem 0.9rem;
    }
    .indist code,
    code {
      background: #eef1f4;
      padding: 0 0.3rem;
      border-radius: 4px;
    }
    .stale-block {
      opacity: 0.55;
      pointer-events: none;
    }
    .metrics {
      color: #4a5563;
      font-size: 0.85rem;
      margin: 0.2rem 0 0.8rem;
    }
    ul.tree,
    ul.tree ul {
      list-style: none;
      padding-left: 1.1rem;
      border-left: 1px dotted #9aa5b1;
      margin: 0.15rem 0;
    }
    ul.tree {
      padding-left: 0;
      border-left: none;
    }
    .qnode > .label::before {
      content: '？ ';
      color: #2b6cb0;
    }
    .lnode::before {
      content: '➤ ';
      color: #2f855a;
    }
    .branch-no {
      color: #975a16;
    }
    .branch-yes {
      color: #276749;
    }
    .identify {
      background: #f0f7ff;
      border: 1px solid #b9d7f2;
      border-radius: 8px;
      padding: 0.7rem 0.9rem;
      margin-top: 1rem;
    }
    .identify .ask {
      font-size: 1.05rem;
      font-weight: 600;
      margin: 0.3rem 0 0.7rem;
    }
    .answer-row {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .history {
      margin: 0.6rem 0 0;
      padding-left: 1.1rem;
      font-size: 0.85rem;
      color: #52606d;
    }
    .history button {
      padding: 0 0.4rem;
      font-size: 0.78rem;
      margin-left: 0.35rem;
      background: #fff;
      color: #2b6cb0;
      border-color: #b9d7f2;
    }
    .result-leaf {
      font-size: 1.15rem;
      font-weight: 700;
      color: #276749;
    }
    .candidates {
      font-size: 0.82rem;
      color: #52606d;
      margin-top: 0.3rem;
    }
  `;

  @state() private speciesText = DEFAULT_SPECIES;
  @state() private featuresText = DEFAULT_FEATURES;
  @state() private matrix: number[][] = DEFAULT_MATRIX.map((row) => [...row]);
  @state() private result: KeyResult | null = null;
  @state() private stale = false;
  @state() private error: string | null = null;
  @state() private path: AnswerStep[] = [];
  @state() private allowOneMistake = false;
  /** 生成当前树时使用的快照；候选计算以此为准，避免编辑中矩阵污染识别过程 */
  @state() private builtSpecies: string[] = [];
  @state() private builtMatrix: number[][] = [];

  private currentSpecies(): string[] {
    return this.speciesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private currentFeatures(): string[] {
    return this.featuresText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** 编辑 id 列表后裁剪/扩展矩阵，保留共享单元，旧树立即失效。 */
  private resizeMatrix(): void {
    const n = this.currentSpecies().length;
    const m = this.currentFeatures().length;
    const next: number[][] = [];
    for (let s = 0; s < n; s++) {
      const row: number[] = [];
      for (let f = 0; f < m; f++) {
        row.push(this.matrix[s]?.[f] ?? 0);
      }
      next.push(row);
    }
    this.matrix = next;
  }

  private invalidate(): void {
    this.stale = true;
    this.path = [];
  }

  private onSpeciesInput(e: Event): void {
    this.speciesText = (e.target as HTMLTextAreaElement).value;
    this.resizeMatrix();
    this.invalidate();
  }

  private onFeaturesInput(e: Event): void {
    this.featuresText = (e.target as HTMLTextAreaElement).value;
    this.resizeMatrix();
    this.invalidate();
  }

  private toggleCell(s: number, f: number): void {
    this.matrix = this.matrix.map((row, si) =>
      si === s ? row.map((v, fi) => (fi === f ? (v === 1 ? 0 : 1) : v)) : row,
    );
    this.invalidate();
  }

  private generate(): void {
    try {
      const species = parseSpecies(this.speciesText);
      const features = parseFeatures(this.featuresText);
      const matrix = this.matrix.slice(0, species.length).map((row) =>
        row.slice(0, features.length),
      );
      this.result = buildKey({ species, features, matrix, allowOneMistake: this.allowOneMistake });
      this.builtSpecies = species;
      this.builtMatrix = matrix.map((row) => [...row]);
      this.stale = false;
      this.error = null;
      this.path = [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  /* ---------------- 识别过程：沿是/否分支行走并支持回溯 ---------------- */

  private currentNode(): TreeNode | null {
    if (!this.result || this.result.status !== 'ok') return null;
    let node: TreeNode = this.result.tree.root;
    for (const step of this.path) {
      if (node.kind !== 'question') return null;
      node = step.answer === 1 ? node.yes : node.no;
    }
    return node;
  }

  /**
   * 当前回答记录下的候选物种。
   * - 普通模式：物种必须与每一问的回答逐特征相符；
   * - 容错模式：保留与整条回答序列至多一处不符的物种，
   *   同一特征被重复提问时每次回答分别计数（不能用 Map 覆盖旧回答）。
   * 一律以生成树时的矩阵快照为准。
   */
  private candidateSpecies(): string[] {
    if (!this.result || this.result.status !== 'ok') return [];
    const tolerate = this.result.tree.allowOneMistake;
    return this.builtSpecies.filter((_, s) => {
      let mismatches = 0;
      for (const step of this.path) {
        if (this.builtMatrix[s]?.[step.node.featureIndex] !== step.answer) {
          mismatches++;
          if (!tolerate || mismatches > 1) return false;
        }
      }
      return true;
    });
  }

  private answer(value: 0 | 1): void {
    const node = this.currentNode();
    if (!node || node.kind !== 'question') return;
    this.path = [...this.path, { node, answer: value }];
  }

  private backtrack(to: number): void {
    this.path = this.path.slice(0, to);
  }

  private restartIdentification(): void {
    this.path = [];
  }

  /* ------------------------------ 渲染 ------------------------------ */

  private renderMatrix(): TemplateResult {
    const species = this.currentSpecies();
    const features = this.currentFeatures();
    return html`
      <table class="matrix">
        <thead>
          <tr>
            <th class="rowhead">物种 ＼ 特征</th>
            ${features.map((f) => html`<th>${f}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${species.map(
            (sp, s) => html`
              <tr>
                <td class="rowhead">${sp}</td>
                ${features.map(
                  (_, f) => html`
                    <td
                      class="cell ${this.matrix[s]?.[f] === 1 ? 'one' : 'zero'}"
                      title="点击切换 ${sp} / ${features[f]}"
                      @click=${() => this.toggleCell(s, f)}
                    >
                      ${this.matrix[s]?.[f] === 1 ? '1' : '0'}
                    </td>
                  `,
                )}
              </tr>
            `,
          )}
        </tbody>
      </table>
      <p class="hint">点击单元格在 0/1 之间切换；任何修改都会使旧检索表立即失效。</p>
    `;
  }

  private renderTree(node: TreeNode): TemplateResult {
    if (node.kind === 'leaf') {
      return html`
        <ul>
          <li class="lnode">${node.speciesId}</li>
        </ul>
      `;
    }
    return html`
      <ul>
        <li class="qnode">
          <span class="label">${node.featureId}?</span>
          <div><span class="branch-yes">是 →</span>${this.renderTree(node.yes)}</div>
          <div><span class="branch-no">否 →</span>${this.renderTree(node.no)}</div>
        </li>
      </ul>
    `;
  }

  private renderResult(): TemplateResult | typeof nothing {
    if (!this.result && !this.stale) return nothing;

    if (this.result?.status === 'INDISTINGUISHABLE') {
      if (this.stale) {
        return html`
          <div class="stale">
            矩阵或 id 已被修改，旧结论已失效。请点击“生成检索表”重新计算。
          </div>
        `;
      }
      const [a, b] = this.result.pair;
      return html`
        <div class="indist">
          <strong>INDISTINGUISHABLE</strong>
          <p>
            物种 <code>${a}</code> 与 <code>${b}</code>
            的全部二值特征完全相同，无法可靠区分。未生成识别树——请增加或修改特征后重试。
          </p>
        </div>
      `;
    }

    if (this.result?.status === 'ok') {
      const { tree } = this.result;
      const tolerate = tree.allowOneMistake;
      return html`
        ${this.stale
          ? html`
              <div class="stale">
                矩阵或 id 已被修改，下面的旧检索表已失效（识别已停用）。请点击“生成检索表”重新计算。
              </div>
            `
          : ''}
        <div class="metrics ${this.stale ? 'stale-block' : ''}">
          ${tolerate
            ? html`
                最坏提问数：<strong>${tree.worstDepth}</strong>　·　所有可发生回答路径提问数之和：<strong>${tree.totalDepth}</strong>
                <br />容错模式：允许整个回答序列中至多一次是/否观察错误，同一特征可能重复提问。
              `
            : html`
                最坏提问数：<strong>${tree.worstDepth}</strong>　·　所有物种路径长度之和：<strong>${tree.totalDepth}</strong>
              `}
        </div>
        <div class="tree ${this.stale ? 'stale-block' : ''}">${this.renderTree(tree.root)}</div>
        ${this.stale ? '' : this.renderIdentify()}
      `;
    }

    return html`
      <div class="stale">
        输入已被修改，尚未生成检索表。请点击“生成检索表”。
      </div>
    `;
  }

  private renderIdentify(): TemplateResult {
    const node = this.currentNode();
    const tolerate = this.result?.status === 'ok' && this.result.tree.allowOneMistake;
    const candidates = this.candidateSpecies();
    return html`
      <div class="identify">
        <h2 style="margin-bottom:0.2rem">实际识别</h2>
        ${tolerate
          ? html`<p class="hint" style="margin:0 0 0.4rem">容错识别中：候选保留与回答记录至多一处不符的物种；必要时同一特征会被重复提问核对。</p>`
          : ''}
        ${this.path.length > 0
          ? html`
              <ul class="history">
                ${this.path.map(
                  (step, i) => html`
                    <li>
                      ${step.node.featureId}? →
                      <strong class="${step.answer === 1 ? 'branch-yes' : 'branch-no'}">
                        ${step.answer === 1 ? '是' : '否'}
                      </strong>
                      <button class="secondary" @click=${() => this.backtrack(i)}>
                        回到此问
                      </button>
                    </li>
                  `,
                )}
              </ul>
            `
          : ''}
        ${node === null
          ? ''
          : node.kind === 'question'
            ? html`
                <p class="ask">${node.featureId}?</p>
                <div class="answer-row">
                  <button @click=${() => this.answer(1)}>是（具备）</button>
                  <button class="secondary" @click=${() => this.answer(0)}>否（不具备）</button>
                  ${this.path.length > 0
                    ? html`
                        <button class="secondary" @click=${() => this.backtrack(this.path.length - 1)}>
                          撤销上一步
                        </button>
                        <button class="secondary" @click=${() => this.restartIdentification()}>
                          重新开始
                        </button>
                      `
                    : ''}
                </div>
                <p class="candidates">
                  当前候选物种（${candidates.length}）：
                  ${candidates.join(', ')}
                </p>
              `
            : html`
                <p class="result-leaf">识别结果：${(node as LeafNode).speciesId}</p>
                <p class="candidates">
                  当前候选物种（${candidates.length}）：
                  ${candidates.join(', ')}
                </p>
                <div class="answer-row">
                  <button class="secondary" @click=${() => this.restartIdentification()}>
                    重新识别
                  </button>
                  <button class="secondary" @click=${() => this.backtrack(this.path.length - 1)}>
                    回溯上一步
                  </button>
                </div>
              `}
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="layout">
        <section class="card">
          <h2>物种（每行一个，3–16 个唯一 ASCII id）</h2>
          <textarea
            rows="6"
            .value=${this.speciesText}
            @input=${this.onSpeciesInput}
          ></textarea>
          <h2 style="margin-top:0.9rem">特征（每行一个，2–16 个唯一 ASCII id）</h2>
          <textarea
            rows="4"
            .value=${this.featuresText}
            @input=${this.onFeaturesInput}
          ></textarea>
          <h2 style="margin-top:0.9rem">物种 × 特征矩阵</h2>
          ${this.renderMatrix()}
          <label>
            <input type="checkbox" .checked=${this.allowOneMistake}
              @change=${(e: Event) => { this.allowOneMistake = (e.target as HTMLInputElement).checked; this.invalidate(); }} />
            允许识别过程中有一次是/否观察错误
          </label>
          <p style="margin-top:0.9rem">
            <button @click=${() => this.generate()}>生成检索表</button>
          </p>
          ${this.error ? html`<div class="error">${this.error}</div>` : ''}
        </section>
        <section class="card">
          <h2>检索表</h2>
          ${this.renderResult()}
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'key-editor': KeyEditor;
  }
}
