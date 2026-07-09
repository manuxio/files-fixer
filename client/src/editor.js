import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { php } from '@codemirror/lang-php';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { MergeView } from '@codemirror/merge';

export function langForPath(p = '') {
  const ext = p.toLowerCase().split('.').pop();
  if (ext === 'php') return php();
  if (ext === 'html' || ext === 'htm') return html();
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return javascript();
  return [];
}

export { EditorView, EditorState, basicSetup, oneDark, MergeView };
