const URDF_SOURCE_FILE = 'g1_23dof.urdf.txt';

async function getDefaultUrdfText() {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
      const { readFileSync } = await import('node:fs');
      return readFileSync(new URL('../../g1_23dof.urdf.txt', import.meta.url), 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

const G1_URDF_SOURCE = await getDefaultUrdfText();

function stripUrdfComments(urdfText = '') {
  return urdfText.replace(/<!--([\s\S]*?)-->/g, '');
}

function normalizeUrdfModelData(model = {}) {
  const activeJoints = Array.isArray(model.jointDetails) ? model.jointDetails.filter((joint) => joint && joint.name && !joint.name.startsWith('floating_')) : [];
  const allJoints = activeJoints.map((joint) => joint.name);
  const fixedJoints = activeJoints.filter((joint) => joint.type === 'fixed').map((joint) => joint.name);
  const revoluteJoints = activeJoints.filter((joint) => joint.type === 'revolute').map((joint) => joint.name);
  const links = Array.isArray(model.links) ? [...new Set(model.links)] : [];

  return {
    robotType: 'Unitree G1',
    source: 'URDF',
    sourceFile: URDF_SOURCE_FILE,
    baseLink: links.includes('pelvis') ? 'pelvis' : (links[0] ?? 'pelvis'),
    jointCount: revoluteJoints.length,
    joints: revoluteJoints,
    revoluteJoints,
    fixedJoints,
    allJoints,
    links,
    jointDetails: activeJoints,
  };
}

export const G1_MODEL_INFO = Object.freeze(parseG1Urdf(G1_URDF_SOURCE));

export function parseG1Urdf(urdfText) {
  if (!urdfText || typeof urdfText !== 'string') {
    return {
      ...normalizeUrdfModelData({
        jointDetails: [],
        links: ['pelvis'],
      }),
      joints: [],
      revoluteJoints: [],
      fixedJoints: [],
      allJoints: [],
      links: ['pelvis'],
      jointDetails: [],
    };
  }

  const cleanText = stripUrdfComments(urdfText);
  const jointBlocks = [...cleanText.matchAll(/<joint\b[^>]*>[\s\S]*?<\/joint>/g)].map((match) => match[0]);
  const jointDetails = jointBlocks
    .map((block) => {
      const name = block.match(/<joint\s+name="([^"]+)"/)?.[1] ?? null;
      const type = block.match(/<joint\s+[^>]*type="([^"]+)"/)?.[1] ?? 'fixed';
      const parent = block.match(/<parent\s+link="([^"]+)"/)?.[1] ?? null;
      const child = block.match(/<child\s+link="([^"]+)"/)?.[1] ?? null;
      const axis = block.match(/<axis\s+xyz="([^"]+)"/)?.[1] ?? '0 0 0';
      const origin = block.match(/<origin\s+xyz="([^"]+)"(?:\s+rpy="([^"]+)")?/)?.[1] ?? '0 0 0';
      const limit = block.match(/<limit\s+([^>]*)>/)?.[1] ?? '';
      return name ? { name, type, parent, child, axis, origin, limit } : null;
    })
    .filter(Boolean);

  const links = [...new Set([...cleanText.matchAll(/<link\s+name="([^"]+)"/g)].map((match) => match[1]))];

  return normalizeUrdfModelData({ jointDetails, links });
}

export async function fetchG1ModelInfo() {
  const response = await fetch('/api/g1-model');
  if (!response.ok) {
    return { ...G1_MODEL_INFO };
  }

  const data = await response.json();
  return { ...G1_MODEL_INFO, ...data };
}
