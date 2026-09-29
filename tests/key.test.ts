import { describe, expect, it } from 'vitest';
import {
  buildKey,
  compareByteOrder,
  findIndistinguishablePair,
  parseFeatures,
  parseSpecies,
  type KeyInput,
  type KeyTree,
  type LeafNode,
  type QuestionNode,
  type TreeNode,
} from '../src/solver/key.js';

/* ------------------------------------------------------------------ */
/* 独立的穷举参考求解器：显式枚举所有合法决策树（带记忆化），            */
/* 不使用生产代码的 DP 状态与比较逻辑，用于对拍。                        */
/* ------------------------------------------------------------------ */

interface BruteTree {
  node: TreeNode;
  worst: number;
  total: number;
}

function countBits(mask: number): number {
  let c = 0;
  while (mask) {
    mask &= mask - 1;
    c++;
  }
  return c;
}

/** 递归枚举候选集合上的每一棵合法决策树，返回最优树。 */
function bruteOptimal(
  input: KeyInput,
  mask: number,
  colMasks: number[],
  cache: Map<number, BruteTree>,
): BruteTree {
  if ((mask & (mask - 1)) === 0) {
    const index = 31 - Math.clz32(mask);
    return {
      node: { kind: 'leaf', speciesIndex: index, speciesId: input.species[index] },
      worst: 0,
      total: 0,
    };
  }
  const hit = cache.get(mask);
  if (hit) return hit;

  // 枚举顺序与裁决顺序无关：对每棵候选树做完整三元比较
  const candidates: BruteTree[] = [];
  for (let f = 0; f < input.features.length; f++) {
    const yesMask = mask & colMasks[f];
    const noMask = mask & ~colMasks[f];
    if (yesMask === 0 || noMask === 0) continue; // 不能真正分裂
    const y = bruteOptimal(input, yesMask, colMasks, cache);
    const n = bruteOptimal(input, noMask, colMasks, cache);
    candidates.push({
      worst: 1 + Math.max(y.worst, n.worst),
      total: y.total + n.total + countBits(mask),
      node: {
        kind: 'question',
        featureIndex: f,
        featureId: input.features[f],
        yes: y.node,
        no: n.node,
      },
    });
  }

  if (candidates.length === 0) throw new Error('brute: unsplittable set');
  candidates.sort((a, b) => {
    if (a.worst !== b.worst) return a.worst - b.worst;
    if (a.total !== b.total) return a.total - b.total;
    return compareByteOrder((a.node as QuestionNode).featureId, (b.node as QuestionNode).featureId);
  });
  const winner = candidates[0];
  cache.set(mask, winner);
  return winner;
}

function bruteSolve(input: KeyInput): KeyTree {
  const colMasks = new Array(input.features.length).fill(0);
  for (let s = 0; s < input.species.length; s++) {
    for (let f = 0; f < input.features.length; f++) {
      if (input.matrix[s][f]) colMasks[f] |= 1 << s;
    }
  }
  const full = (1 << input.species.length) - 1;
  const r = bruteOptimal(input, full, colMasks, new Map());
  return { root: r.node, worstDepth: r.worst, totalDepth: r.total, allowOneMistake: false };
}

/* ------------------------------------------------------------------ */
/* 独立统计/校验工具：沿着每个物种的特征向量实际走树，统计深度。         */
/* ------------------------------------------------------------------ */

function followPath(tree: TreeNode, input: KeyInput, speciesIndex: number): number {
  let node: TreeNode = tree;
  let depth = 0;
  while (node.kind === 'question') {
    depth++;
    const bit = input.matrix[speciesIndex][node.featureIndex];
    node = bit === 1 ? node.yes : node.no;
  }
  if (node.speciesIndex !== speciesIndex) {
    throw new Error(
      `树错误：输入物种 ${input.species[speciesIndex]} 被识别为 ${node.speciesId}`,
    );
  }
  return depth;
}

