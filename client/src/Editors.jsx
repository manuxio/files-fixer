import React, { useEffect, useRef } from 'react';
import { EditorView, EditorState, basicSetup, oneDark, MergeView, langForPath } from './editor.js';

// Single read-only or editable code view. Recreated whenever `docKey` changes
// (i.e. when a different file/side is shown), so the doc always resets cleanly.
export function CodeView({ value, path, docKey, editable = false, onChange }) {
  const host = useRef(null);
  const view = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return undefined;
    const state = EditorState.create({
      doc: value || '',
      extensions: [
        basicSetup,
        langForPath(path),
        oneDark,
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChangeRef.current) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => view.current && view.current.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, editable]);

  return <div className="cm-host" ref={host} />;
}

// Side-by-side diff: a = left (original), b = right (current). Read-only.
export function DiffView({ left, right, path, docKey }) {
  const host = useRef(null);
  const mv = useRef(null);

  useEffect(() => {
    if (!host.current) return undefined;
    const ro = (doc) => ({
      doc: doc || '',
      extensions: [basicSetup, langForPath(path), oneDark, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping],
    });
    mv.current = new MergeView({
      parent: host.current,
      a: ro(left),
      b: ro(right),
      revertControls: false,
      highlightChanges: true,
      gutter: true,
    });
    return () => mv.current && mv.current.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return <div className="cm-host merge" ref={host} />;
}
