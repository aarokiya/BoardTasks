import type { Task } from '@shared/models';

/** Seam so task creation can attach a GitHub link without importing the GitHub module directly. */
export interface GithubHooks {
  linkUrl(taskId: string, url: string): Promise<Task | null>;
}

export const githubHooks: GithubHooks = {
  linkUrl: () => Promise.resolve(null),
};

export function installGithubHooks(h: Partial<GithubHooks>): void {
  Object.assign(githubHooks, h);
}