/** 独立遍历整棵树，核对每个叶覆盖且仅覆盖一个向量一致的物种。 */
function collectLeaves(node: TreeNode, depth: number, leaves: Array<[LeafNode, number]>): void {
  if (node.kind === 'leaf') {
    leaves.push([node, depth]);
    return;
  }
  collectLeaves(node.yes, depth + 1, leaves);
  collectLeaves(node.no, depth + 1, leaves);
}

/** 独立校验决策树合法性并返回 [最坏深度, 总深度]。 */
function statsByWalking(input: KeyInput, tree: KeyTree): [number, number] {
  const depths = input.species.map((_, s) => followPath(tree.root, input, s));
  const worst = Math.max(...depths);
  const total = depths.reduce((a, b) => a + b, 0);

  // 叶数与物种数一致
  const leaves: Array<[LeafNode, number]> = [];
  collectLeaves(tree.root, 0, leaves);
  expect(leaves.length).toBe(input.species.length);
  const leafIndices = leaves.map(([l]) => l.speciesIndex).sort((a, b) => a - b);
  expect(leafIndices).toEqual(input.species.map((_, i) => i));

  // 树深度统计与行走统计一致
  const walkWorst = Math.max(...leaves.map(([, d]) => d));
  const walkTotal = leaves.reduce((a, [, d]) => a + d, 0);
  expect(walkWorst).toBe(worst);
  expect(walkTotal).toBe(total);
  expect(tree.worstDepth).toBe(worst);
  expect(tree.totalDepth).toBe(total);

  // 每个内部节点的两侧都非空（真正二歧）
  const checkSplit = (n: TreeNode): void => {
    if (n.kind === 'leaf') return;
    expect(n.yes).toBeDefined();
    expect(n.no).toBeDefined();
    checkSplit(n.yes);
    checkSplit(n.no);
  };
  checkSplit(tree.root);

  return [worst, total];
}

/* ------------------------------------------------------------------ */

function makeInput(n: number, m: number, rows: number[][]): KeyInput {
  return {
    species: Array.from({ length: n }, (_, i) => `SP${String(i).padStart(2, '0')}`),
    features: Array.from({ length: m }, (_, i) => `F${String(i).padStart(2, '0')}`),
    matrix: rows.map((r) => [...r]),
  };
}

function expectTree(result: ReturnType<typeof buildKey>): KeyTree {
  expect(result.status).toBe('ok');
  return (result as { status: 'ok'; tree: KeyTree }).tree;
}

function q(node: TreeNode): QuestionNode {
  expect(node.kind).toBe('question');
  return node as QuestionNode;
}

/** 独立校验叶名：每个物种行走至叶时，叶 id 必须是该物种自己的名字。 */
function expectLeafNames(input: KeyInput, tree: KeyTree): void {
  for (let s = 0; s < input.species.length; s++) {
    let node: TreeNode = tree.root;
    while (node.kind === 'question') {
      node = input.matrix[s][node.featureIndex] === 1 ? node.yes : node.no;
    }
    expect(node.speciesId).toBe(input.species[s]);
  }
}

/** 对每一个 m 列 n 行的 0/1 矩阵都跑 DP/穷举对拍。 */
function exhaustAllMatrices(n: number, m: number): void {
  const total = 1 << (n * m);
  for (let bits = 0; bits < total; bits++) {
    const rows: number[][] = [];
    for (let s = 0; s < n; s++) {
      const row: number[] = [];
      for (let f = 0; f < m; f++) row.push((bits >> (s * m + f)) & 1);
      rows.push(row);
    }
    const input = makeInput(n, m, rows);
    const result = buildKey(input);
    const distinct = new Set(rows.map((r) => r.join(''))).size === n;
    if (!distinct) {
      expect(result.status).toBe('INDISTINGUISHABLE');
      const pair = (result as { pair: [string, string] }).pair;
      // 返回的必须确实是一对同向量物种
      const [a, b] = pair.map((id) => input.species.indexOf(id));
      expect(rows[a].join('')).toBe(rows[b].join(''));
      // 且是最小 id 对（SP00 起，编号小者最小）
      expect(findIndistinguishablePair(input)).toEqual(pair);
      continue;
    }
    const tree = expectTree(result);
    const reference = bruteSolve(input);
    statsByWalking(input, tree);
    expect(tree.worstDepth).toBe(reference.worstDepth);
    expect(tree.totalDepth).toBe(reference.totalDepth);
    expect(structureOf(tree.root)).toEqual(structureOf(reference.root));
  }
}

