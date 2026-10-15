const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function findNumber(text, fallback, contextPattern = null) {
  if (contextPattern) {
    const contextual = text.match(contextPattern);
    if (contextual) return Number(contextual[1]);
  }
  const numeric = text.match(/\d+(?:\.\d+)?/);
  if (numeric) return Number(numeric[0]);
  const word = Object.keys(NUMBER_WORDS).find((item) => new RegExp(`\\b${item}\\b`, 'i').test(text));
  return word ? NUMBER_WORDS[word] : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function addStep(steps, label, code, detail) {
  steps.push({ label, code, detail });
}

export function compileMotionPrompt(prompt = '') {
  const normalized = prompt.toLowerCase().replace(/[,.!?;:]/g, ' ');
  const steps = [];
  const unknown = [];
  const distance = clamp(findNumber(normalized, 3, /(?:forward|backward|back|walk|step|走|步)[^\d]*(\d+(?:\.\d+)?)/), 1, 10);
  const angle = clamp(findNumber(normalized, 90, /(?:turn|rotate|degree|角度|转)[^\d]*(\d+(?:\.\d+)?)/), 5, 180);
  const duration = clamp(findNumber(normalized, 1, /(?:for|time|second|秒)[^\d]*(\d+(?:\.\d+)?)/), 0.1, 10);
  const timeBased = /\b(second|seconds|time|秒)\b/.test(normalized);
  const speedMode = /\b(slow|slowly)\b/.test(normalized) ? 'slow' : /\b(fast|quick|quickly)\b/.test(normalized) ? 'fast' : '';
  const movementAmount = timeBased ? duration : distance;

  if (/\b(square|box pattern|四边形|正方形)\b/.test(normalized)) {
    const side = clamp(findNumber(normalized, 2), 1, 8);
    for (let index = 0; index < 4; index += 1) {
      addStep(steps, 'Walk forward', `robot.walk(${side})`, `${side} steps`);
      addStep(steps, 'Turn left', 'robot.turn("left", 90)', '90 degrees');
    }
  } else if (/\b(zigzag|zig zag|之字形)\b/.test(normalized)) {
    const legs = clamp(findNumber(normalized, 3), 2, 8);
    for (let index = 0; index < legs; index += 1) {
      addStep(steps, 'Walk forward', `robot.walk(${distance})`, `${distance} steps`);
      addStep(steps, index % 2 ? 'Turn right' : 'Turn left', `robot.turn("${index % 2 ? 'right' : 'left'}", 35)`, '35 degrees');
    }
  } else {
    if (/\b(backward|back|reverse|后退|向后)\b/.test(normalized)) {
      const method = timeBased ? 'backwardtime' : 'backward';
      addStep(steps, 'Walk backward', `robot.${method}(${movementAmount})`, timeBased ? `${duration} seconds` : `${distance} steps`);
    } else if (/\b(left|向左)\b.*\b(step|walk|走|移)\b/.test(normalized)) {
      addStep(steps, 'Sidestep left', 'robot.sidestep("left")', 'one step');
    } else if (/\b(right|向右)\b.*\b(step|walk|走|移)\b/.test(normalized)) {
      addStep(steps, 'Sidestep right', 'robot.sidestep("right")', 'one step');
    } else if (/\b(forward|ahead|straight|前进|向前|走)\b/.test(normalized)) {
      const method = speedMode ? `${speedMode}walk${timeBased ? 'time' : ''}` : timeBased ? 'walktime' : 'walk';
      addStep(steps, speedMode ? `${speedMode} walk` : 'Walk forward', `robot.${method}(${movementAmount})`, timeBased ? `${duration} seconds` : `${distance} steps`);
    }

    if (/\b(turn|rotate|转|旋转)\b/.test(normalized)) {
      const right = /\b(right|clockwise|右)\b/.test(normalized);
      addStep(steps, right ? 'Turn right' : 'Turn left', `robot.turn("${right ? 'right' : 'left'}", ${angle})`, `${angle} degrees`);
    }

    if (/\b(wave|挥手)\b/.test(normalized)) {
      const waveSide = normalized.match(/(?:wave|挥手)(?:\s+with)?\s+(left|right)|\b(left|right)\s+(?:hand\s+)?wave/);
      const right = waveSide?.[1] === 'right' || waveSide?.[2] === 'right';
      const height = /\b(high|高)\b/.test(normalized) ? 'high' : /\b(low|低)\b/.test(normalized) ? 'low' : 'mid';
      addStep(steps, right ? 'Wave right' : 'Wave left', `robot.wave${right ? 'right' : 'left'}("${height}")`, `${height}-height arm gesture`);
    }

    if (/\b(raise|lift|举起|抬起)\b.*\b(arm|arms|手臂)\b/.test(normalized)) {
      const height = /\b(high|高)\b/.test(normalized) ? 'high' : /\b(low|低)\b/.test(normalized) ? 'low' : 'mid';
      const armSide = normalized.match(/\b(?:raise|lift)\s+(left|right)\s+arm\b/);
      const side = armSide?.[1] || 'both';
      const method = side === 'both' ? 'raisebotharms' : `raise${side}arm`;
      addStep(steps, `Raise ${side} arm${side === 'both' ? 's' : ''}`, `robot.${method}("${height}")`, `${height}-height arm pose`);
    }

    if (/\b(kick|踢)\b/.test(normalized)) {
      const kickSide = normalized.match(/(?:kick|踢)\s+(left|right)|\b(left|right)\s+kick/);
      const side = kickSide?.[1] || kickSide?.[2] || 'left';
      const height = /\b(high|高)\b/.test(normalized) ? 'high' : /\b(low|低)\b/.test(normalized) ? 'low' : 'mid';
      addStep(steps, `Kick ${side}`, `robot.kick${side}("${height}")`, `${height} kick`);
    }

    if (/\bknee\b/.test(normalized)) {
      const kneeSide = normalized.match(/\b(left|right)\s+knee\b/);
      const side = kneeSide?.[1] || 'left';
      addStep(steps, `Raise ${side} knee`, `robot.knee${side}()`, 'knee raise');
    }

    if (/\b(stand|stand up|起立|站立)\b/.test(normalized)) addStep(steps, 'Stand', 'robot.stand()', 'standing pose');
  }

  if (/\b(repeat|again|times|重复)\b/.test(normalized) && steps.length) {
    const repetitions = clamp(findNumber(normalized, 2), 1, 5);
    const original = [...steps];
    steps.length = 0;
    for (let index = 0; index < repetitions; index += 1) steps.push(...original);
  }

  if (!steps.length) {
    unknown.push('Try: “walk forward 3 steps, turn left 90 degrees, then wave high”');
  } else {
    addStep(steps, 'Stand', 'robot.stand()', 'finish safely');
  }

  if (/\b(squat|stop|wait|pause|lower|停止|等待)\b/.test(normalized)) {
    unknown.push('Stop, wait, and lowering motions are not in the shared G1 command set yet.');
  }

  return {
    code: steps.map((step) => step.code).join('\n'),
    steps,
    unknown,
    summary: steps.length ? `Generated ${steps.length} safe robot actions.` : 'No supported movement was detected.',
  };
}
