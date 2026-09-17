/**
 * The renderer's copy of the GitHub reference parser — the same module main
 * uses, so paste detection and linking can never disagree about what counts
 * as a GitHub issue or pull-request link.
 */
export {
  canonicalGithubUrl,
  findGithubRefIn,
  GITHUB_DEFAULT_HOST,
  parseGithubUrl,
  shortGithubLabel,
  type GithubRef,
} from '@shared/github-url';
