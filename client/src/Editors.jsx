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
// Includes a change-overview mini-map on the right: one tick per changed region
// (red = left/removed, green = right/added), a viewport box, and click-to-scroll.
export function DiffView({ left, right, path, docKey }) {
  const editors = useRef(null);
  const overview = useRef(null);
  const mv = useRef(null);

  useEffect(() => {
    if (!editors.current) return undefined;
    const ro = (doc) => ({
      doc: doc || '',
      extensions: [basicSetup, langForPath(path), oneDark, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping],
    });
    const view = new MergeView({
      parent: editors.current,
      a: ro(left),
      b: ro(right),
      revertControls: false,
      highlightChanges: true,
      gutter: true,
    });
    mv.current = view;
    const scroller = view.dom; // .cm-mergeView is the single scroll container

    const buildTicks = () => {
      const ov = overview.current;
      if (!ov || !scroller) return;
      ov.querySelectorAll('.tick').forEach((n) => n.remove());
      const H = scroller.scrollHeight || 1;
      const ovH = ov.clientHeight || 1;
      const base = scroller.getBoundingClientRect().top;
      const seen = new Set();
      scroller.querySelectorAll('.cm-changedLine, .cm-deletedChunk, .cm-inlineChangedLine').forEach((el) => {
        const top = el.getBoundingClientRect().top - base + scroller.scrollTop;
        const y = Math.round((top / H) * ovH);
        const side = el.closest('.cm-merge-b') ? 'b' : 'a';
        const key = side + y;
        if (seen.has(key)) return;
        seen.add(key);
        const t = document.createElement('div');
        t.className = 'tick ' + side;
        t.style.top = y + 'px';
        ov.appendChild(t);
      });
    };
    const updateViewport = () => {
      const ov = overview.current;
      if (!ov || !scroller) return;
      let vp = ov.querySelector('.viewport');
      if (!vp) { vp = document.createElement('div'); vp.className = 'viewport'; ov.appendChild(vp); }
      const H = scroller.scrollHeight || 1;
      const ovH = ov.clientHeight || 1;
      vp.style.top = (scroller.scrollTop / H) * ovH + 'px';
      vp.style.height = Math.max(6, (scroller.clientHeight / H) * ovH) + 'px';
    };
    const refresh = () => { buildTicks(); updateViewport(); };

    scroller.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', refresh);
    // CM measures/renders asynchronously; build after it settles.
    const t0 = setTimeout(refresh, 60);
    const t1 = setTimeout(refresh, 400);

    const ovEl = overview.current;
    const onClick = (e) => {
      const rect = ovEl.getBoundingClientRect();
      const frac = (e.clientY - rect.top) / (rect.height || 1);
      scroller.scrollTop = frac * scroller.scrollHeight - scroller.clientHeight / 2;
    };
    if (ovEl) ovEl.addEventListener('click', onClick);

    return () => {
      clearTimeout(t0); clearTimeout(t1);
      scroller.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', refresh);
      if (ovEl) ovEl.removeEventListener('click', onClick);
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return (
    <div className="cm-host merge">
      <div className="cm-diff-editors" ref={editors} />
      <div className="cm-diff-overview" ref={overview} title="change map — click to jump" />
    </div>
  );
}
