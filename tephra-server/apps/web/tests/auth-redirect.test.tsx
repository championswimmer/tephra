import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../src/app/RouteGuards';
import { useAuth } from '../src/app/AuthContext';

vi.mock('../src/app/AuthContext', () => ({ useAuth: vi.fn() }));
const mockedUseAuth = vi.mocked(useAuth);
describe('authentication route guard', () => {
  beforeEach(() =>
    mockedUseAuth.mockReturnValue({
      state: 'anonymous',
      user: null,
      refresh: vi.fn(),
      signOut: vi.fn(),
    }),
  );
  it('redirects an unauthenticated deep link to login', () => {
    render(
      <MemoryRouter initialEntries={['/v/vault-1/file/note-1']}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/v/:vaultId/file/:fileId" element={<h1>Private note</h1>} />
          </Route>
          <Route path="/login" element={<h1>Sign in</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Private note')).not.toBeInTheDocument();
  });
});
