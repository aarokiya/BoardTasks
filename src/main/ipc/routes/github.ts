import { z } from 'zod';
import type { Routes } from '../router';
import { AppError } from '../errors';
import { idSchema, voidSchema } from '../schemas';
import { getGithubService, type GithubService } from '../../github/service';

type GithubRoutes = Pick<Routes, 'github:getStatus' | 'github:setToken' | 'github:clearToken' | 'github:link' | 'github:unlink' | 'github:refresh' | 'github:search'>;

/** Resolved per call: routes are registered before the service is constructed. */
function svc(): GithubService {
  const s = getGithubService();
  if (!s) throw new AppError('INTERNAL', 'GitHub integration is not available.');
  return s;
}

const tokenSchema = z.string().trim().min(20, 'That token looks too short.').max(255);
const linkSchema = z.object({ taskId: idSchema, url: z.string().trim().min(1).max(2048) });
const refreshSchema = z.union([z.object({ taskId: idSchema }), z.object({ all: z.literal(true) })]);
const searchSchema = z.object({ q: z.string().max(256), limit: z.number().int().min(1).max(50).optional() });

export function githubRoutes(): GithubRoutes {
  return {
    'github:getStatus': { schema: voidSchema, handle: () => svc().status() },
    'github:setToken': { schema: z.object({ token: tokenSchema }), handle: (p) => svc().setToken(p.token) },
    'github:clearToken': { schema: voidSchema, handle: () => svc().clearToken() },
    'github:link': { schema: linkSchema, handle: (p) => svc().link(p.taskId, p.url) },
    'github:unlink': { schema: z.object({ taskId: idSchema }), handle: (p) => { svc().unlink(p.taskId); } },
    'github:refresh': { schema: refreshSchema, handle: (p) => svc().refresh(p) },
    'github:search': { schema: searchSchema, handle: (p) => svc().search(p.q, p.limit ?? 20) },
  };
}
