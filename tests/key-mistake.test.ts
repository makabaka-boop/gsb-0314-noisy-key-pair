import { describe, expect, it } from 'vitest';
import {
  buildKey,
  compareByteOrder,
  type KeyInput,
  type KeyTree,
  type LeafNode,
  type QuestionNode,
  type TreeNode,
} from '../src/solver/key.js';

/* ------------------------------------------------------------------ */
/* 独立参考容错求解器：用 Set 维护 exact/loose（生产代码用打包位掩码）， */
/* 状态键用字符串；比较逻辑同样独立书写，用于对拍。                      */
/* ------------------------------------------------------------------ */

interface RefOpt {
  node: TreeNode;
  worst: number;
  total: number;
  leaves: number;
}

function refSolveMistake(input: KeyInput): KeyTree {
  const n = input.species.length;
  const m = input.features.length;
  const all = new Set<number>([...Array(n).keys()]);

  const has: Array<Set<number>> = input.features.map((_, f) => {
    const s = new Set<number>();
    for (let sp = 0; sp < n; sp++) if (input.matrix[sp][f] === 1) s.add(sp);
    return s;
  });

  const memo = new Map<string, RefOpt>();
  const keyOf = (ex: Set<number>, lo: Set<number>): string =>
    `[${[...ex].sort((a, b) => a - b).join(',')}]|[${[...lo].sort((a, b) => a - b).join(',')}]`;

  function dp(exIn: Set<number>, loIn: Set<number>): RefOpt {
    const alive = new Set<number>([...exIn, ...loIn]);
    if (alive.size === 1) {
      const index = [...alive][0];
      return {
        node: { kind: 'leaf', speciesIndex: index, speciesId: input.species[index] },
        worst: 0,
        total: 0,
        leaves: 1,
      };
    }
    const key = keyOf(exIn, loIn);
    const hit = memo.get(key);
    if (hit) return hit;

    let winner: RefOpt | null = null;
    for (let f = 0; f < m; f++) {
      const col = has[f];
      const exY = new Set([...exIn].filter((s) => col.has(s)));
      const loY = new Set<number>([
        ...[...exIn].filter((s) => !col.has(s)),
        ...[...loIn].filter((s) => col.has(s)),
      ]);
      const exN = new Set([...exIn].filter((s) => !col.has(s)));
      const loN = new Set<number>([
        ...[...exIn].filter((s) => col.has(s)),
        ...[...loIn].filter((s) => !col.has(s)),
      ]);

      // 每条可发生的回答路径都必须非空且可继续
      if (exY.size + loY.size === 0 || exN.size + loN.size === 0) continue;
      // 常数列：某分支零信息（状态不变），跳过
      const same = (a: Set<number>, b: Set<number>, x: Set<number>, y: Set<number>): boolean =>
        a.size === x.size && b.size === y.size &&
        [...a].every((v) => x.has(v)) && [...b].every((v) => y.has(v));
      if (same(exY, loY, exIn, loIn) || same(exN, loN, exIn, loIn)) continue;

      const y = dp(exY, loY);
      const nn = dp(exN, loN);
      const cand: RefOpt = {
        worst: 1 + Math.max(y.worst, nn.worst),
        total: y.total + nn.total + y.leaves + nn.leaves,
        leaves: y.leaves + nn.leaves,
        node: {
          kind: 'question',
          featureIndex: f,
          featureId: input.features[f],
          yes: y.node,
          no: nn.node,
        },
      };
      const better =
        winner === null ||
        cand.worst < winner.worst ||
        (cand.worst === winner.worst && cand.total < winner.total) ||
        (cand.worst === winner.worst &&
          cand.total === winner.total &&
          compareByteOrder(
            input.features[f],
            (winner.node as QuestionNode).featureId,
          ) < 0);
      if (better) winner = cand;
    }
    if (!winner) throw new Error('ref: unsplittable mistake state');
    memo.set(key, winner);
    return winner;
  }

  const r = dp(all, new Set());
  return { root: r.node, worstDepth: r.worst, totalDepth: r.total, allowOneMistake: true };
}

/* ------------------------------------------------------------------ */
/* 语义走查：站在“真实物种”角度枚举至多一次错误的全部回答序列，          */
/* 每条序列都必须在该物种的叶处结束；并独立按“每次观察计数 ≤1”核对       */
/* 候选集合与叶结论（对应页面候选列表/回溯逻辑所依赖的规则）。           */
/* ------------------------------------------------------------------ */

