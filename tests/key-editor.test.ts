// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/key-editor.js';
import type { KeyEditor } from '../src/key-editor.js';

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function clickButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll('button')].find((b) =>
    text(b).includes(label),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`未找到按钮：${label}`);
  btn.click();
  return btn;
}

function setTextarea(scope: ParentNode, index: number, value: string): HTMLTextAreaElement {
  const areas = scope.querySelectorAll('textarea');
  const ta = areas[index];
  if (!ta) throw new Error(`未找到第 ${index} 个 textarea`);
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta;
}

describe('key-editor 组件交互', () => {
  let host: KeyEditor;

  beforeEach(() => {
    host = document.createElement('key-editor') as KeyEditor;
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  async function settled(): Promise<KeyEditor> {
    await host.updateComplete;
    return host;
  }

  it('默认矩阵生成 4 物种树：最坏 2，总和 8', async () => {
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    const card = host.shadowRoot!.querySelectorAll('section.card')[1];
    expect(text(card)).toContain('最坏提问数：2');
    expect(text(card)).toContain('路径长度之和：8');
    // 四个叶节点
    expect(card.querySelectorAll('.lnode')).toHaveLength(4);
  });

  it('实际识别：是/否行走、候选集合收缩、回溯与重新开始', async () => {
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();

    // 默认平衡矩阵根问应选 flying（10 < 2 之外，这里 id 为单词；二者 2/2 并列取字节序 flying < furry）
    const ask = () => text(host.shadowRoot!.querySelector('.identify .ask'));
    expect(ask()).toBe('flying?');
    const candidates = () => text(host.shadowRoot!.querySelector('.candidates'));

    // 回答“否”：候选变为 ant、cat
    clickButton(host.shadowRoot!, '否（不具备）');
    await settled();
    expect(candidates()).toContain('ant');
    expect(candidates()).toContain('cat');
    expect(candidates()).not.toContain('bat');
    expect(ask()).toBe('furry?');

    // 回答“是”：识别为 cat
    clickButton(host.shadowRoot!, '是（具备）');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.result-leaf'))).toBe('识别结果：cat');

    // 回溯到第 0 问（flying），重新走一条路识别 bee
    clickButton(host.shadowRoot!, '回到此问');
    await settled();
    expect(ask()).toBe('flying?');
    clickButton(host.shadowRoot!, '是（具备）');
    await settled();
    // flying=1 分支根问 furry?，bee 不具备 furry
    expect(ask()).toBe('furry?');
    clickButton(host.shadowRoot!, '否（不具备）');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.result-leaf'))).toBe('识别结果：bee');

    clickButton(host.shadowRoot!, '重新识别');
    await settled();
    expect(ask()).toBe('flying?');
  });

  it('编辑矩阵后旧树立即失效：出现 stale 横幅且识别面板停用', async () => {
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(host.shadowRoot!.querySelector('.stale')).toBeNull();
    expect(host.shadowRoot!.querySelector('.identify')).not.toBeNull();

    // 默认 4×2 矩阵恰好占满全部 2 位组合，翻转任意单格都会碰撞；
    // 这里改测重命名特征 id：矩阵不变但旧树必须立即失效。
    setTextarea(host.shadowRoot!, 1, 'flying\nwings');
    await settled();

    expect(text(host.shadowRoot!.querySelector('.stale'))).toContain('旧检索表已失效');
    expect(host.shadowRoot!.querySelector('.identify')).toBeNull();
    // 旧树仍以淡化形式保留可见
    expect(host.shadowRoot!.querySelectorAll('.lnode')).toHaveLength(4);

    // 重新生成后恢复，新特征名出现
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(host.shadowRoot!.querySelector('.stale')).toBeNull();
    expect(host.shadowRoot!.querySelector('.identify')).not.toBeNull();
    expect(text(host.shadowRoot!.querySelectorAll('section.card')[1])).toContain('wings');
  });

  it('编辑 id 列表即时增删行列并使旧树失效', async () => {
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();

    setTextarea(host.shadowRoot!, 0, 'ant\nbat\nbee'); // 删除 cat
    await settled();
    const rows = host.shadowRoot!.querySelectorAll('table.matrix tbody tr');
    expect(rows).toHaveLength(3);
    expect(host.shadowRoot!.querySelector('.stale')).not.toBeNull();

    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    const card = host.shadowRoot!.querySelectorAll('section.card')[1];
    expect(text(card)).toContain('最坏提问数：2');
  });

  it('物种不足 3 个时生成显示错误而不产生树', async () => {
    await settled();
    setTextarea(host.shadowRoot!, 0, 'ant\nbat');
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.error'))).toContain('物种数量');
    expect(host.shadowRoot!.querySelectorAll('.lnode')).toHaveLength(0);
  });

  it('重复 id 报错', async () => {
    await settled();
    setTextarea(host.shadowRoot!, 1, 'flying\nflying');
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.error'))).toContain('特征 id 必须唯一');
  });

  it('重复特征向量：INDISTINGUISHABLE，给出最小 id 对且没有树和识别面板', async () => {
    await settled();
    // 将 bee 行 (1,0) 改为 (1,1) 与 bat 相同；ant=(0,0)
    // 单元格顺序：行 ant: (0,0)(0,1)；bat: (1,1)；bee: (1,0)(1,1)；cat: (0,1)
    const cells = host.shadowRoot!.querySelectorAll('td.cell');
    // bee=行索引2，flying=列0 -> 1（保持），furry=列1（下标 2*2+1=5）0 -> 1
    cells[5].dispatchEvent(new Event('click', { bubbles: true }));
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();

    const card = host.shadowRoot!.querySelectorAll('section.card')[1];
    expect(text(card)).toContain('INDISTINGUISHABLE');
    expect(text(card)).toContain('bat');
    expect(text(card)).toContain('bee');
    expect(host.shadowRoot!.querySelectorAll('.lnode')).toHaveLength(0);
    expect(host.shadowRoot!.querySelector('.identify')).toBeNull();
  });

  it('INDISTINGUISHABLE 之后修复矩阵可重新生成出树', async () => {
    await settled();
    // ant 与 bat 改为同向量：ant=(0,0)，点击其 flying 单元保持 0；
    // 直接把 bat 行 (1,1) 两格点成 0 => 与 ant 相同
    const cells = host.shadowRoot!.querySelectorAll('td.cell');
    cells[2].dispatchEvent(new Event('click', { bubbles: true })); // bat,flying 1->0
    cells[3].dispatchEvent(new Event('click', { bubbles: true })); // bat,furry 1->0
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.indist'))).toContain('ant');
    expect(text(host.shadowRoot!.querySelector('.indist'))).toContain('bat');

    // 修复：bat 两格全部点回原值 (1,1)，四个物种重新互异
    cells[2].dispatchEvent(new Event('click', { bubbles: true }));
    cells[3].dispatchEvent(new Event('click', { bubbles: true }));
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(host.shadowRoot!.querySelector('.indist')).toBeNull();
    expect(host.shadowRoot!.querySelectorAll('.lnode')).toHaveLength(4);
  });
});