/** 只保留结构（特征下标 + 左右子树），便于与穷举树逐节点比对。 */
function structureOf(node: TreeNode): unknown {
  if (node.kind === 'leaf') return ['L', node.speciesIndex];
  return ['Q', node.featureIndex, structureOf(node.yes), structureOf(node.no)];
}

/* ------------------------------------------------------------------ */

describe('输入解析', () => {
  it('接受 3–16 个唯一 ASCII 物种', () => {
    expect(parseSpecies('cat\ndog\nemu')).toEqual(['cat', 'dog', 'emu']);
    const sixteen = Array.from({ length: 16 }, (_, i) => `s_${i}`);
    expect(parseSpecies(sixteen.join('\n'))).toHaveLength(16);
  });

  it('物种少于 3 或多于 16 报错', () => {
    expect(() => parseSpecies('a\nb')).toThrow(/3/);
    const seventeen = Array.from({ length: 17 }, (_, i) => `sp${i}`);
    expect(() => parseSpecies(seventeen.join('\n'))).toThrow(/16/);
  });

  it('接受 2–16 个唯一 ASCII 特征，重复 id 报错', () => {
    expect(parseFeatures('fins\nwings')).toEqual(['fins', 'wings']);
    expect(() => parseSpecies('cat\ncat\ndog')).toThrow(/重复/);
    expect(() => parseFeatures('fins\nfins')).toThrow(/重复/);
  });

  it('非 ASCII / 空白 id 被拒绝', () => {
    expect(() => parseSpecies('猫\ndog\nemu')).toThrow(/ASCII/);
    expect(() => parseSpecies(' has space\ndog\nemu')).toThrow(/ASCII/);
    expect(() => parseSpecies('\t\ndog\nemu')).toThrow(/3/);
  });

  it('矩阵维度或取值非法时报错', () => {
    expect(() =>
      buildKey(makeInput(3, 2, [[0, 1], [1, 0]])),
    ).toThrow(/行数/);
    expect(() =>
      buildKey({
        species: ['cat', 'dog', 'emu'],
        features: ['fins', 'wings'],
        matrix: [[0, 1], [1, 0], [0]],
      }),
    ).toThrow(/行长度/);
    expect(() =>
      buildKey({
        species: ['cat', 'dog', 'emu'],
        features: ['fins', 'wings'],
        matrix: [[0, 1], [1, 2], [0, 0]],
      }),
    ).toThrow(/0 或 1/);
  });
});

