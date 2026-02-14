import { Outlet, Link, useLocation } from 'react-router-dom';
import { useMemo } from 'react';

export default function WorkspaceLayout() {
  const location = useLocation();

  const user = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('user') || '{}');
    } catch {
      return {};
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top header */}
      <header className="bg-gray-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link to="/workspace" className="text-lg font-bold hover:text-gray-200 transition-colors">
                Messaging Workspace
              </Link>
              <nav className="flex items-center gap-1">
                <Link
                  to="/workspace"
                  className={`px-3 py-1.5 rounded text-sm transition-colors ${
                    location.pathname === '/workspace' || location.pathname === '/workspace/'
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  Sessions
                </Link>
                <Link
                  to="/workspace/new"
                  className={`px-3 py-1.5 rounded text-sm transition-colors ${
                    location.pathname === '/workspace/new'
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  New Session
                </Link>
              </nav>
            </div>
            <div className="flex items-center gap-4">
              {user.displayName && (
                <span className="text-sm text-gray-300">{user.displayName}</span>
              )}
              {(user.role === 'admin') && (
                <Link
                  to="/admin"
                  className="text-sm text-indigo-300 hover:text-indigo-200 transition-colors"
                >
                  Admin
                </Link>
              )}
              <button
                onClick={handleLogout}
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
