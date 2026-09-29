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
  /** 普通模式：所有物种根→叶深度之和；容错模式：所有可发生回答路径（叶）的提问数之和 */
  totalDepth: number;
  /** 是否按“允许一次观察错误”生成（同一特征可在一条路径上重复提问） */
  allowOneMistake: boolean;
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
/** “允许一次观察错误”模式最多支持 6 个物种、6 个特征 */
const MISTAKE_MODE_LIMIT = 6;

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
  return { root: root.node, worstDepth: root.worst, totalDepth: root.total, allowOneMistake: false };
}

/**
 * 容错模式求解（整个回答序列中至多一次是/否与真实物种矩阵不符）。
 *
 * 状态不是单一候选物种集合，而是两个集合：
 *   - S0：与迄今全部回答都相符的物种（发生过 0 次不符）；
 *   - S1：与迄今回答恰好一处不符的物种（发生过 1 次不符，后续必须全相符）。
 * 对特征 f 回答“是”时：
 *   S0 中具备 f 者、S1 中具备 f 者回答相符，留在各自集合；
 *   S0 中不具备 f 者用掉唯一的容错额度，落入新 S1；
 *   S1 中不具备 f 者将出现第二次不符，永久淘汰。
 * 回答“否”对称。
 *
 * 终态：|S0 ∪ S1| ≤ 1 时出叶（0 个表示该回答序列对任何真实物种都需 ≥2
 * 次错误，不可能发生；1 个即唯一候选）。同一特征允许重复提问。
 * 只考虑能真正分裂当前候选并集的特征（f 在候选中 0、1 取值都存在）：
 * 取值恒定的提问有一侧状态与现状完全相同，毫无信息，绝不可能最优；
 * 跳过它也保证递归终止——每次转移都有物种沿 S0→S1→淘汰 单调移动。
 *
 * 指标只统计可发生的回答路径：
 *   1. 最小化最坏提问数（可发生叶的最大深度）；
 *   2. 最小化这些路径的提问数之和（每条根→叶回答序列算一条）；
 *   3. 特征 id 字节序裁决。
 *
 * 每个物种在状态中三选一（S0 / S1 / 淘汰），状态数不超过 3^n，
 * n ≤ 6 时极小，用 ((S1 << n) | S0) 编码记忆化。
 */
function solveOneMistake(input: KeyInput): KeyTree {
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

  interface MistakeOpt {
    node: TreeNode;
    /** 从该状态出发，沿每条可发生回答路径的最坏追加提问数 */
    worst: number;
    /** 从该状态出发，各可发生叶的追加提问数之和 */
    total: number;
    /** 从该状态出发的可发生叶（回答序列）数 */
    paths: number;
  }

  const memo = new Map<number, MistakeOpt>();

  function dp(s0: number, s1: number): MistakeOpt {
    const union = s0 | s1;
    if ((union & (union - 1)) === 0) {
      // union===0：任何真实物种都需 ≥2 次错误才能走出这条回答序列，
      // 属于不可能路径；只对真正分裂候选的提问递归，正常树中不会到达，
      // 这里给一个不参与指标的防御性叶节点。
      if (union === 0) {
        return {
          node: { kind: 'leaf', speciesIndex: 0, speciesId: input.species[0] },
          worst: 0,
          total: 0,
          paths: 0,
        };
      }
      // 唯一候选：可发生路径收敛到该物种
      const index = 31 - Math.clz32(union);
      return {
        node: { kind: 'leaf', speciesIndex: index, speciesId: input.species[index] },
        worst: 0,
        total: 0,
        paths: 1,
      };
    }

    const key = (s1 << n) | s0;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let best: MistakeOpt | null = null;
    for (let f = 0; f < m; f++) {
      const has = colMask[f];
      // f 必须在当前候选中同时取到 0 和 1，否则该问无信息（一侧状态不变）
      if ((union & has) === 0 || (union & ~has) === 0) continue;

      // 回答“是”：相符者（具备 f）留在原集合；S0 中不具备 f 者用掉额度进入 S1
      const yes0 = s0 & has;
      const yes1 = (s1 & has) | (s0 & ~has);
      // 回答“否”：相符者（不具备 f）留在原集合；S0 中具备 f 者用掉额度进入 S1
      const no0 = s0 & ~has;
      const no1 = (s1 & ~has) | (s0 & has);

      const yesOpt = dp(yes0, yes1);
      const noOpt = dp(no0, no1);

      // 每条进入该状态的回答历史在本节点多问一次：
      // 路径数 = 两侧可发生叶数之和；提问数 = 两侧追加和 + 每条路径本层的 1 次
      const paths = yesOpt.paths + noOpt.paths;
      const candidate: MistakeOpt = {
        worst: 1 + Math.max(yesOpt.worst, noOpt.worst),
        total: yesOpt.total + noOpt.total + paths,
        paths,
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

    // 物种向量互异时容错树必然存在（对普通树的每个问题问三遍、按多数回答走即可）
    if (best === null) {
      throw new Error('容错状态下不存在能继续分裂候选的特征');
    }
    memo.set(key, best);
    return best;
  }

  const root = dp(fullMask, 0);
  return {
    root: root.node,
    worstDepth: root.worst,
    totalDepth: root.total,
    allowOneMistake: true,
  };
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
 *
 * allowOneMistake 为真时生成容忍一次是/否观察错误的决策树（同一特征
 * 可重复提问），该模式最多支持 6 个物种、6 个特征。
 */
export function buildKey(input: KeyInput): KeyResult {
  validateMatrix(input);
  if (input.allowOneMistake) {
    if (input.species.length > MISTAKE_MODE_LIMIT) {
      throw new Error(
        `“允许一次观察错误”模式最多支持 ${MISTAKE_MODE_LIMIT} 个物种（当前 ${input.species.length}）`,
      );
    }
    if (input.features.length > MISTAKE_MODE_LIMIT) {
      throw new Error(
        `“允许一次观察错误”模式最多支持 ${MISTAKE_MODE_LIMIT} 个特征（当前 ${input.features.length}）`,
      );
    }
  }
  const pair = findIndistinguishablePair(input);
  if (pair !== null) {
    return { status: 'INDISTINGUISHABLE', pair };
  }
  return {
    status: 'ok',
    tree: input.allowOneMistake ? solveOneMistake(input) : solve(input),
  };
}
