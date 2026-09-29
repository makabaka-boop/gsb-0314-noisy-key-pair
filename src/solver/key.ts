/**
 * 二歧检索表最优决策树求解器（纯逻辑，不依赖 DOM）。
 *
 * 优化目标（按优先级）：
 *   1. 最小化最坏提问数（树高，叶到根的边数）；
 *   2. 并列时最小化所有物种路径长度之和；
 *   3. 仍并列时按特征 id 字节序（逐字节字典序）裁决。
 *
 * 物种 id 与特征 id 均为唯一 ASCII 字符串：
 *   - 物种 3–16 个；
 *   - 特征 2–16 个；
 *   - 矩阵为完整的 物种×特征 0/1 矩阵。
 */

export type Matrix = number[][];

export interface KeyInput {
  species: string[];
  features: string[];
  /** matrix[s][f] === 1 表示物种 s 具备特征 f */
  matrix: Matrix;
  /** Permit one incorrect yes/no observation during identification. */
  allowOneMistake?: boolean;
}

/** 内部判定节点：对该特征提问，进入是/否子树 */
export interface QuestionNode {
  kind: 'question';
  featureId: string;
  featureIndex: number;
  yes: TreeNode;
  no: TreeNode;
}

/** 叶节点：候选物种唯一，识别完成 */
export interface LeafNode {
  kind: 'leaf';
  speciesId: string;
  speciesIndex: number;
}

export type TreeNode = QuestionNode | LeafNode;

export interface KeyTree {
  root: TreeNode;
  /** 最坏提问数 = 最大根→叶深度（根处提问计数 1） */
  worstDepth: number;
  /**
   * 路径长度之和。
   * 普通模式：所有物种根→叶深度之和（每物种恰有一个叶）；
   * 容错模式：所有“可发生的回答路径”（叶）根→叶深度之和——同一物种
   * 可能在不同叶处被识别（错误出现在不同问题上）。
   */
  totalDepth: number;
  /** 是否按“允许一次观察错误”语义生成（同一特征可在路径上重复提问）。 */
  allowOneMistake?: boolean;
}

export interface DistinguishableResult {
  status: 'ok';
  tree: KeyTree;
}

export interface IndistinguishableResult {
  status: 'INDISTINGUISHABLE';
  /** 特征向量相同的、物种 id 最小的一对 */
  pair: [string, string];
}

export type KeyResult = DistinguishableResult | IndistinguishableResult;

const SPECIES_MIN = 3;
const SPECIES_MAX = 16;
const FEATURE_MIN = 2;
const FEATURE_MAX = 16;

/**
 * 按 ASCII 字节序比较两个字符串。
 * 调用方已保证输入仅含 ASCII，因此逐 charCode 比较即为逐字节比较。
 */
