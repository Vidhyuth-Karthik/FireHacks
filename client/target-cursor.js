/* ============================================================
   TargetCursor — vanilla port of the React Bits component.

   Same behaviour and prop names; the useEffect body becomes
   mountTargetCursor(options) and cleanup becomes .destroy().

   GSAP is loaded from a CDN via dynamic import so the client keeps
   its no-build-step setup. If that import fails (offline venue), the
   cursor simply never mounts and the native pointer stays — the page
   is never left with no cursor at all.
   ============================================================ */

const GSAP_CDN = 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm';

// A position:fixed element is positioned relative to the viewport UNLESS an
// ancestor establishes a containing block (transform, perspective, filter,
// will-change of those, or contain). When that happens the cursor's translate
// no longer maps to viewport coordinates, so we measure and compensate.
const getContainingBlock = (element) => {
  let node = element?.parentElement;
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if (
      style.transform !== 'none' ||
      style.perspective !== 'none' ||
      style.filter !== 'none' ||
      style.willChange.includes('transform') ||
      style.willChange.includes('perspective') ||
      style.willChange.includes('filter') ||
      /paint|layout|strict|content/.test(style.contain)
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
};

const getContainingBlockOffset = (block) => {
  if (!block) return { x: 0, y: 0 };
  const rect = block.getBoundingClientRect();
  return { x: rect.left + block.clientLeft, y: rect.top + block.clientTop };
};

const isMobileDevice = () => {
  if (typeof window === 'undefined') return false;
  const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth <= 768;
  const ua = (navigator.userAgent || navigator.vendor || '').toLowerCase();
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
  return (hasTouchScreen && isSmallScreen) || mobileRegex.test(ua);
};

export async function mountTargetCursor(options = {}) {
  const {
    targetSelector = '.cursor-target',
    spinDuration = 2,
    hideDefaultCursor = true,
    hoverDuration = 0.2,
    parallaxOn = true,
    cursorColor = '#ffffff',
    cursorColorOnTarget,
  } = options;

  if (typeof window === 'undefined') return { destroy() {} };
  if (isMobileDevice()) return { destroy() {} };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return { destroy() {} };
  }
  // Touch/coarse pointers get nothing to hover with.
  if (!window.matchMedia('(pointer: fine)').matches) return { destroy() {} };

  let gsap;
  try {
    ({ gsap } = await import(GSAP_CDN));
  } catch {
    console.warn('[target-cursor] gsap unavailable — keeping native cursor');
    return { destroy() {} };
  }

  /* --- DOM the React component used to render --- */
  const cursor = document.createElement('div');
  cursor.className = 'target-cursor-wrapper';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.innerHTML = `
    <div class="target-cursor-dot"></div>
    <div class="target-cursor-corner corner-tl"></div>
    <div class="target-cursor-corner corner-tr"></div>
    <div class="target-cursor-corner corner-br"></div>
    <div class="target-cursor-corner corner-bl"></div>`;
  document.body.append(cursor);

  const dot = cursor.querySelector('.target-cursor-dot');
  const cornersNodes = cursor.querySelectorAll('.target-cursor-corner');
  dot.style.backgroundColor = cursorColor;
  cornersNodes.forEach((c) => {
    c.style.borderColor = cursorColor;
  });

  const originalCursor = document.body.style.cursor;
  if (hideDefaultCursor) document.body.classList.add('has-target-cursor');

  const constants = { borderWidth: 3, cornerSize: 12 };
  const containingBlock = { current: getContainingBlock(cursor) };
  const getOffset = () => getContainingBlockOffset(containingBlock.current);

  const targetCornerPositions = { current: null };
  const activeStrength = { current: 0 };
  let activeTarget = null;
  let currentLeaveHandler = null;
  let resumeTimeout = null;
  let spinTl = null;

  const cleanupTarget = (target) => {
    if (currentLeaveHandler) target.removeEventListener('mouseleave', currentLeaveHandler);
    currentLeaveHandler = null;
  };

  const initialOffset = getOffset();
  gsap.set(cursor, {
    xPercent: -50,
    yPercent: -50,
    x: window.innerWidth / 2 - initialOffset.x,
    y: window.innerHeight / 2 - initialOffset.y,
  });

  const createSpinTimeline = () => {
    spinTl?.kill();
    spinTl = gsap
      .timeline({ repeat: -1 })
      .to(cursor, { rotation: '+=360', duration: spinDuration, ease: 'none' });
  };
  createSpinTimeline();

  const tickerFn = () => {
    if (!targetCornerPositions.current) return;
    const strength = activeStrength.current;
    if (strength === 0) return;

    const cursorX = gsap.getProperty(cursor, 'x');
    const cursorY = gsap.getProperty(cursor, 'y');

    Array.from(cornersNodes).forEach((corner, i) => {
      const currentX = gsap.getProperty(corner, 'x');
      const currentY = gsap.getProperty(corner, 'y');
      const targetX = targetCornerPositions.current[i].x - cursorX;
      const targetY = targetCornerPositions.current[i].y - cursorY;
      const finalX = currentX + (targetX - currentX) * strength;
      const finalY = currentY + (targetY - currentY) * strength;
      const duration = strength >= 0.99 ? (parallaxOn ? 0.2 : 0) : 0.05;

      gsap.to(corner, {
        x: finalX,
        y: finalY,
        duration,
        ease: duration === 0 ? 'none' : 'power1.out',
        overwrite: 'auto',
      });
    });
  };

  const moveCursor = (x, y) => {
    const { x: offsetX, y: offsetY } = getOffset();
    gsap.to(cursor, { x: x - offsetX, y: y - offsetY, duration: 0.1, ease: 'power3.out' });
  };

  const moveHandler = (e) => moveCursor(e.clientX, e.clientY);
  window.addEventListener('mousemove', moveHandler);

  const scrollHandler = () => {
    if (!activeTarget) return;
    const { x: offsetX, y: offsetY } = getOffset();
    const mouseX = gsap.getProperty(cursor, 'x') + offsetX;
    const mouseY = gsap.getProperty(cursor, 'y') + offsetY;
    const under = document.elementFromPoint(mouseX, mouseY);
    const stillOver =
      under && (under === activeTarget || under.closest(targetSelector) === activeTarget);
    if (!stillOver && currentLeaveHandler) currentLeaveHandler();
  };
  window.addEventListener('scroll', scrollHandler, { passive: true });

  const mouseDownHandler = () => {
    gsap.to(dot, { scale: 0.7, duration: 0.3 });
    gsap.to(cursor, { scale: 0.9, duration: 0.2 });
  };
  const mouseUpHandler = () => {
    gsap.to(dot, { scale: 1, duration: 0.3 });
    gsap.to(cursor, { scale: 1, duration: 0.2 });
  };
  window.addEventListener('mousedown', mouseDownHandler);
  window.addEventListener('mouseup', mouseUpHandler);

  const enterHandler = (e) => {
    let node = e.target;
    let target = null;
    while (node && node !== document.body) {
      if (node.matches?.(targetSelector)) {
        target = node;
        break;
      }
      node = node.parentElement;
    }
    if (!target || activeTarget === target) return;
    if (activeTarget) cleanupTarget(activeTarget);
    if (resumeTimeout) {
      clearTimeout(resumeTimeout);
      resumeTimeout = null;
    }

    activeTarget = target;
    const corners = Array.from(cornersNodes);
    corners.forEach((corner) => gsap.killTweensOf(corner, 'x,y'));

    gsap.killTweensOf(cursor, 'rotation');
    spinTl?.pause();
    gsap.set(cursor, { rotation: 0 });

    if (cursorColorOnTarget) {
      gsap.to(corners, { borderColor: cursorColorOnTarget, duration: 0.15, ease: 'power2.out' });
      gsap.to(dot, { backgroundColor: cursorColorOnTarget, duration: 0.15, ease: 'power2.out' });
    }

    const rect = target.getBoundingClientRect();
    const { borderWidth, cornerSize } = constants;
    const { x: offsetX, y: offsetY } = getOffset();
    const cursorX = gsap.getProperty(cursor, 'x');
    const cursorY = gsap.getProperty(cursor, 'y');

    targetCornerPositions.current = [
      { x: rect.left - borderWidth - offsetX, y: rect.top - borderWidth - offsetY },
      { x: rect.right + borderWidth - cornerSize - offsetX, y: rect.top - borderWidth - offsetY },
      {
        x: rect.right + borderWidth - cornerSize - offsetX,
        y: rect.bottom + borderWidth - cornerSize - offsetY,
      },
      { x: rect.left - borderWidth - offsetX, y: rect.bottom + borderWidth - cornerSize - offsetY },
    ];

    gsap.ticker.add(tickerFn);
    gsap.to(activeStrength, { current: 1, duration: hoverDuration, ease: 'power2.out' });

    corners.forEach((corner, i) => {
      gsap.to(corner, {
        x: targetCornerPositions.current[i].x - cursorX,
        y: targetCornerPositions.current[i].y - cursorY,
        duration: 0.2,
        ease: 'power2.out',
      });
    });

    const leaveHandler = () => {
      gsap.ticker.remove(tickerFn);
      targetCornerPositions.current = null;
      gsap.set(activeStrength, { current: 0, overwrite: true });
      activeTarget = null;

      if (cursorColorOnTarget) {
        gsap.to(Array.from(cornersNodes), {
          borderColor: cursorColor,
          duration: 0.15,
          ease: 'power2.out',
        });
        gsap.to(dot, { backgroundColor: cursorColor, duration: 0.15, ease: 'power2.out' });
      }

      const cs = constants.cornerSize;
      const resting = [
        { x: -cs * 1.5, y: -cs * 1.5 },
        { x: cs * 0.5, y: -cs * 1.5 },
        { x: cs * 0.5, y: cs * 0.5 },
        { x: -cs * 1.5, y: cs * 0.5 },
      ];
      const corners2 = Array.from(cornersNodes);
      gsap.killTweensOf(corners2, 'x,y');
      const tl = gsap.timeline();
      corners2.forEach((corner, index) => {
        tl.to(corner, { ...resting[index], duration: 0.3, ease: 'power3.out' }, 0);
      });

      resumeTimeout = setTimeout(() => {
        if (!activeTarget && spinTl) {
          const currentRotation = gsap.getProperty(cursor, 'rotation');
          const normalized = currentRotation % 360;
          spinTl.kill();
          spinTl = gsap
            .timeline({ repeat: -1 })
            .to(cursor, { rotation: '+=360', duration: spinDuration, ease: 'none' });
          gsap.to(cursor, {
            rotation: normalized + 360,
            duration: spinDuration * (1 - normalized / 360),
            ease: 'none',
            onComplete: () => spinTl?.restart(),
          });
        }
        resumeTimeout = null;
      }, 50);

      cleanupTarget(target);
    };

    currentLeaveHandler = leaveHandler;
    target.addEventListener('mouseleave', leaveHandler);
  };

  window.addEventListener('mouseover', enterHandler, { passive: true });

  const resizeHandler = () => {
    containingBlock.current = getContainingBlock(cursor);
  };
  window.addEventListener('resize', resizeHandler);

  return {
    destroy() {
      gsap.ticker.remove(tickerFn);
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mouseover', enterHandler);
      window.removeEventListener('scroll', scrollHandler);
      window.removeEventListener('resize', resizeHandler);
      window.removeEventListener('mousedown', mouseDownHandler);
      window.removeEventListener('mouseup', mouseUpHandler);
      if (activeTarget) cleanupTarget(activeTarget);
      if (resumeTimeout) clearTimeout(resumeTimeout);
      spinTl?.kill();
      document.body.classList.remove('has-target-cursor');
      document.body.style.cursor = originalCursor;
      cursor.remove();
    },
  };
}
