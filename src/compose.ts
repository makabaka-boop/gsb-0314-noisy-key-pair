/**
 * Compose：极简页面组合器。
 *
 * 页面通过 definePage 注册到路径；<compose-app> 按 location.hash
 * （形如 #/key）渲染对应页面，未知路径回退到默认页。
 */
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

export interface PageDefinition {
  path: string;
  title: string;
  render: () => TemplateResult;
}

const pages = new Map<string, PageDefinition>();
let defaultPath = '/';

export function definePage(definition: PageDefinition, isDefault = false): void {
  pages.set(definition.path, definition);
  if (isDefault) defaultPath = definition.path;
}

export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith('/')) return defaultPath;
  return hash.split('?')[0];
}

@customElement('compose-app')
export class ComposeApp extends LitElement {
  static override styles = css`
    :host {
      display: block;
      max-width: 1180px;
      margin: 0 auto;
      padding: 1.2rem;
    }
    header {
      display: flex;
      align-items: baseline;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    header h1 {
      font-size: 1.25rem;
      margin: 0;
    }
    nav a {
      margin-right: 0.8rem;
      color: #2b6cb0;
      text-decoration: none;
      font-size: 0.9rem;
    }
    nav a.active {
      font-weight: 700;
      text-decoration: underline;
    }
  `;

  @state() private path = currentPath();

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
  }

  override disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    super.disconnectedCallback();
  }

  private onHashChange = (): void => {
    this.path = currentPath();
  };

  override render(): TemplateResult {
    const page = pages.get(this.path);
    const resolved = page ?? pages.get(defaultPath);
    if (resolved) {
      document.title = `${resolved.title} · 二歧检索表`;
    }
    return html`
      <header>
        <h1>二歧检索表编辑器</h1>
        <nav>
          ${[...pages.values()].map(
            (p) => html`
              <a
                class="${this.path === p.path ? 'active' : ''}"
                href="#${p.path}"
                >${p.title}</a
              >
            `,
          )}
        </nav>
      </header>
      <main>${resolved ? resolved.render() : html`<p>未找到页面：${this.path}</p>`}</main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'compose-app': ComposeApp;
  }
}