export function compareByteOrder(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isAsciiToken(id: string): boolean {
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * 解析并校验一行一个 id 的 ASCII 列表。
 * 空行（含纯空白行）忽略；重复时抛出第一个重复 id。
 */
export function parseIdList(
  text: string,
  min: number,
  max: number,
  label: string,
): string[] {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < min || lines.length > max) {
    throw new Error(`${label}数量必须在 ${min}–${max} 之间（当前 ${lines.length}）`);
  }
  const seen = new Set<string>();
  for (const id of lines) {
    if (!isAsciiToken(id)) {
      throw new Error(`${label} id 必须为非空 ASCII 可见字符：“${id}”`);
    }
    if (seen.has(id)) {
      throw new Error(`${label} id 必须唯一，发现重复：“${id}”`);
    }
    seen.add(id);
  }
  return lines;
}

export function parseSpecies(text: string): string[] {
  return parseIdList(text, SPECIES_MIN, SPECIES_MAX, '物种');
}

export function parseFeatures(text: string): string[] {
  return parseIdList(text, FEATURE_MIN, FEATURE_MAX, '特征');
}

/** 校验完整矩阵的维度与取值。 */
export function validateMatrix(input: KeyInput): void {
  const { species, features, matrix } = input;
  if (species.length < SPECIES_MIN || species.length > SPECIES_MAX) {
    throw new Error(`物种数量必须在 ${SPECIES_MIN}–${SPECIES_MAX} 之间`);
  }
  if (features.length < FEATURE_MIN || features.length > FEATURE_MAX) {
    throw new Error(`特征数量必须在 ${FEATURE_MIN}–${FEATURE_MAX} 之间`);
  }
  if (new Set(species).size !== species.length) {
    throw new Error('物种 id 必须唯一');
  }
  if (new Set(features).size !== features.length) {
    throw new Error('特征 id 必须唯一');
  }
  if (matrix.length !== species.length) {
    throw new Error(`矩阵行数 ${matrix.length} 与物种数 ${species.length} 不一致`);
  }
  matrix.forEach((row, s) => {
    if (row.length !== features.length) {
      throw new Error(
        `物种 ${species[s]} 的行长度 ${row.length} 与特征数 ${features.length} 不一致`,
      );
    }
    row.forEach((v, f) => {
      if (v !== 0 && v !== 1) {
        throw new Error(`矩阵单元 (${species[s]}, ${features[f]}) 必须为 0 或 1`);
      }
    });
  });
}

/**
 * 返回特征向量完全相同的、id 最小的物种对（均按字节序排列）；
 * 全部唯一时返回 null。
 */
export function findIndistinguishablePair(input: KeyInput): [string, string] | null {
  const groups = new Map<string, number[]>();
  input.matrix.forEach((row, s) => {
    const key = row.join('');
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(s);
    } else {
      groups.set(key, [s]);
    }
  });

  let best: [string, string] | null = null;
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const ids = indices.map((s) => input.species[s]).sort(compareByteOrder);
    for (let i = 0; i < ids.length - 1; i++) {
      const candidate: [string, string] = [ids[i], ids[i + 1]];
      if (
        best === null ||
        compareByteOrder(candidate[0], best[0]) < 0 ||
        (candidate[0] === best[0] && compareByteOrder(candidate[1], best[1]) < 0)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

interface SubtreeOpt {
  node: TreeNode;
  worst: number;
  total: number;
}

/**
 * 记忆化动态规划。
 * 状态为物种集合的位掩码；对每个能真正分裂该集合的特征取
 * (max(子树最坏深度), 子树路径和, 特征字节序) 的最小者。
 */
function solve(input: KeyInput): KeyTree {
  const n = input.species.length;
  const m = input.features.length;
  const fullMask = (1 << n) - 1;

  // colMask[f]: 具备特征 f 的物种集合
  const colMask = new Array<number>(m).fill(0);
  for (let s = 0; s < n; s++) {
    for (let f = 0; f < m; f++) {
      if (input.matrix[s][f] === 1) colMask[f] |= 1 << s;
    }
  }

  const memo = new Map<number, SubtreeOpt>();

  function dp(mask: number): SubtreeOpt {
    if ((mask & (mask - 1)) === 0) {
      // 单个候选物种：识别完成，无需再提问
      const index = 31 - Math.clz32(mask);
      return {
        node: { kind: 'leaf', speciesIndex: index, speciesId: input.species[index] },
        worst: 0,
        total: 0,
      };
    }
    const cached = memo.get(mask);
    if (cached !== undefined) return cached;

    let best: SubtreeOpt | null = null;
    for (let f = 0; f < m; f++) {
      const yesMask = mask & colMask[f];
      const noMask = mask & ~colMask[f];
      // 必须真正分裂当前候选集合，否则不是合法二歧问题
      if (yesMask === 0 || noMask === 0) continue;

      const yesOpt = dp(yesMask);
      const noOpt = dp(noMask);
      const candidate: SubtreeOpt = {
        worst: 1 + Math.max(yesOpt.worst, noOpt.worst),
        total: yesOpt.total + noOpt.total + popcount(mask),
        node: {
          kind: 'question',
          featureIndex: f,
          featureId: input.features[f],
          yes: yesOpt.node,
          no: noOpt.node,
        },
      };
      if (
        best === null ||
        candidate.worst < best.worst ||
        (candidate.worst === best.worst && candidate.total < best.total) ||
        (candidate.worst === best.worst &&
          candidate.total === best.total &&
          compareByteOrder(input.features[f], (best.node as QuestionNode).featureId) < 0)
      ) {
        best = candidate;
      }
    }

    // 调用方已先排除重复特征向量；非单元素集合必然存在可分裂特征
    if (best === null) {
      throw new Error('候选物种集合无法被任何特征分裂');
    }
    memo.set(mask, best);
    return best;
  }

  const root = dp(fullMask);
  return { root: root.node, worstDepth: root.worst, totalDepth: root.total };
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const MISTAKE_SPECIES_MAX = 6;
const MISTAKE_FEATURE_MAX = 6;

interface MistakeSubtreeOpt {
  node: TreeNode;
  worst: number;
  total: number;
  leaves: number;
}

/**
 * “允许一次观察错误”模式的记忆化 DP。
 *
 * 状态 (exact, loose)：
 *   - exact 中的物种：迄今每次回答都与其矩阵完全一致（还可容忍一次错误）；
 *   - loose 中的物种：迄今回答恰有一次与其矩阵不符（错误名额已用完）；
 *   - 其余物种：不符次数 ≥ 2，已被排除。
 * exact 与 loose 互不相交。
 *
 * 对特征 f 回答“是”（b=1）后：
 *   exactYes = exact ∩ col[f]，looseYes = (exact ∖ col[f]) ∪ (loose ∩ col[f])；
 * 回答“否”对称。每个分支的候选都必须非空——否则该回答路径无法收敛，
 * 该提问非法。同一特征可反复提问；若某分支状态与当前状态完全相同（
 * 该特征对整个候选集是常数列，回答不改变任何信息），跳过以免零进展。
 *
 * 目标（按优先级）：1) 最小化所有可发生回答路径的最坏提问数；
 * 2) 最小化这些路径总提问数（= 所有叶深度之和）；3) 特征 id 字节序。
 */
function solveMistake(input: KeyInput): KeyTree {
  const n = input.species.length;
  const m = input.features.length;
  const fullMask = (1 << n) - 1;

  const colMask = new Array<number>(m).fill(0);
  for (let s = 0; s < n; s++) {
    for (let f = 0; f < m; f++) {
      if (input.matrix[s][f] === 1) colMask[f] |= 1 << s;
    }
  }

  const memo = new Map<number, MistakeSubtreeOpt>();

  function stateKey(exact: number, loose: number): number {
    return exact | (loose << n);
  }

  function leafFor(mask: number): MistakeSubtreeOpt {
    const index = 31 - Math.clz32(mask);
    return {
      node: { kind: 'leaf', speciesIndex: index, speciesId: input.species[index] },
      worst: 0,
      total: 0,
      leaves: 1,
    };
  }

  function dp(exact: number, loose: number): MistakeSubtreeOpt {
    const alive = exact | loose;
    if ((alive & (alive - 1)) === 0) {
      // 唯一候选：该路径必须在此收敛为一个叶
      return leafFor(alive);
    }
    const key = stateKey(exact, loose);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let best: MistakeSubtreeOpt | null = null;
    for (let f = 0; f < m; f++) {
      const col = colMask[f];

      // 回答“是”：exact 里本有 f 的保持全对；本无 f 的花掉容错名额；
      // loose 里本有 f 的仍只差一次；本无 f 的差到两次，被淘汰。
      const exactYes = exact & col;
      const looseYes = (exact & ~col) | (loose & col);
      // 回答“否”：对称
      const exactNo = exact & ~col;
      const looseNo = (exact & col) | (loose & ~col);

      // 每条可发生的回答路径都必须能继续并最终收敛：两侧候选都不能为空
      if ((exactYes | looseYes) === 0 || (exactNo | looseNo) === 0) continue;
      // 零信息分支（常数列）会原地不动，禁止以保证提问数严格下降
      if (
        (exactYes === exact && looseYes === loose) ||
        (exactNo === exact && looseNo === loose)
      ) {
        continue;
      }

      const yesOpt = dp(exactYes, looseYes);
      const noOpt = dp(exactNo, looseNo);
      const candidate: MistakeSubtreeOpt = {
        worst: 1 + Math.max(yesOpt.worst, noOpt.worst),
        total: yesOpt.total + noOpt.total + yesOpt.leaves + noOpt.leaves,
        leaves: yesOpt.leaves + noOpt.leaves,
        node: {
          kind: 'question',
          featureIndex: f,
          featureId: input.features[f],
          yes: yesOpt.node,
          no: noOpt.node,
        },
      };
      if (
        best === null ||
        candidate.worst < best.worst ||
        (candidate.worst === best.worst && candidate.total < best.total) ||
        (candidate.worst === best.worst &&
          candidate.total === best.total &&
          compareByteOrder(input.features[f], (best.node as QuestionNode).featureId) < 0)
      ) {
        best = candidate;
      }
    }

    // 物种向量互异已在调用方保证：对任何非单元素 (exact, loose) 状态，
    // 总能找到在候选间取值不同的特征形成进展分裂
    if (best === null) {
      throw new Error('容错检索表：候选物种集合无法被任何特征进一步分裂');
    }
    memo.set(key, best);
    return best;
  }

  // 起点：尚未提问，所有物种迄今零次不符
  const root = dp(fullMask, 0);
  return {
    root: root.node,
    worstDepth: root.worst,
    totalDepth: root.total,
    allowOneMistake: true,
  };
}

/**
 * 构建检索表。
 * 若存在特征向量完全相同的物种，返回 INDISTINGUISHABLE 与 id 最小的一对，
 * 绝不伪造一棵无法可靠区分的识别树；否则返回最优决策树。
 *
 * allowOneMistake 为真时，按“整个回答序列最多一次观察错误”生成容错树
 * （同一特征可重复提问，每条可发生的回答路径都收敛到唯一物种）；
 * 该模式最多支持 6 个物种、6 个特征。
 */
export function buildKey(input: KeyInput): KeyResult {
  validateMatrix(input);
  if (input.allowOneMistake) {
    if (input.species.length > MISTAKE_SPECIES_MAX) {
      throw new Error(
        `“一次观察错误”模式最多支持 ${MISTAKE_SPECIES_MAX} 个物种（当前 ${input.species.length}）`,
      );
    }
    if (input.features.length > MISTAKE_FEATURE_MAX) {
      throw new Error(
        `“一次观察错误”模式最多支持 ${MISTAKE_FEATURE_MAX} 个特征（当前 ${input.features.length}）`,
      );
    }
  }
  const pair = findIndistinguishablePair(input);
  if (pair !== null) {
    return { status: 'INDISTINGUISHABLE', pair };
  }
  return {
    status: 'ok',
    tree: input.allowOneMistake ? solveMistake(input) : solve(input),
  };
}
