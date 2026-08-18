import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/ui-transition.js';

const T = globalThis.TTQUITransition;

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function animationGate() {
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  return {
    finished,
    finish,
    cancelled: false,
    cancel() {
      this.cancelled = true;
      finish();
    }
  };
}

function element(bounds, options = {}) {
  const calls = [];
  return {
    isConnected: options.isConnected !== false,
    calls,
    getBoundingClientRect() { return bounds; },
    animate: options.animate === false ? undefined : function (keyframes, timing) {
      const animation = options.animationFactory
        ? options.animationFactory()
        : { finished: Promise.resolve(), cancel() {} };
      calls.push({ keyframes, timing, animation });
      return animation;
    },
    focus(value) {
      if (options.focusThrows) throw new Error('unsupported options');
      calls.push({ focus: value });
    }
  };
}

function environment(overrides = {}) {
  return {
    viewport: { width: 390, height: 844 },
    getComputedStyle(node) {
      return node.computedStyle || {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        borderRadius: '18px'
      };
    },
    matchMedia() { return { matches: false }; },
    setTimeout,
    clearTimeout,
    ...overrides
  };
}

test('calculateTransform maps a source rectangle into target coordinates', () => {
  assert.deepEqual(
    T.calculateTransform(rect(18, 120, 180, 72), rect(0, 0, 390, 844)),
    {
      translateX: -87,
      translateY: -266,
      scaleX: 0.4615,
      scaleY: 0.0853
    }
  );
  assert.equal(T.calculateTransform(rect(0, 0, 0, 20), rect(0, 0, 20, 20)), null);
});

test('measureElement rejects detached, hidden, offscreen and empty sources', () => {
  const env = environment();
  assert.equal(T.measureElement(element(rect(0, 0, 20, 20), {
    isConnected: false
  }), { environment: env }), null);
  assert.equal(T.measureElement(element(rect(500, 0, 20, 20)), {
    environment: env
  }), null);
  const hidden = element(rect(0, 0, 20, 20));
  hidden.computedStyle = { display: 'none', visibility: 'visible', opacity: '1' };
  assert.equal(T.measureElement(hidden, { environment: env }), null);
  assert.equal(T.measureElement(element(rect(0, 0, 0, 20)), {
    environment: env
  }), null);
});

test('open uses shared geometry, compositor-friendly keyframes and delayed content', async () => {
  const source = element(rect(18, 120, 180, 72));
  const target = element(rect(0, 0, 390, 844));
  const content = element(rect(0, 0, 390, 844));
  const controller = T.createTransitionController({ environment: environment() });

  const result = await controller.open({ source, target, content });

  assert.equal(result.completed, true);
  assert.equal(result.animated, true);
  assert.equal(result.usedSharedGeometry, true);
  assert.equal(target.calls[0].timing.duration, 390);
  assert.equal(target.calls[0].timing.easing, T.DEFAULT_EASING);
  assert.match(target.calls[0].keyframes[0].transform, /translate3d\(-87px, -266px/);
  assert.deepEqual(
    Object.keys(target.calls[0].keyframes[0]).sort(),
    ['borderRadius', 'opacity', 'transform']
  );
  assert.deepEqual(content.calls[0].keyframes.map(frame => frame.opacity), [0, 0, 1]);
  assert.equal(source.calls.length, 1);
});

test('close re-resolves the source and falls back when it disappeared', async () => {
  const original = element(rect(20, 100, 200, 80));
  const target = element(rect(0, 0, 390, 844));
  let current = original;
  const source = () => current;
  const controller = T.createTransitionController({ environment: environment() });
  await controller.open({ source, target });
  current = null;

  const result = await controller.close({ target, restoreFocus: false });

  assert.equal(result.completed, true);
  assert.equal(result.usedSharedGeometry, false);
  const closingFrames = target.calls[1].keyframes;
  assert.equal(closingFrames[1].opacity, 0);
  assert.match(closingFrames[1].transform, /scale\(0\.96, 0\.96\)/);
});

test('reduced motion and missing Element.animate complete synchronously', async () => {
  const order = [];
  const source = element(rect(10, 10, 100, 40));
  const target = element(rect(0, 0, 390, 844), { animate: false });
  const controller = T.createTransitionController({ environment: environment() });

  const promise = controller.open({
    source,
    target,
    onStart() { order.push('start'); },
    onFinish() { order.push('finish'); }
  });
  order.push('returned');
  const result = await promise;

  assert.deepEqual(order, ['start', 'finish', 'returned']);
  assert.equal(result.completed, true);
  assert.equal(result.animated, false);

  const animatedTarget = element(rect(0, 0, 390, 844));
  const reduced = T.createTransitionController({
    environment: environment({ matchMedia: () => ({ matches: true }) })
  });
  const reducedResult = await reduced.open({ source, target: animatedTarget });
  assert.equal(reducedResult.animated, false);
  assert.equal(animatedTarget.calls.length, 0);
});

test('duplicate transitions are rejected while an in-flight transition can be cancelled', async () => {
  const gates = [];
  const source = element(rect(10, 10, 100, 40), {
    animationFactory() {
      const gate = animationGate();
      gates.push(gate);
      return gate;
    }
  });
  const target = element(rect(0, 0, 390, 844), {
    animationFactory() {
      const gate = animationGate();
      gates.push(gate);
      return gate;
    }
  });
  const controller = T.createTransitionController({ environment: environment() });
  const first = controller.open({ source, target });

  assert.equal(controller.isRunning, true);
  assert.equal(controller.direction, 'open');
  const duplicate = await controller.open({ source, target });
  assert.deepEqual(duplicate, {
    completed: false,
    skipped: true,
    reason: 'busy',
    direction: 'open'
  });
  assert.equal(controller.cancel('test-cancel'), true);
  const result = await first;
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'test-cancel');
  assert.equal(controller.isRunning, false);
  assert.equal(controller.direction, null);
});

test('close restores focus after completion and tolerates old focus signatures', async () => {
  const source = element(rect(10, 10, 100, 40), { focusThrows: true });
  let plainFocusCalls = 0;
  source.focus = function (options) {
    if (options) throw new Error('old Safari');
    plainFocusCalls += 1;
  };
  const target = element(rect(0, 0, 390, 844));
  const controller = T.createTransitionController({ environment: environment() });
  await controller.open({ source, target });
  await controller.close({ target });
  assert.equal(plainFocusCalls, 1);
});
