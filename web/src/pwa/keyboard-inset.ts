// How much of the screen the on-screen keyboard covers, as --sf-keyboard on <html>, so
// bottom sheets can sit above it. Where the page already shrinks for the keyboard (see
// interactive-widget in index.html) this stays 0; elsewhere it's the keyboard's height.

export function trackKeyboardInset() {
  const vv = window.visualViewport;
  if (vv == null) return;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // Pinch zoom also shrinks the visual viewport; only a keyboard-sized gap counts
      const inset = vv.scale > 1.01 || covered < 80 ? 0 : covered;
      document.documentElement.style.setProperty('--sf-keyboard', `${inset}px`);
    });
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
