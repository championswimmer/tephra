import { z } from 'zod';
import {
  clearSessionCookie,
  constantTimeSecretEqual,
  createOpaqueToken,
  hashOpaqueToken,
  sessionCookie,
} from '@tephra/auth';
import { fail } from '../http/errors.js';
import { jsonBody } from '../http/body.js';
import { requireSession } from '../http/auth.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';

const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const credentialsSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(10).max(1024),
});
const bootstrapSchema = credentialsSchema
  .extend({
    token: z.string().min(1).max(1024).optional(),
    bootstrapToken: z.string().min(1).max(1024).optional(),
  })
  .transform((data) => ({
    email: data.email,
    password: data.password,
    token: (data.token ?? data.bootstrapToken ?? "").trim(),
  }))
  .refine((data) => data.token.length > 0, {
    message: "Bootstrap token is required.",
    path: ["token"],
  });


/** Unauthenticated endpoints: bootstrap status/creation and login. */
export function registerPublicAuthRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/api/v1/auth/bootstrap/status', async (c) =>
    c.json({ required: (await dependencies.database.users.count()) === 0 }),
  );
  app.post('/api/v1/auth/bootstrap', async (c) => {
    const body = await jsonBody(c, bootstrapSchema);
    if ((await dependencies.database.users.count()) !== 0)
      fail(409, 'COMMIT_FAILED', 'Bootstrap has already completed.');
    if (
      !dependencies.bootstrapToken ||
      !constantTimeSecretEqual(body.token, dependencies.bootstrapToken)
    ) {
      fail(401, 'AUTH_REQUIRED', 'Invalid bootstrap token.');
    }
    const user = await dependencies.database.transaction(async (repositories) => {
      if ((await repositories.users.count()) !== 0)
        fail(409, 'COMMIT_FAILED', 'Bootstrap has already completed.');
      const now = dependencies.clock.now();
      const created = {
        id: dependencies.ids.generate(),
        email: body.email.toLowerCase(),
        passwordHash: await dependencies.passwordHasher.hash(body.password),
        createdAt: now,
        updatedAt: now,
      };
      await repositories.users.insert(created);
      return created;
    });
    return c.json({ user: { id: user.id, email: user.email } }, 201);
  });

  app.post('/api/v1/auth/login', async (c) => {
    const body = await jsonBody(c, credentialsSchema);
    const user = await dependencies.database.users.findByEmail(body.email.toLowerCase());
    const comparisonHash =
      user?.passwordHash ?? (await dependencies.passwordHasher.hash('invalid-login-placeholder'));
    const valid = await dependencies.passwordHasher.verify(body.password, comparisonHash);
    if (!user || !user.passwordHash || !valid)
      fail(401, 'AUTH_REQUIRED', 'Invalid email or password.');
    const raw = createOpaqueToken('tps');
    const csrfToken = createOpaqueToken('tpc');
    const now = dependencies.clock.now();
    await dependencies.database.sessions.insert({
      id: await hashOpaqueToken(raw),
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_AGE_MS,
    });
    c.header(
      'Set-Cookie',
      sessionCookie(raw, {
        ...(dependencies.secureCookies === undefined ? {} : { secure: dependencies.secureCookies }),
        ...(dependencies.sessionCookieName === undefined
          ? {}
          : { name: dependencies.sessionCookieName }),
        maxAgeSeconds: SESSION_AGE_MS / 1000,
      }),
    );
    c.header(
      'Set-Cookie',
      `tephra_csrf=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Lax${dependencies.secureCookies === false ? '' : '; Secure'}; Max-Age=${SESSION_AGE_MS / 1000}`,
      { append: true },
    );
    return c.json({ user: { id: user.id, email: user.email }, sessionToken: raw, csrfToken });
  });
}

/** Endpoints behind the auth middleware: logout and current user. */
export function registerSessionAuthRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.post('/api/v1/auth/logout', async (c) => {
    const principal = requireSession(c);
    await dependencies.database.sessions.delete(principal.session.id);
    c.header(
      'Set-Cookie',
      clearSessionCookie({
        ...(dependencies.secureCookies === undefined ? {} : { secure: dependencies.secureCookies }),
        ...(dependencies.sessionCookieName === undefined
          ? {}
          : { name: dependencies.sessionCookieName }),
      }),
    );
    return c.json({ ok: true });
  });
  app.get('/api/v1/auth/me', (c) => {
    const principal = c.get('principal');
    return c.json({ user: { id: principal.user.id, email: principal.user.email } });
  });
}