describe('INDISTINGUISHABLE', () => {
  it('三个物种向量全相同：返回最小 id 对且不生成树', () => {
    const input = makeInput(3, 2, [[0, 1], [0, 1], [0, 1]]);
    const result = buildKey(input);
    expect(result.status).toBe('INDISTINGUISHABLE');
    if (result.status === 'INDISTINGUISHABLE') {
      expect(result.pair).toEqual(['SP00', 'SP01']);
    }
  });

  it('多个等价组时取全局最小 id 对', () => {
    // {SP00,SP03} 同向量，{SP01,SP02} 同向量；前者含最小 id，故取 SP00,SP03
    const input = makeInput(4, 3, [
      [1, 0, 0],
      [0, 1, 1],
      [0, 1, 1],
      [1, 0, 0],
    ]);
    expect(findIndistinguishablePair(input)).toEqual(['SP00', 'SP03']);
  });

  it('更小 id 所在组不产生对内更小对时，按组内首 id 裁决', () => {
    // SP00 单独；SP01,SP02,SP03 同向量 -> 最小对 SP01,SP02
    const input = makeInput(5, 3, [
      [1, 1, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 1],
    ]);
    expect(findIndistinguishablePair(input)).toEqual(['SP01', 'SP02']);
  });

  it('同组三个物种时取该组内最接近的最小对', () => {
    const input = makeInput(5, 2, [
      [0, 0],
      [1, 1],
      [1, 1],
      [1, 1],
      [0, 1],
    ]);
    expect(findIndistinguishablePair(input)).toEqual(['SP01', 'SP02']);
  });

  it('id 字节序决定最小对（不按下标顺序命名时）', () => {
    const input: KeyInput = {
      species: ['zzz', 'aaa', 'mmm'],
      features: ['x', 'y'],
      matrix: [[1, 0], [1, 0], [0, 1]],
    };
    const result = buildKey(input);
    expect(result.status).toBe('INDISTINGUISHABLE');
    if (result.status === 'INDISTINGUISHABLE') {
      expect(result.pair).toEqual(['aaa', 'zzz']);
    }
  });
});

describe('小规模穷举对拍', () => {
  it('3 物种 × 2 特征：全部 64 个矩阵', () => {
    exhaustAllMatrices(3, 2);
  });

  it('3 物种 × 3 特征：全部 512 个矩阵', () => {
    exhaustAllMatrices(3, 3);
  });

  it('4 物种 × 3 特征：全部 4096 个矩阵', () => {
    exhaustAllMatrices(4, 3);
  });

  it('4 物种 × 4 特征：全部 65536 个矩阵', () => {
    exhaustAllMatrices(4, 4);
  });
});

describe('最坏深度与总深度（手算核对）', () => {
  it('3 物种 2 特征可均分：最坏 2，总和 5', () => {
    // 是:{SP00} 否:{SP01,SP02}
    const input = makeInput(3, 2, [[1, 0], [0, 1], [0, 0]]);
    const tree = expectTree(buildKey(input));
    expect(statsByWalking(input, tree)).toEqual([2, 5]);
    expect(q(tree.root).featureId).toBe('F00');
  });

  it('4 物种平衡：最坏 2，总和 8', () => {
    const input = makeInput(4, 2, [[0, 0], [0, 1], [1, 0], [1, 1]]);
    const tree = expectTree(buildKey(input));
    expect(statsByWalking(input, tree)).toEqual([2, 8]);
  });

  it('4 物种只能偏斜分裂：最坏 3，总和 9', () => {
    // F00 分出 1 个，剩余 3 个再分 1/2
    const input = makeInput(4, 3, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 0, 0],
    ]);
    const tree = expectTree(buildKey(input));
    expect(statsByWalking(input, tree)).toEqual([3, 9]);
  });
});

describe('并列裁决：特征 id 字节序', () => {
  it('最坏与总和并列时选字节序小的特征', () => {
    // F00 是常数列无法分裂；F01 与 F02 都是 2/2 均分，指标完全并列
    const input = makeInput(4, 3, [
      [0, 0, 0],
      [0, 1, 1],
      [0, 0, 1],
      [0, 1, 0],
    ]);
    const tree = expectTree(buildKey(input));
    expect(q(tree.root).featureId).toBe('F01');
    expect(tree.worstDepth).toBe(2);
    expect(tree.totalDepth).toBe(8);
  });

  it('字节序是逐字节而非数值序：10 < 2', () => {
    const input: KeyInput = {
      species: ['s00', 's01', 's02', 's03'],
      features: ['2', '10'],
      matrix: [[0, 0], [0, 1], [1, 0], [1, 1]],
    };
    const tree = expectTree(buildKey(input));
    expect(q(tree.root).featureId).toBe('10'); // '1' (0x31) < '2' (0x32)
  });

  it('深一层但名字字节序更小也不能赢：最坏深度优先', () => {
    // a_lonely 分裂 1/3（最坏 3）；z_bal1 分裂 2/2（最坏 2）
    const input: KeyInput = {
      species: ['x01', 'x02', 'x03', 'x04'],
      features: ['a_lonely', 'z_bal1', 'z_bal2'],
      matrix: [
        [1, 1, 0],
        [0, 1, 1],
        [0, 0, 1],
        [0, 0, 0],
      ],
    };
    const tree = expectTree(buildKey(input));
    expect(q(tree.root).featureId).toBe('z_bal1');
    expect(tree.worstDepth).toBe(2);
    expect(tree.totalDepth).toBe(8);
  });
});

