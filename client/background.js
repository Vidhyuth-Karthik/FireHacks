/* ============================================================
   Background video playback.

   Why this exists: the pages used to call video.pause() whenever
   `prefers-reduced-motion: reduce` matched. On Windows that media query
   is driven by Settings > Accessibility > Visual effects > Animation
   effects — which plenty of people turn off for performance, not for
   vestibular reasons. The result was a background that looked like a
   broken static image on a machine that was working perfectly.

   So: the ambient video keeps playing by default, and reduced-motion
   still governs the aggressive stuff (UI transitions, particle scatter,
   the highlight breathing) via CSS. Anyone who genuinely needs stillness
   gets an explicit, persistent opt-out here rather than an OS setting
   silently deciding for them.

     import { mountBackgroundVideo } from './background.js';
     mountBackgroundVideo();
   ============================================================ */

const PREF_KEY = 'whisper.bgmotion';

function prefersStill() {
  try {
    return localStorage.getItem(PREF_KEY) === 'off';
  } catch {
    return false;
  }
}

export function setBackgroundMotion(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {}
  document.querySelectorAll('[data-bg-video]').forEach((video) => {
    if (on) video.play().catch(() => {});
    else video.pause();
  });
}

export function mountBackgroundVideo() {
  const videos = [...document.querySelectorAll('[data-bg-video]')];
  if (!videos.length) return;

  if (prefersStill()) {
    videos.forEach((v) => v.pause());
    return;
  }

  const attempt = (video) => {
    if (prefersStill()) return;
    const promise = video.play();
    if (promise?.catch) promise.catch(() => {});
  };

  videos.forEach((video) => {
    attempt(video);

    // Autoplay can be refused before any interaction, and the element may
    // not be ready on first call — retry on the events that change that.
    video.addEventListener('loadeddata', () => attempt(video), { once: true });
    video.addEventListener('canplay', () => attempt(video), { once: true });

    // Some browsers pause backgrounded video and don't resume on return.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) attempt(video);
    });
  });

  // Last resort: the first real user gesture always unblocks autoplay.
  const onGesture = () => videos.forEach(attempt);
  ['pointerdown', 'keydown'].forEach((type) =>
    document.addEventListener(type, onGesture, { once: true, passive: true }),
  );
}