function structureOf(node: TreeNode): unknown {
  if (node.kind === 'leaf') return ['L', node.speciesIndex];
  return ['Q', node.featureIndex, structureOf(node.yes), structureOf(node.no)];
}

function collectLeaves(node: TreeNode, depth: number, acc: Array<[LeafNode, number]>): void {
  if (node.kind === 'leaf') {
    acc.push([node, depth]);
    return;
  }
  collectLeaves(node.yes, depth + 1, acc);
  collectLeaves(node.no, depth + 1, acc);
}

/** 独立按回答记录（重复提问按每次观察分别计数）计算 0 次/1 次不符集合。 */
function partitionsByRecord(
  input: KeyInput,
  record: Array<[number, 0 | 1]>,
): [Set<number>, Set<number>] {
  const exact = new Set<number>();
  const loose = new Set<number>();
  for (let s = 0; s < input.species.length; s++) {
    let bad = 0;
    for (const [f, ans] of record) {
      if (input.matrix[s][f] !== ans) bad++;
    }
    if (bad === 0) exact.add(s);
    else if (bad === 1) loose.add(s);
  }
  return [exact, loose];
}

function verifyMistakeTree(input: KeyInput, tree: KeyTree): void {
  expect(tree.allowOneMistake).toBe(true);

  // 指标与逐叶统计一致（同一物种可出现在多个叶）
  const leaves: Array<[LeafNode, number]> = [];
  collectLeaves(tree.root, 0, leaves);
  expect(Math.max(...leaves.map(([, d]) => d))).toBe(tree.worstDepth);
  expect(leaves.reduce((a, [, d]) => a + d, 0)).toBe(tree.totalDepth);

  const walk = (
    node: TreeNode,
    s: number,
    lies: number,
    depth: number,
    record: Array<[number, 0 | 1]>,
  ): void => {
    if (node.kind === 'leaf') {
      // 每条 ≤1 错误路径都必须收敛到真实物种本身
      expect(node.speciesIndex).toBe(s);
      // 叶处按回答记录独立计算的候选必须唯一且就是该物种
      const [ex, lo] = partitionsByRecord(input, record);
      const alive = [...ex, ...lo];
      expect(alive).toEqual([s]);
      return;
    }
    // 每个内部节点两侧都必须可发生（真正二歧，容错树也不允许死分支）
    expect(node.yes).toBeDefined();
    expect(node.no).toBeDefined();
    const truth = input.matrix[s][node.featureIndex] as 0 | 1;
    for (const ans of [1, 0] as const) {
      const cost = ans === truth ? 0 : 1;
      if (lies + cost > 1) continue;
      const next = ans === 1 ? node.yes : node.no;
      walk(next, s, lies + cost, depth + 1, [...record, [node.featureIndex, ans]]);
    }
  };
  for (let s = 0; s < input.species.length; s++) {
    walk(tree.root, s, 0, 0, []);
  }
}

function makeInput(n: number, m: number, rows: number[][]): KeyInput {
  return {
    species: Array.from({ length: n }, (_, i) => `SP${String(i).padStart(2, '0')}`),
    features: Array.from({ length: m }, (_, i) => `F${String(i).padStart(2, '0')}`),
    matrix: rows.map((r) => [...r]),
    allowOneMistake: true,
  };
}

function exhaustMistakeMatrices(n: number, m: number): void {
  const total = 1 << (n * m);
  for (let bits = 0; bits < total; bits++) {
    const rows: number[][] = [];
    for (let s = 0; s < n; s++) {
      const row: number[] = [];
      for (let f = 0; f < m; f++) row.push((bits >> (s * m + f)) & 1);
      rows.push(row);
    }
    const input = makeInput(n, m, rows);
    const distinct = new Set(rows.map((r) => r.join(''))).size === n;
    const result = buildKey(input);
    if (!distinct) {
      expect(result.status).toBe('INDISTINGUISHABLE');
      continue;
    }
    expect(result.status).toBe('ok');
    const tree = (result as { status: 'ok'; tree: KeyTree }).tree;
    const ref = refSolveMistake(input);
    expect(tree.worstDepth).toBe(ref.worstDepth);
    expect(tree.totalDepth).toBe(ref.totalDepth);
    expect(structureOf(tree.root)).toEqual(structureOf(ref.root));
    verifyMistakeTree(input, tree);
  }
}