describe('随机矩阵对拍', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  function randomDistinctRows(n: number, m: number, rand: () => number): number[][] {
    const seen = new Set<string>();
    const rows: number[][] = [];
    while (rows.length < n) {
      const row = Array.from({ length: m }, () => (rand() < 0.5 ? 0 : 1));
      const key = row.join('');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return rows;
  }

  it('n=5..7, m=3..6 随机 200 例与穷举器一致', () => {
    const rand = rng(20260925);
    for (let i = 0; i < 200; i++) {
      const n = 5 + Math.floor(rand() * 3);
      const m = 3 + Math.floor(rand() * 4);
      const input = makeInput(n, m, randomDistinctRows(n, m, rand));
      const tree = expectTree(buildKey(input));
      const reference = bruteSolve(input);
      statsByWalking(input, tree);
      expect(tree.worstDepth).toBe(reference.worstDepth);
      expect(tree.totalDepth).toBe(reference.totalDepth);
      expect(structureOf(tree.root)).toEqual(structureOf(reference.root));
    }
  });

  it('重命名物种不改变树结构与指标', () => {
    const rand = rng(42);
    const rows = randomDistinctRows(5, 4, rand);
    const a = makeInput(5, 4, rows);
    const b: KeyInput = {
      species: ['zzz0', 'yyy1', 'xxx2', 'www3', 'vvv4'],
      features: ['F00', 'F01', 'F02', 'F03'],
      matrix: rows,
    };
    const ta = expectTree(buildKey(a));
    const tb = expectTree(buildKey(b));
    expect(ta.worstDepth).toBe(tb.worstDepth);
    expect(ta.totalDepth).toBe(tb.totalDepth);
    expect(structureOf(ta.root)).toEqual(structureOf(tb.root));
    // 叶上的名字确实跟随重命名
    expectLeafNames(b, tb);
  });

  it('含常数列（无法分裂）时求解器忽略该列', () => {
    const input: KeyInput = {
      species: ['s01', 's02', 's03', 's04'],
      features: ['always1', 'a', 'b'],
      matrix: [
        [1, 0, 0],
        [1, 0, 1],
        [1, 1, 0],
        [1, 1, 1],
      ],
    };
    const tree = expectTree(buildKey(input));
    const root = q(tree.root);
    expect(['a', 'b']).toContain(root.featureId);
    statsByWalking(input, tree);
  });

  it('16 物种 × 16 特征（每物种唯一向量）可快速求解且树合法', () => {
    // 取 0..15 的 4 位二进制 + 补齐到 16 列
    const rows = Array.from({ length: 16 }, (_, s) => {
      const row = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < 4; b++) row[b] = (s >> b) & 1;
      return row;
    });
    const input = makeInput(16, 16, rows);
    const tree = expectTree(buildKey(input));
    expect(statsByWalking(input, tree)).toEqual([4, 64]);
  });
});

/* ================================================================== */
/* “允许一次观察错误”模式                                              */
/* ================================================================== */

