import { html, type TemplateResult } from 'lit';
import { definePage } from '../compose.js';
import '../key-editor.js';

/** Compose 的 key 页面：交互式二歧检索表编辑器。 */
definePage(
  {
    path: '/key',
    title: '检索表',
    render: (): TemplateResult => html`<key-editor></key-editor>`,
  },
  true,
);