describe('容错模式（一次观察错误）小规模穷举对拍', () => {
  it('3 物种 × 2 特征：全部 64 个矩阵', () => {
    exhaustMistakeMatrices(3, 2);
  });

  it('3 物种 × 3 特征：全部 512 个矩阵', () => {
    exhaustMistakeMatrices(3, 3);
  });

  it('4 物种 × 2 特征：全部 256 个矩阵', () => {
    exhaustMistakeMatrices(4, 2);
  });

  it('4 物种 × 3 特征：全部 4096 个矩阵', () => {
    exhaustMistakeMatrices(4, 3);
  });
});

describe('容错模式（一次观察错误）手算与边界', () => {
  it('默认 4×2 矩阵：最坏 5，路径总和 88，且路径上重复提问', () => {
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
    expect(tree.worstDepth).toBe(5);
    expect(tree.totalDepth).toBe(88);

    // 至少一条根→叶路径重复问同一特征
    const repeats: boolean[] = [];
    const check = (node: TreeNode, seen: number[]): void => {
      if (node.kind === 'leaf') return;
      if (seen.includes(node.featureIndex)) repeats.push(true);
      check(node.yes, [...seen, node.featureIndex]);
      check(node.no, [...seen, node.featureIndex]);
    };
    check(tree.root, []);
    expect(repeats.length).toBeGreaterThan(0);
    verifyMistakeTree(input, tree);
  });

  it('容错模式下向量重复仍返回 INDISTINGUISHABLE', () => {
    const input = makeInput(3, 2, [[0, 1], [0, 1], [1, 0]]);
    const result = buildKey(input);
    expect(result.status).toBe('INDISTINGUISHABLE');
    if (result.status === 'INDISTINGUISHABLE') {
      expect(result.pair).toEqual(['SP00', 'SP01']);
    }
  });

  it('超过 6 个物种或 6 个特征时报错', () => {
    const rows7 = Array.from({ length: 7 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
    expect(() => buildKey(makeInput(7, 3, rows7))).toThrow(/最多支持 6 个物种/);
    const bigF: KeyInput = {
      species: ['a', 'b', 'c'],
      features: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
      matrix: [
        [0, 0, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1],
        [0, 1, 0, 1, 0, 1, 0],
      ],
      allowOneMistake: true,
    };
    expect(() => buildKey(bigF)).toThrow(/最多支持 6 个特征/);
  });

  it('不勾选容错时仍是普通最优树（最坏 2、总和 8）', () => {
    const input: KeyInput = {
      species: ['ant', 'bat', 'bee', 'cat'],
      features: ['flying', 'furry'],
      matrix: [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
    };
    const result = buildKey(input);
    expect(result.status).toBe('ok');
    const tree = (result as { status: 'ok'; tree: KeyTree }).tree;
    expect(tree.worstDepth).toBe(2);
    expect(tree.totalDepth).toBe(8);
    expect(tree.allowOneMistake).toBeUndefined();
  });
});

describe('容错模式随机矩阵对拍', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('n=5..6, m=3..6 随机 40 例与参考解一致且语义合法', () => {
    const rand = rng(20260929);
    for (let i = 0; i < 40; i++) {
      const n = 5 + Math.floor(rand() * 2);
      const m = 3 + Math.floor(rand() * 4);
      const seen = new Set<string>();
      const rows: number[][] = [];
      while (rows.length < n) {
        const row = Array.from({ length: m }, () => (rand() < 0.5 ? 0 : 1));
        const k = row.join('');
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(row);
      }
      const input = makeInput(n, m, rows);
      const result = buildKey(input);
      expect(result.status).toBe('ok');
      const tree = (result as { status: 'ok'; tree: KeyTree }).tree;
      const ref = refSolveMistake(input);
      expect(tree.worstDepth).toBe(ref.worstDepth);
      expect(tree.totalDepth).toBe(ref.totalDepth);
      expect(structureOf(tree.root)).toEqual(structureOf(ref.root));
      verifyMistakeTree(input, tree);
    }
  });
});
