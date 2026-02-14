import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import WorkspaceLayout from './components/WorkspaceLayout';
import Dashboard from './pages/Dashboard';
import ProductDocs from './pages/ProductDocs';
import VoiceProfiles from './pages/VoiceProfiles';
import VoiceProfileDetail from './pages/VoiceProfileDetail';
import History from './pages/History';
import Settings from './pages/Settings';
import Login from './pages/Login';
import Signup from './pages/Signup';
import SessionList from './pages/workspace/SessionList';
import NewSession from './pages/workspace/NewSession';
import SessionWorkspace from './pages/workspace/SessionWorkspace';

function App() {
  const token = localStorage.getItem('token');

  if (!token) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="*" element={<Navigate to="/login" />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Auth */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        {/* Admin routes */}
        <Route path="/admin" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="documents" element={<ProductDocs />} />
          <Route path="voices" element={<VoiceProfiles />} />
          <Route path="voices/:id" element={<VoiceProfileDetail />} />
          <Route path="history" element={<History />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        {/* Workspace routes */}
        <Route path="/workspace" element={<WorkspaceLayout />}>
          <Route index element={<SessionList />} />
          <Route path="new" element={<NewSession />} />
          <Route path="sessions/:id" element={<SessionWorkspace />} />
        </Route>

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/workspace" />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