/**
 * 独立的容错参考求解器：与生产代码不同的状态键编码（36 进制字符串）与
 * 候选收集方式（数组 + 排序三元比较），状态语义同为 (S0, S1)。
 */
function bruteMistakeSolve(input: KeyInput): KeyTree {
  const n = input.species.length;
  const m = input.features.length;
  const full = (1 << n) - 1;
  const col = new Array<number>(m).fill(0);
  for (let s = 0; s < n; s++) {
    for (let f = 0; f < m; f++) if (input.matrix[s][f]) col[f] |= 1 << s;
  }

  interface O {
    node: TreeNode;
    worst: number;
    total: number;
    paths: number;
  }
  const memo = new Map<string, O>();

  const leaf = (union: number): O => {
    if (union === 0) {
      return {
        node: { kind: 'leaf', speciesIndex: 0, speciesId: input.species[0] },
        worst: 0,
        total: 0,
        paths: 0,
      };
    }
    const index = 31 - Math.clz32(union);
    return {
      node: { kind: 'leaf', speciesIndex: index, speciesId: input.species[index] },
      worst: 0,
      total: 0,
      paths: 1,
    };
  };

  const dp = (s0: number, s1: number): O => {
    const union = s0 | s1;
    if ((union & (union - 1)) === 0) return leaf(union);
    const key = `${s0.toString(36)}|${s1.toString(36)}`;
    const hit = memo.get(key);
    if (hit) return hit;

    const cands: Array<O & { fid: string }> = [];
    for (let f = 0; f < m; f++) {
      const has = col[f];
      if ((union & has) === 0 || (union & ~has) === 0) continue;
      const y = dp(s0 & has, (s1 & has) | (s0 & ~has));
      const no = dp(s0 & ~has, (s1 & ~has) | (s0 & has));
      const paths = y.paths + no.paths;
      cands.push({
        fid: input.features[f],
        node: {
          kind: 'question',
          featureIndex: f,
          featureId: input.features[f],
          yes: y.node,
          no: no.node,
        },
        worst: 1 + Math.max(y.worst, no.worst),
        total: y.total + no.total + paths,
        paths,
      });
    }
    if (cands.length === 0) throw new Error('brute mistake: unsplittable state');
    cands.sort(
      (a, b) =>
        a.worst - b.worst ||
        a.total - b.total ||
        compareByteOrder(a.fid, b.fid),
    );
    const winner = cands[0];
    memo.set(key, winner);
    return winner;
  };

  const r = dp(full, 0);
  return { root: r.node, worstDepth: r.worst, totalDepth: r.total, allowOneMistake: true };
}

/**
 * 容错树独立语义校验（不信任求解器自己的指标）：
 *  1. 枚举树的每条根→叶回答路径，计算它对每个物种的不符次数；
 *     对某物种 ≤1 即该物种可能走到此叶——这样的物种必须恰好一个，且叶标签是它；
 *  2. 独立模拟每个物种“无错”及“恰好在第 j 次提问处答错”的实际行走
 *     （后续提问以实际走到的节点为准，因为同一特征会被重复提问），
 *     终点必须都是该物种自身；
 *  3. 由行走结果独立统计最坏提问数与可发生路径提问数之和，核对树自带指标。
 * 返回 [可发生叶数, 最坏深度, 总深度]。
 */
