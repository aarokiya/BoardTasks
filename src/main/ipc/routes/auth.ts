import { z } from 'zod';
import type { AuthStatus } from '@shared/models';
import type { Routes } from '../router';
import { AppError } from '../errors';
import { clientIdSchema, clientSecretSchema, voidSchema } from '../schemas';
import { getAuthService } from '../../auth/auth-service';
import { AuthError } from '../../auth/types';
import { GoogleOAuthError, OAuthNetworkError, describeOAuthError } from '../../auth/token-endpoint';

type AuthRoutes = Pick<
  Routes,
  'auth:getStatus' | 'auth:setCredentials' | 'auth:clearCredentials' | 'auth:signIn' | 'auth:cancelSignIn' | 'auth:signOut'
>;

/**
 * Nothing throws across the IPC boundary, so every auth failure becomes an
 * AppError with a code the renderer can branch on and a message a user can act
 * on. Google's error_description is carried through verbatim — it is usually
 * the only thing that distinguishes a wrong secret from a wrong client type.
 */
function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof OAuthNetworkError) {
    return new AppError('NETWORK', e.message, { retryable: true, cause: e });
  }
  if (e instanceof GoogleOAuthError) {
    return new AppError('UNAUTHENTICATED', describeOAuthError(e), { details: { error: e.error }, cause: e });
  }
  if (e instanceof AuthError) {
    switch (e.reason) {
      case 'cancelled':
        return new AppError('CANCELLED', e.message, { details: { reason: e.reason }, cause: e });
      case 'timeout':
        return new AppError('TIMEOUT', e.message, { retryable: true, details: { reason: e.reason }, cause: e });
      default:
        return new AppError('UNAUTHENTICATED', e.message, { details: { reason: e.reason }, cause: e });
    }
  }
  return new AppError('INTERNAL', 'Sign-in failed unexpectedly. Details were written to the log.', { cause: e });
}

async function guard(run: () => Promise<AuthStatus> | AuthStatus): Promise<AuthStatus> {
  try {
    return await run();
  } catch (e) {
    throw toAppError(e);
  }
}

export function authRoutes(): AuthRoutes {
  return {
    'auth:getStatus': { schema: voidSchema, handle: () => getAuthService().getStatus() },
    'auth:setCredentials': {
      schema: z.object({ clientId: clientIdSchema, clientSecret: clientSecretSchema }),
      handle: (p) => guard(() => getAuthService().setCredentials(p)),
    },
    'auth:clearCredentials': { schema: voidSchema, handle: () => guard(() => getAuthService().clearCredentials()) },
    'auth:signIn': { schema: voidSchema, handle: () => guard(() => getAuthService().signIn()) },
    'auth:cancelSignIn': { schema: voidSchema, handle: () => guard(() => getAuthService().cancelSignIn()) },
    'auth:signOut': {
      schema: z.object({ wipeLocalData: z.boolean() }),
      handle: (p) => guard(() => getAuthService().signOut(p)),
    },
  };
}
