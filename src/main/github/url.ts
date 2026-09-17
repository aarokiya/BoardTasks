/**
 * The parser itself lives in src/shared so the renderer's paste handling and
 * picker use byte-identical rules. This module is the main-process entry point.
 */
export {
  canonicalGithubUrl,
  findGithubRefIn,
  GITHUB_DEFAULT_HOST,
  parseGithubUrl,
  shortGithubLabel,
  type GithubRef,
} from '@shared/github-url';
