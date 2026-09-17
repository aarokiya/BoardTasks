import type { Routes } from '../router';
import { notImplemented } from './_stub';

type AuthRoutes = Pick<Routes, 'auth:getStatus' | 'auth:setCredentials' | 'auth:clearCredentials' | 'auth:signIn' | 'auth:cancelSignIn' | 'auth:signOut'>;

export function authRoutes(): AuthRoutes {
  return {
    'auth:getStatus': notImplemented('auth:getStatus'),
    'auth:setCredentials': notImplemented('auth:setCredentials'),
    'auth:clearCredentials': notImplemented('auth:clearCredentials'),
    'auth:signIn': notImplemented('auth:signIn'),
    'auth:cancelSignIn': notImplemented('auth:cancelSignIn'),
    'auth:signOut': notImplemented('auth:signOut'),
  };
}
