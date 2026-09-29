import './compose.js';
import './pages/key-page.js';

// Compose 的 key 页面（#/key，默认页）承载交互式检索表编辑器。
if (!window.location.hash) {
  window.location.replace('#/key');
}
