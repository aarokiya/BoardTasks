import type { GithubLink } from '@shared/models';

/** Test-only builder for a hydrated GitHub link. */
export function makeLink(p: Partial<GithubLink> = {}): GithubLink {
  return {
    id: 'gl-1', taskId: 'task-1', url: 'https://github.com/o/r/issues/12', host: 'github.com',
    owner: 'o', repo: 'r', type: 'issue', number: 12, title: 'Fix the flicker', state: 'open',
    author: 'octocat', authorAvatarUrl: null, labels: [], checks: null, reviewDecision: null,
    remoteUpdatedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), error: null,
    createdAt: new Date().toISOString(), ...p,
  };
}
