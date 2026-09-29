// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/pages/key-page.js';
import '../src/compose.js';
import type { ComposeApp } from '../src/compose.js';

describe('compose 页面组合器', () => {
  let app: ComposeApp;

  beforeEach(() => {
    window.location.hash = '';
    app = document.createElement('compose-app') as ComposeApp;
    document.body.appendChild(app);
  });

  afterEach(() => {
    app.remove();
  });

  it('key 页面已注册且默认路由挂载 key-editor', async () => {
    await app.updateComplete;
    const link = app.shadowRoot!.querySelector('nav a[href="#/key"]');
    expect(link).not.toBeNull();
    expect(app.shadowRoot!.querySelector('key-editor')).not.toBeNull();
  });

  it('未知路径回退到默认 key 页面', async () => {
    window.location.hash = '#/nope';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await app.updateComplete;
    expect(app.shadowRoot!.querySelector('key-editor')).not.toBeNull();
  });

  it('导航到 #/key 后链接高亮', async () => {
    window.location.hash = '#/key';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await app.updateComplete;
    const active = app.shadowRoot!.querySelector('nav a.active');
    expect(active?.getAttribute('href')).toBe('#/key');
  });
});
