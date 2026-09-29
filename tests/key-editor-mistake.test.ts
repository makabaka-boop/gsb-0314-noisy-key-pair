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

describe('key-editor 容错识别（一次观察错误）', () => {
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

  async function enableMistakeAndGenerate(): Promise<void> {
    await settled();
    const box = host.shadowRoot!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    box.click();
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settled();
    expect(box.checked).toBe(true);
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
  }

  const MATRIX: Record<string, [number, number]> = {
    ant: [0, 0],
    bat: [1, 1],
    bee: [1, 0],
    cat: [0, 1],
  };

  /** 沿容错树把真实物种 trueId 识别出来：第一问故意答错，其余如实作答。 */
  async function identifyWithOneWrongAnswer(trueId: string): Promise<void> {
    const firstQuestion = text(host.shadowRoot!.querySelector('.identify .ask'));
    const firstFeature = firstQuestion.replace('?', '');
    const truth = MATRIX[trueId][['flying', 'furry'].indexOf(firstFeature)];
    clickButton(host.shadowRoot!, truth === 1 ? '否（不具备）' : '是（具备）');
    await settled();

    let guard = 0;
    while (!host.shadowRoot!.querySelector('.result-leaf')) {
      if (guard++ > 12) throw new Error('识别未在有限提问内收敛');
      const ask = text(host.shadowRoot!.querySelector('.identify .ask'));
      const feature = ask.replace('?', '');
      const ans = MATRIX[trueId][['flying', 'furry'].indexOf(feature)];
      // 候选必须始终包含真实物种（一次错误不应让它消失）
      expect(text(host.shadowRoot!.querySelector('.candidates'))).toContain(trueId);
      clickButton(host.shadowRoot!, ans === 1 ? '是（具备）' : '否（不具备）');
      await settled();
    }
    expect(text(host.shadowRoot!.querySelector('.result-leaf'))).toBe(
      `识别结果：${trueId}`,
    );
  }

  /** 从当前问题开始如实作答直到叶，返回总提问数。 */
  async function answerTruthfullyUntilLeaf(trueId: string): Promise<number> {
    let questions = 0;
    let guard = 0;
    while (!host.shadowRoot!.querySelector('.result-leaf')) {
      if (guard++ > 12) throw new Error('识别未在有限提问内收敛');
      const feature = text(host.shadowRoot!.querySelector('.identify .ask')).replace('?', '');
      const ans = MATRIX[trueId][['flying', 'furry'].indexOf(feature)];
      expect(text(host.shadowRoot!.querySelector('.candidates'))).toContain(trueId);
      clickButton(host.shadowRoot!, ans === 1 ? '是（具备）' : '否（不具备）');
      await settled();
      questions++;
    }
    expect(text(host.shadowRoot!.querySelector('.result-leaf'))).toBe(
      `识别结果：${trueId}`,
    );
    return questions;
  }

  it('勾选后生成容错树：最坏提问数大于普通树且指标按回答路径口径显示', async () => {
    await enableMistakeAndGenerate();
    const card = host.shadowRoot!.querySelectorAll('section.card')[1];
    expect(text(card)).toContain('最坏提问数：5');
    expect(text(card)).toContain('可发生回答路径的提问数之和：88');
    expect(text(card)).toContain('最多一次观察错误');
    // 容错树中叶多于物种数（同一物种在多条路径被识别）
    expect(card.querySelectorAll('.lnode').length).toBeGreaterThan(4);
  });

  it('第一问答错后真实物种不消失，重复核对最终识别正确（四个物种逐一验证）', async () => {
    await enableMistakeAndGenerate();
    for (const [i, id] of ['ant', 'bat', 'bee', 'cat'].entries()) {
      if (i > 0) {
        clickButton(host.shadowRoot!, '重新识别');
        await settled();
      }
      await identifyWithOneWrongAnswer(id);
    }
  });

  it('全程如实回答也能识别；一次错误后又反悔改选，候选与结论随回答记录恢复', async () => {
    await enableMistakeAndGenerate();

    // 真实 bee=(1,0)：先在根问上故意答“否”（flying=0 与 bee 不符）
    const rootAsk = text(host.shadowRoot!.querySelector('.identify .ask'));
    expect(rootAsk).toContain('flying');
    clickButton(host.shadowRoot!, '否（不具备）');
    await settled();
    const candidatesAfterWrong = text(host.shadowRoot!.querySelector('.candidates'));
    expect(candidatesAfterWrong).toContain('bee'); // 一次错误仍保留
    expect(candidatesAfterWrong).toContain('ant');
    expect(candidatesAfterWrong).toContain('cat');

    // 回溯到第一问改回正确答案“是”
    clickButton(host.shadowRoot!, '回到此问');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.identify .ask'))).toContain('flying');
    const candidatesAfterBacktrack = text(host.shadowRoot!.querySelector('.candidates'));
    // 回答记录已清空：四个物种重新成为候选
    for (const id of ['ant', 'bat', 'bee', 'cat']) {
      expect(candidatesAfterBacktrack).toContain(id);
    }

    // 此后如实作答直到收敛：容错树无法预知错误发生在哪一问，会重复核对
    clickButton(host.shadowRoot!, '是（具备）');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.candidates'))).toContain('bee');
    const questions = await answerTruthfullyUntilLeaf('bee');
    expect(questions).toBeGreaterThan(1); // 不会只问一次就下结论
  });

  it('取消勾选并重新生成后恢复普通树：最坏 2、总和 8', async () => {
    await enableMistakeAndGenerate();
    const box = host.shadowRoot!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.click();
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    const card = host.shadowRoot!.querySelectorAll('section.card')[1];
    expect(text(card)).toContain('最坏提问数：2');
    expect(text(card)).toContain('所有物种路径长度之和：8');
    expect(card.querySelectorAll('.lnode')).toHaveLength(4);
  });

  it('超过 6 个特征时生成显示错误而不产生树', async () => {
    await settled();
    const areas = host.shadowRoot!.querySelectorAll('textarea');
    areas[1].value = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'].join('\n');
    areas[1].dispatchEvent(new Event('input', { bubbles: true }));
    await settled();
    const box = host.shadowRoot!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.click();
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settled();
    clickButton(host.shadowRoot!, '生成检索表');
    await settled();
    expect(text(host.shadowRoot!.querySelector('.error'))).toContain('最多支持 6 个特征');
    expect(host.shadowRoot!.querySelectorAll('.lnode')).toHaveLength(0);
  });
});
