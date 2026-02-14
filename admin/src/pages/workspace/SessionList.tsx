import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  generating: 'bg-blue-100 text-blue-800 animate-pulse',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

export default function SessionList() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    loadSessions();
  }, [showArchived]);

  async function loadSessions() {
    try {
      const result = await api.getSessions({ archived: showArchived ? 'true' : 'false' });
      setSessions(result.data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const handleArchive = async (e: React.MouseEvent, sessionId: string, isArchived: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.updateSession(sessionId, { isArchived: !isArchived });
      await loadSessions();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const filtered = useMemo(() => {
    return sessions.filter(s => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!s.name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [sessions, search, statusFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-500">Loading sessions...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Sessions</h1>
        <Link
          to="/workspace/new"
          className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 transition-colors"
        >
          New Session
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions..."
          className="px-3 py-1.5 border border-gray-300 rounded-md text-sm w-64 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        >
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="generating">Generating</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded text-blue-600"
          />
          Show archived
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          {sessions.length === 0 ? (
            <>
              <div className="text-gray-400 text-lg mb-2">No sessions yet</div>
              <p className="text-gray-500 text-sm mb-4">Create your first messaging session to get started.</p>
              <Link
                to="/workspace/new"
                className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 transition-colors"
              >
                Create First Session
              </Link>
            </>
          ) : (
            <div className="text-gray-400 text-lg">No sessions match your filters.</div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((session) => {
            const assetTypes = (() => {
              try { return JSON.parse(session.assetTypes || '[]'); } catch { return []; }
            })();

            return (
              <Link
                key={session.id}
                to={`/workspace/sessions/${session.id}`}
                className={`block bg-white rounded-lg shadow-sm border p-5 hover:shadow-md transition-all ${
                  session.isArchived ? 'border-gray-300 opacity-60' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <h3 className="font-semibold text-gray-900 truncate flex-1 mr-2">
                    {session.isArchived && <span className="text-gray-400 mr-1">[Archived]</span>}
                    {session.name}
                  </h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${STATUS_STYLES[session.status] || 'bg-gray-100 text-gray-600'}`}>
                    {session.status}
                  </span>
                </div>

                {assetTypes.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {assetTypes.slice(0, 4).map((type: string) => (
                      <span key={type} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {type.replace(/_/g, ' ')}
                      </span>
                    ))}
                    {assetTypes.length > 4 && (
                      <span className="text-xs text-gray-400">+{assetTypes.length - 4} more</span>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="text-xs text-gray-400">
                    {timeAgo(session.createdAt)}
                  </div>
                  <button
                    onClick={(e) => handleArchive(e, session.id, session.isArchived)}
                    className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                    title={session.isArchived ? 'Unarchive' : 'Archive'}
                  >
                    {session.isArchived ? 'Unarchive' : 'Archive'}
                  </button>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