function verifyMistakeTree(input: KeyInput, tree: KeyTree): [number, number, number] {
  interface PathLeaf {
    leaf: LeafNode;
    depth: number;
    answers: { f: number; a: 0 | 1 }[];
  }
  const allLeaves: PathLeaf[] = [];
  const enumerate = (node: TreeNode, answers: { f: number; a: 0 | 1 }[], depth: number): void => {
    if (node.kind === 'leaf') {
      allLeaves.push({ leaf: node, depth, answers });
      return;
    }
    enumerate(node.yes, [...answers, { f: node.featureIndex, a: 1 }], depth + 1);
    enumerate(node.no, [...answers, { f: node.featureIndex, a: 0 }], depth + 1);
  };
  enumerate(tree.root, [], 0);

  const realizable = new Set<LeafNode>();
  for (const pl of allLeaves) {
    const compatible: number[] = [];
    for (let s = 0; s < input.species.length; s++) {
      let mis = 0;
      for (const ans of pl.answers) {
        if (input.matrix[s][ans.f] !== ans.a) mis++;
      }
      if (mis <= 1) compatible.push(s);
    }
    expect(compatible.length, `一条叶路径同时可由 ${compatible.length} 个物种 ≤1 错到达`).toBeLessThanOrEqual(1);
    if (compatible.length === 1) {
      realizable.add(pl.leaf);
      expect(pl.leaf.speciesIndex).toBe(compatible[0]);
    }
  }
  // 每个叶标签在树上可以共享（DAG 记忆化）；只要求可发生叶都标注正确物种
  expect(realizable.size).toBeGreaterThan(0);

  const walk = (speciesIndex: number, lieAtAsk: number): { leaf: LeafNode; questions: number } => {
    let node: TreeNode = tree.root;
    let asked = 0;
    while (node.kind === 'question') {
      const truth = input.matrix[speciesIndex][node.featureIndex] as 0 | 1;
      const a = asked === lieAtAsk ? ((truth ^ 1) as 0 | 1) : truth;
      node = a === 1 ? node.yes : node.no;
      asked++;
      if (asked > 64) throw new Error('容错树疑似存在环（超过 64 问未出叶）');
    }
    return { leaf: node, questions: asked };
  };

  const depths: number[] = [];
  for (let s = 0; s < input.species.length; s++) {
    const honest = walk(s, -1);
    expect(honest.leaf.speciesIndex).toBe(s);
    depths.push(honest.questions);
    // 在诚实路径的每个提问位置各引入一次错误
    for (let j = 0; j < honest.questions; j++) {
      const lied = walk(s, j);
      expect(lied.leaf.speciesIndex, `物种 ${input.species[s]} 第 ${j} 问答错后被误判`).toBe(s);
      depths.push(lied.questions);
    }
  }

  // 从叶路径独立汇总：可发生叶的最大深度与深度之和
  let worst = 0;
  let total = 0;
  for (const pl of allLeaves) {
    if (realizable.has(pl.leaf)) {
      worst = Math.max(worst, pl.depth);
      total += pl.depth;
    }
  }
  expect(worst).toBe(Math.max(...depths));
  expect(worst).toBe(tree.worstDepth);
  expect(total).toBe(tree.totalDepth);
  return [realizable.size, worst, total];
}

