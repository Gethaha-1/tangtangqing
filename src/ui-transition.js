(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQUITransition = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_DURATION = 390;
  const DEFAULT_EASING = 'cubic-bezier(0.2, 0.75, 0.25, 1)';
  const MIN_SIZE = 1;
  const MIN_SCALE = 0.01;
  const MAX_SCALE = 100;

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function cleanNumber(value) {
    const rounded = Math.round(value * 10000) / 10000;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function normalizeRect(value) {
    if (!value) return null;
    const left = finiteNumber(value.left, finiteNumber(value.x, NaN));
    const top = finiteNumber(value.top, finiteNumber(value.y, NaN));
    const width = finiteNumber(
      value.width,
      finiteNumber(value.right, NaN) - left
    );
    const height = finiteNumber(
      value.height,
      finiteNumber(value.bottom, NaN) - top
    );
    if (![left, top, width, height].every(Number.isFinite) ||
        width < MIN_SIZE || height < MIN_SIZE) return null;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height
    };
  }

  function isRectVisible(rect, viewport) {
    const value = normalizeRect(rect);
    if (!value) return false;
    const area = viewport || {};
    const width = finiteNumber(area.width, Infinity);
    const height = finiteNumber(area.height, Infinity);
    return value.right > 0 && value.bottom > 0 &&
      value.left < width && value.top < height;
  }

  function resolveElement(value) {
    try {
      return typeof value === 'function' ? value() : value;
    } catch {
      return null;
    }
  }

  function defaultEnvironment() {
    const scope = typeof globalThis !== 'undefined' ? globalThis : {};
    return {
      getComputedStyle: typeof scope.getComputedStyle === 'function'
        ? scope.getComputedStyle.bind(scope)
        : null,
      matchMedia: typeof scope.matchMedia === 'function'
        ? scope.matchMedia.bind(scope)
        : null,
      viewport: function () {
        return {
          width: finiteNumber(scope.innerWidth, Infinity),
          height: finiteNumber(scope.innerHeight, Infinity)
        };
      },
      setTimeout: typeof scope.setTimeout === 'function'
        ? scope.setTimeout.bind(scope)
        : null,
      clearTimeout: typeof scope.clearTimeout === 'function'
        ? scope.clearTimeout.bind(scope)
        : null
    };
  }

  function mergeEnvironment(custom) {
    return Object.assign(defaultEnvironment(), custom || {});
  }

  function viewportSize(environment) {
    const value = typeof environment.viewport === 'function'
      ? environment.viewport()
      : environment.viewport;
    return value || { width: Infinity, height: Infinity };
  }

  function readStyle(element, environment) {
    if (!environment.getComputedStyle) return null;
    try {
      return environment.getComputedStyle(element);
    } catch {
      return null;
    }
  }

  function measureElement(element, options) {
    const config = options || {};
    const environment = mergeEnvironment(config.environment);
    const value = resolveElement(element);
    if (!value || value.isConnected === false ||
        typeof value.getBoundingClientRect !== 'function') return null;
    let rect;
    try {
      rect = normalizeRect(value.getBoundingClientRect());
    } catch {
      return null;
    }
    if (!rect) return null;
    if (config.requireVisible === false) return rect;
    if (!isRectVisible(rect, viewportSize(environment))) return null;
    const style = readStyle(value, environment);
    if (style && (style.display === 'none' || style.visibility === 'hidden' ||
        finiteNumber(style.opacity, 1) <= 0.01)) return null;
    return rect;
  }

  function calculateTransform(fromRect, toRect) {
    const from = normalizeRect(fromRect);
    const to = normalizeRect(toRect);
    if (!from || !to) return null;
    return {
      // CSS transforms use the element center as their default origin. Mapping
      // center-to-center keeps the scaled target exactly over the source without
      // requiring a transform-origin mutation that could leak across gestures.
      translateX: cleanNumber(
        from.left + from.width / 2 - (to.left + to.width / 2)
      ),
      translateY: cleanNumber(
        from.top + from.height / 2 - (to.top + to.height / 2)
      ),
      scaleX: cleanNumber(clamp(from.width / to.width, MIN_SCALE, MAX_SCALE)),
      scaleY: cleanNumber(clamp(from.height / to.height, MIN_SCALE, MAX_SCALE))
    };
  }

  function formatTransform(transform) {
    if (!transform) return 'translate3d(0px, 0px, 0) scale(1, 1)';
    return 'translate3d(' + transform.translateX + 'px, ' +
      transform.translateY + 'px, 0) scale(' + transform.scaleX + ', ' +
      transform.scaleY + ')';
  }

  function elementRadius(element, environment, fallback) {
    const style = readStyle(element, environment);
    if (!style) return fallback;
    return style.borderRadius || style.borderTopLeftRadius || fallback;
  }

  function buildContainerKeyframes(direction, geometry) {
    const targetTransform = 'translate3d(0px, 0px, 0) scale(1, 1)';
    const sourceTransform = geometry && geometry.transform
      ? formatTransform(geometry.transform)
      : 'translate3d(0px, 12px, 0) scale(0.96, 0.96)';
    const sourceRadius = geometry && geometry.sourceRadius
      ? geometry.sourceRadius
      : '24px';
    const targetRadius = geometry && geometry.targetRadius
      ? geometry.targetRadius
      : '0px';
    const sourceOpacity = geometry && geometry.transform ? 0.76 : 0;
    const opening = [
      {
        transform: sourceTransform,
        opacity: sourceOpacity,
        borderRadius: sourceRadius
      },
      {
        transform: targetTransform,
        opacity: 1,
        borderRadius: targetRadius
      }
    ];
    return direction === 'close' ? opening.slice().reverse() : opening;
  }

  function buildContentKeyframes(direction) {
    if (direction === 'close') {
      return [
        { opacity: 1, offset: 0 },
        { opacity: 0, offset: 0.45 },
        { opacity: 0, offset: 1 }
      ];
    }
    return [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.24 },
      { opacity: 1, offset: 1 }
    ];
  }

  function prefersReducedMotion(environment, override) {
    if (typeof override === 'function') return !!override();
    if (typeof override === 'boolean') return override;
    if (!environment.matchMedia) return false;
    try {
      return !!environment.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function focusElement(element) {
    const value = resolveElement(element);
    if (!value || value.isConnected === false || typeof value.focus !== 'function')
      return false;
    try {
      value.focus({ preventScroll: true });
      return true;
    } catch {
      try {
        value.focus();
        return true;
      } catch {
        return false;
      }
    }
  }

  function safeCall(callback, value) {
    if (typeof callback !== 'function') return;
    try {
      callback(value);
    } catch {
      // UI cleanup must not leave the controller locked if a consumer hook fails.
    }
  }

  function stopAnimations(animations) {
    animations.forEach(function (animation) {
      try {
        animation.cancel();
      } catch {
        // A detached element or an already-cancelled Animation needs no cleanup.
      }
    });
  }

  function waitForAnimation(animation, duration, environment) {
    return new Promise(function (resolve) {
      let settled = false;
      let timer = null;
      function done() {
        if (settled) return;
        settled = true;
        if (timer !== null && environment.clearTimeout)
          environment.clearTimeout(timer);
        resolve();
      }
      if (animation && animation.finished &&
          typeof animation.finished.then === 'function') {
        animation.finished.then(done, done);
      }
      if (animation && typeof animation.addEventListener === 'function') {
        animation.addEventListener('finish', done, { once: true });
        animation.addEventListener('cancel', done, { once: true });
      }
      if (environment.setTimeout)
        timer = environment.setTimeout(done, duration + 100);
      else if (!animation || !animation.finished) done();
    });
  }

  function createTransitionController(options) {
    const config = options || {};
    const environment = mergeEnvironment(config.environment);
    const duration = clamp(
      finiteNumber(config.duration, DEFAULT_DURATION),
      360,
      420
    );
    const easing = config.easing || DEFAULT_EASING;
    let active = null;
    let rememberedSource = null;

    function cancel(reason) {
      if (!active) return false;
      active.cancelled = true;
      active.reason = reason || 'cancelled';
      stopAnimations(active.animations);
      return true;
    }

    async function run(direction, request) {
      const settings = request || {};
      if (active && active.direction === direction && !active.cancelled) {
        return { completed: false, skipped: true, reason: 'busy', direction };
      }
      if (active) cancel('interrupted');

      const sourceSpec = settings.source !== undefined
        ? settings.source
        : rememberedSource;
      if (direction === 'open' && sourceSpec) rememberedSource = sourceSpec;
      const source = resolveElement(sourceSpec);
      const target = resolveElement(settings.target);
      const content = resolveElement(settings.content);
      const token = {
        direction,
        animations: [],
        cancelled: false,
        reason: '',
        usedSharedGeometry: false
      };
      active = token;
      safeCall(settings.onStart, { direction, source, target });

      const finishSynchronously = !target || target.isConnected === false ||
        typeof target.animate !== 'function' ||
        prefersReducedMotion(environment, settings.reducedMotion !== undefined
          ? settings.reducedMotion
          : config.reducedMotion);

      if (!finishSynchronously) {
        const sourceRect = measureElement(source, { environment });
        const targetRect = measureElement(target, {
          environment,
          requireVisible: false
        });
        const transform = calculateTransform(sourceRect, targetRect);
        const geometry = {
          transform,
          sourceRadius: transform
            ? (settings.sourceRadius || elementRadius(source, environment, '24px'))
            : (settings.fallbackRadius || '24px'),
          targetRadius: settings.targetRadius ||
            elementRadius(target, environment, '0px')
        };
        token.usedSharedGeometry = !!transform;
        const timing = {
          duration,
          easing,
          fill: 'both'
        };
        try {
          token.animations.push(target.animate(
            buildContainerKeyframes(direction, geometry),
            timing
          ));
          if (content && content !== target && typeof content.animate === 'function') {
            token.animations.push(content.animate(
              buildContentKeyframes(direction),
              timing
            ));
          }
          if (direction === 'open' && source && typeof source.animate === 'function') {
            token.animations.push(source.animate([
              { transform: 'scale(1)', opacity: 1 },
              { transform: 'scale(0.985)', opacity: 0.94, offset: 0.5 },
              { transform: 'scale(1)', opacity: 1 }
            ], {
              duration: 140,
              easing: 'ease-out',
              fill: 'none'
            }));
          }
        } catch {
          stopAnimations(token.animations);
          token.animations = [];
        }
      }

      if (token.animations.length) {
        await Promise.all(token.animations.map(function (animation) {
          return waitForAnimation(animation, duration, environment);
        }));
      }

      if (token.cancelled || active !== token) {
        if (active === token) active = null;
        return {
          completed: false,
          cancelled: true,
          reason: token.reason || 'interrupted',
          direction
        };
      }

      safeCall(settings.onFinish, { direction, source, target });
      if (direction === 'close' && settings.restoreFocus !== false) {
        const focusTarget = settings.restoreFocus && settings.restoreFocus !== true
          ? settings.restoreFocus
          : sourceSpec;
        focusElement(focusTarget);
      }
      stopAnimations(token.animations);
      active = null;
      return {
        completed: true,
        animated: token.animations.length > 0,
        usedSharedGeometry: token.animations.length > 0 &&
          token.usedSharedGeometry,
        direction
      };
    }

    return {
      open: function (request) { return run('open', request); },
      close: function (request) { return run('close', request); },
      cancel,
      rememberSource: function (source) {
        rememberedSource = source || null;
      },
      restoreFocus: function (source) {
        return focusElement(source === undefined ? rememberedSource : source);
      },
      get isRunning() { return !!active && !active.cancelled; },
      get direction() { return active && !active.cancelled ? active.direction : null; }
    };
  }

  return {
    DEFAULT_DURATION,
    DEFAULT_EASING,
    normalizeRect,
    isRectVisible,
    resolveElement,
    measureElement,
    calculateTransform,
    formatTransform,
    buildContainerKeyframes,
    buildContentKeyframes,
    prefersReducedMotion,
    focusElement,
    createTransitionController
  };
});
