import { Outlet, Link, useLocation } from 'react-router-dom';

const NAV_ITEMS = [
  { path: '/admin', label: 'Dashboard', icon: '📊' },
  { path: '/admin/documents', label: 'Product Docs', icon: '📄' },
  { path: '/admin/voices', label: 'Voice Profiles', icon: '🎙️' },
  { path: '/admin/history', label: 'History', icon: '📋' },
  { path: '/admin/settings', label: 'Settings', icon: '⚡' },
];

export default function Layout() {
  const location = useLocation();

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <nav className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-lg font-bold">Messaging Engine</h1>
          <p className="text-xs text-gray-400 mt-1">Admin</p>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {/* Link to workspace */}
          <Link
            to="/workspace"
            className="flex items-center px-4 py-2.5 text-sm text-indigo-300 hover:bg-gray-800 hover:text-indigo-200 transition-colors border-b border-gray-800 mb-1"
          >
            <span className="mr-3">✨</span>
            Workspace
          </Link>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center px-4 py-2.5 text-sm transition-colors ${
                location.pathname === item.path
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span className="mr-3">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleLogout}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
