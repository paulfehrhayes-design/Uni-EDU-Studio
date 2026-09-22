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
  const seconds = clamp(findNumber(normalized, 1, /(?:wait|pause|second|等待|停留)[^\d]*(\d+(?:\.\d+)?)/), 0.1, 5);

  if (/\b(square|box pattern|四边形|正方形)\b/.test(normalized)) {
    const side = clamp(findNumber(normalized, 2), 1, 8);
    for (let index = 0; index < 4; index += 1) {
      addStep(steps, 'Walk forward', `robot.walkForwardSteps(${side});`, `${side} steps`);
      addStep(steps, 'Turn left', 'robot.turnLeft(90);', '90 degrees');
    }
  } else if (/\b(zigzag|zig zag|之字形)\b/.test(normalized)) {
    const legs = clamp(findNumber(normalized, 3), 2, 8);
    for (let index = 0; index < legs; index += 1) {
      addStep(steps, 'Walk forward', `robot.walkForwardSteps(${distance});`, `${distance} steps`);
      addStep(steps, index % 2 ? 'Turn right' : 'Turn left', `robot.turn${index % 2 ? 'Right' : 'Left'}(35);`, '35 degrees');
    }
  } else {
    if (/\b(backward|back|reverse|后退|向后)\b/.test(normalized)) {
      addStep(steps, 'Walk backward', `robot.walkBackwardSteps(${distance});`, `${distance} steps`);
    } else if (/\b(left|向左)\b.*\b(step|walk|走|移)\b/.test(normalized)) {
      addStep(steps, 'Walk sideways left', `robot.walkSidewaysLeftSteps(${distance});`, `${distance} steps`);
    } else if (/\b(right|向右)\b.*\b(step|walk|走|移)\b/.test(normalized)) {
      addStep(steps, 'Walk sideways right', `robot.walkSidewaysRightSteps(${distance});`, `${distance} steps`);
    } else if (/\b(forward|ahead|straight|前进|向前|走)\b/.test(normalized)) {
      addStep(steps, 'Walk forward', `robot.walkForwardSteps(${distance});`, `${distance} steps`);
    }

    if (/\b(turn|rotate|转|旋转)\b/.test(normalized)) {
      const right = /\b(right|clockwise|右)\b/.test(normalized);
      addStep(steps, right ? 'Turn right' : 'Turn left', `robot.turn${right ? 'Right' : 'Left'}(${angle});`, `${angle} degrees`);
    }

    if (/\b(wave|挥手)\b/.test(normalized)) {
      const right = /\b(right|右)\b/.test(normalized);
      addStep(steps, right ? 'Wave right' : 'Wave left', `robot.wave${right ? 'Right' : 'Left'}();`, 'arm gesture');
    }

    if (/\b(raise|lift|举起|抬起)\b.*\b(arm|arms|手臂)\b/.test(normalized)) {
      addStep(steps, 'Raise both arms', 'robot.raiseBothArms();', 'arm pose');
    } else if (/\b(lower|放下)\b.*\b(arm|arms|手臂)\b/.test(normalized)) {
      addStep(steps, 'Lower both arms', 'robot.lowerBothArms();', 'arm pose');
    }

    if (/\b(sit|squat|坐下)\b/.test(normalized)) addStep(steps, 'Sit', 'robot.sit();', 'seated pose');
    if (/\b(stand|stand up|起立|站立)\b/.test(normalized)) addStep(steps, 'Stand', 'robot.stand();', 'standing pose');
    if (/\b(stop|停止)\b/.test(normalized)) addStep(steps, 'Stop', 'robot.stop();', 'movement stopped');

    if (/\b(wait|pause|等待|停留)\b/.test(normalized)) {
      addStep(steps, 'Wait', `robot.waitSeconds(${seconds});`, `${seconds} seconds`);
    }
  }

  if (/\b(repeat|again|times|重复)\b/.test(normalized) && steps.length) {
    const repetitions = clamp(findNumber(normalized, 2), 1, 5);
    const original = [...steps];
    steps.length = 0;
    for (let index = 0; index < repetitions; index += 1) steps.push(...original);
  }

  if (!steps.length) {
    unknown.push('Try: “walk forward 3 steps, turn left 90 degrees, then wave”');
  } else {
    addStep(steps, 'Stand', 'robot.stand();', 'finish safely');
  }

  return {
    code: steps.map((step) => step.code).join('\n'),
    steps,
    unknown,
    summary: steps.length ? `Generated ${steps.length} safe robot actions.` : 'No supported movement was detected.',
  };
}
