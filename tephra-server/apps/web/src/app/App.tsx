import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { LoginPage, SetupPage } from '../routes/AuthPages';
import { SettingsPage } from '../routes/SettingsPage';
import { VaultListPage } from '../routes/VaultListPage';
import { VaultWorkspace } from '../routes/VaultWorkspace';
import { PublicOnly, RequireAuth, SetupOnly } from './RouteGuards';
export function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route element={<SetupOnly />}>
        <Route path="/setup" element={<SetupPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/vaults" element={<VaultListPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/v/:vaultSlug/*" element={<VaultWorkspace />} />
        </Route>
      </Route>
      <Route path="/" element={<Navigate to="/vaults" replace />} />
      <Route
        path="*"
        element={
          <main className="status">
            <h1>Page not found</h1>
            <a href="/vaults">Return to your vaults</a>
          </main>
        }
      />
    </Routes>
  );
}
