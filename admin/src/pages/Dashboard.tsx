import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      setLoading(true);
      const data = await api.getStats();
      setStats(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load dashboard stats');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        <p className="font-medium">Error loading dashboard</p>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={loadStats} className="mt-2 text-sm underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  const statCards = [
    {
      label: 'Generated Assets',
      value: stats?.messaging?.total ?? 0,
      link: '/history',
      color: 'bg-purple-500',
    },
    {
      label: 'In Review',
      value: stats?.messaging?.review ?? 0,
      link: '/history',
      color: 'bg-yellow-500',
    },
    {
      label: 'Active Voice Profiles',
      value: stats?.voices?.active ?? 0,
      link: '/voices',
      color: 'bg-indigo-500',
    },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Messaging Engine overview</p>
      </div>

      {/* Quick Actions */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-6 mb-8">
        <h2 className="text-lg font-semibold text-indigo-900 mb-2">Generate Messaging</h2>
        <p className="text-sm text-indigo-700 mb-4">
          Paste product docs, select voices and asset types, and generate scored messaging in all voices.
        </p>
        <a
          href="/"
          className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          Open Generator
        </a>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {statCards.map((card) => (
          <Link
            key={card.label}
            to={card.link}
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow"
          >
            <div className={`w-2 h-2 rounded-full ${card.color} mb-3`} />
            <p className="text-2xl font-bold text-gray-900">{card.value}</p>
            <p className="text-sm text-gray-500 mt-1">{card.label}</p>
          </Link>
        ))}
      </div>

      {/* Pipeline Status */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">System Status</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Voice Profiles</span>
            <span className="text-sm text-gray-900 font-medium">{stats?.voices?.active ?? 0} active</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Total Generated Assets</span>
            <span className="text-sm text-gray-900 font-medium">{stats?.messaging?.total ?? 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Discovery Pipeline</span>
            <span className="text-xs font-medium px-2 py-1 bg-green-100 text-green-700 rounded-full">Active</span>
          </div>
        </div>
      </div>
    </div>
  );
}
