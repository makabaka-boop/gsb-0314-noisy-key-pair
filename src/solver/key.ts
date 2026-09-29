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
  /** 所有物种根→叶深度之和 */
  totalDepth: number;
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

/**
 * 构建检索表。
 * 若存在特征向量完全相同的物种，返回 INDISTINGUISHABLE 与 id 最小的一对，
 * 绝不伪造一棵无法可靠区分的识别树；否则返回最优决策树。
 */
export function buildKey(input: KeyInput): KeyResult {
  validateMatrix(input);
  const pair = findIndistinguishablePair(input);
  if (pair !== null) {
    return { status: 'INDISTINGUISHABLE', pair };
  }
  return { status: 'ok', tree: solve(input) };
}
