import type { HiveEvent } from '../../src/contracts/index.js';

export const EVENT: HiveEvent = {
  id: 'evt-01',
  product: 'magnus',
  type: 'agent.task.failed',
  severity: 'warning',
  title: 'Task failed',
  summary: 'The nightly sync task failed twice.',
  occurredAt: '2026-11-12T08:30:00.123Z',
  subject: { actorId: 'operator', agentRef: 'node-a~writer', nodeId: 'node-a' },
  link: { product: 'magnus', path: '/agents/node-a~writer?tab=tasks' },
  sourceRef: 'task:42',
};
