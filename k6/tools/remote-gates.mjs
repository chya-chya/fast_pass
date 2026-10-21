import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_EVIDENCE = Object.freeze([
  ['phase3', 'docs/performance/PHASE3_VERIFICATION.md'],
  ['phase4', 'docs/performance/PHASE4_VERIFICATION.md'],
  ['phase7', 'docs/performance/QUEUE_DURABILITY.md'],
  ['phase11', 'docs/performance/PHASE11_VERIFICATION.md'],
]);

export async function verifyLocalGates(repositoryRoot, approval) {
  const evidence = [];
  for (const [gate, relativePath] of REQUIRED_EVIDENCE) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const content = await readFile(absolutePath, 'utf8');
    if (
      approval.gates[gate] !== 'INTEGRATION_VERIFIED' ||
      !content.includes('INTEGRATION_VERIFIED')
    ) {
      throw new Error(`${gate} is not INTEGRATION_VERIFIED`);
    }
    if (
      gate === 'phase7' &&
      /\*\*`?NO_GO`?\*\*|최종 상태:\s*`NO_GO`/.test(content)
    ) {
      throw new Error('phase7 NO_GO is still active');
    }
    evidence.push(relativePath);
  }
  if (approval.gates.noGo !== false) throw new Error('NO_GO must be false');
  return evidence;
}