describe('允许一次观察错误：求解器', () => {
  it('默认 4×2 矩阵：生成容错树且标记 allowOneMistake', () => {
    const input: KeyInput = {
      species: ['ant', 'bat', 'bee', 'cat'],
      features: ['flying', 'furry'],
      matrix: [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      allowOneMistake: true,
    };
    const result = buildKey(input);
    expect(result.status).toBe('ok');
    const tree = (result as { status: 'ok'; tree: KeyTree }).tree;
    expect(tree.allowOneMistake).toBe(true);
    const [paths, worst, total] = verifyMistakeTree(input, tree);
    expect(worst).toBe(5);
    expect(paths).toBe(8);
    expect(total).toBe(88);

    // 根问题仍是字节序最小的 flying；容错树必须重复提问同一特征
    expect(q(tree.root).featureId).toBe('flying');
    const featuresSeen: string[] = [];
    const collect = (node: TreeNode): void => {
      if (node.kind === 'leaf') return;
      featuresSeen.push(node.featureId);
      collect(node.yes);
      collect(node.no);
    };
    collect(tree.root);
    expect(featuresSeen.filter((id) => id === 'flying').length).toBeGreaterThan(1);
  });

  it('与独立参考 DP 对拍：默认矩阵结构、最坏、总和完全一致', () => {
    const input: KeyInput = {
      species: ['ant', 'bat', 'bee', 'cat'],
      features: ['flying', 'furry'],
      matrix: [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      allowOneMistake: true,
    };
    const tree = expectTree(buildKey(input));
    const ref = bruteMistakeSolve(input);
    expect(tree.worstDepth).toBe(ref.worstDepth);
    expect(tree.totalDepth).toBe(ref.totalDepth);
    expect(structureOf(tree.root)).toEqual(structureOf(ref.root));
  });

  function exhaustMistake(n: number, m: number): void {
    const total = 1 << (n * m);
    let checked = 0;
    for (let bits = 0; bits < total; bits++) {
      const rows: number[][] = [];
      for (let s = 0; s < n; s++) {
        const row: number[] = [];
        for (let f = 0; f < m; f++) row.push((bits >> (s * m + f)) & 1);
        rows.push(row);
      }
      if (new Set(rows.map((r) => r.join(''))).size !== n) continue; // 互异矩阵才出树
      const input = { ...makeInput(n, m, rows), allowOneMistake: true };
      const tree = expectTree(buildKey(input));
      verifyMistakeTree(input, tree);
      const ref = bruteMistakeSolve(input);
      expect(tree.worstDepth).toBe(ref.worstDepth);
      expect(tree.totalDepth).toBe(ref.totalDepth);
      expect(structureOf(tree.root)).toEqual(structureOf(ref.root));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }

  it('4×2：全部互异矩阵穷举对拍（64 矩阵空间）', () => {
    exhaustMistake(4, 2);
  });

  it('3×3：全部互异矩阵穷举对拍（512 矩阵空间）', () => {
    exhaustMistake(3, 3);
  });

  it('4×3：全部互异矩阵穷举对拍（4096 矩阵空间）', () => {
    exhaustMistake(4, 3);
  });

  it('普通模式不受影响：不带容错标记时树与普通求解一致', () => {
    const input = makeInput(4, 2, [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    const tree = expectTree(buildKey(input));
    expect(tree.allowOneMistake).toBe(false);
    expect(tree.worstDepth).toBe(2);
  });

  it('同向量物种在容错模式下仍返回 INDISTINGUISHABLE，绝不伪造容错树', () => {
    const input: KeyInput = {
      ...makeInput(3, 2, [
        [0, 1],
        [0, 1],
        [1, 0],
      ]),
      allowOneMistake: true,
    };
    const result = buildKey(input);
    expect(result.status).toBe('INDISTINGUISHABLE');
  });

  it('超过 6 个物种或 6 个特征时报错', () => {
    const sevenSpecies: KeyInput = {
      species: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      features: ['p', 'q'],
      matrix: [
        [0, 0], [0, 1], [1, 0], [1, 1],
        [0, 0], [0, 1], [1, 0],
      ],
      allowOneMistake: true,
    };
    expect(() => buildKey(sevenSpecies)).toThrow(/最多支持 6 个物种/);

    const sevenFeatures: KeyInput = {
      species: ['a', 'b', 'c'],
      features: ['p', 'q', 'r', 's', 't', 'u', 'v'],
      matrix: [
        [0, 0, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1],
        [0, 1, 0, 1, 0, 1, 0],
      ],
      allowOneMistake: true,
    };
    expect(() => buildKey(sevenFeatures)).toThrow(/最多支持 6 个特征/);
  });

  it('6×6 互异矩阵冒烟：容错树语义合法且有限', () => {
    const input: KeyInput = {
      ...makeInput(6, 6, [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 1],
        [0, 0, 0, 0, 1, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 1, 0, 0, 0, 0],
      ]),
      allowOneMistake: true,
    };
    const tree = expectTree(buildKey(input));
    const [, worst] = verifyMistakeTree(input, tree);
    expect(worst).toBeGreaterThanOrEqual(3);
  });
});
