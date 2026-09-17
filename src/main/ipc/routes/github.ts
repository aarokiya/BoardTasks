import type { Routes } from '../router';
import { notImplemented } from './_stub';

type GithubRoutes = Pick<Routes, 'github:getStatus' | 'github:setToken' | 'github:clearToken' | 'github:link' | 'github:unlink' | 'github:refresh' | 'github:search'>;

export function githubRoutes(): GithubRoutes {
  return {
    'github:getStatus': notImplemented('github:getStatus'),
    'github:setToken': notImplemented('github:setToken'),
    'github:clearToken': notImplemented('github:clearToken'),
    'github:link': notImplemented('github:link'),
    'github:unlink': notImplemented('github:unlink'),
    'github:refresh': notImplemented('github:refresh'),
    'github:search': notImplemented('github:search'),
  };
}
