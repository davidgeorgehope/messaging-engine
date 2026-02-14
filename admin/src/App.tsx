import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ProductDocs from './pages/ProductDocs';
import VoiceProfiles from './pages/VoiceProfiles';
import VoiceProfileDetail from './pages/VoiceProfileDetail';
import History from './pages/History';
import Settings from './pages/Settings';
import Login from './pages/Login';

function App() {
  const token = localStorage.getItem('token');

  if (!token) {
    return (
      <BrowserRouter basename="/admin">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/documents" element={<ProductDocs />} />
          <Route path="/voices" element={<VoiceProfiles />} />
          <Route path="/voices/:id" element={<VoiceProfileDetail />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
