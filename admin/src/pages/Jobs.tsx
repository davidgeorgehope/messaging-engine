import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

interface Job {
  id: string;
  painPointTitle: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  currentStep: string;
  assetTypes: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const data = await api.getJobs(50);
      setJobs(data);
      if (loading) setLoading(false);
    } catch (err: any) {
      setError(err.message || 'Failed to load jobs');
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, [loadJobs]);

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    try {
      await api.retryJob(id);
      await loadJobs();
    } catch (err: any) {
      setError(err.message || 'Failed to retry job');
    } finally {
      setRetryingId(null);
    }
  };

  const statusBadge = (status: Job['status']) => {
    const styles: Record<string, string> = {
      queued: 'bg-gray-100 text-gray-700',
      running: 'bg-blue-100 text-blue-700',
      completed: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
    };
    return (
      <span className={`text-xs font-medium px-2 py-1 rounded-full ${styles[status] || styles.queued}`}>
        {status}
      </span>
    );
  };

  const progressBar = (progress: number, status: Job['status']) => {
    const colorClass = status === 'failed' ? 'bg-red-500' : status === 'completed' ? 'bg-green-500' : 'bg-blue-500';
    return (
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${colorClass}`}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
    );
  };

  const formatDuration = (start?: string, end?: string) => {
    if (!start) return '-';
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const seconds = Math.floor((endTime - startTime) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading jobs...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Job Monitor</h1>
          <p className="text-sm text-gray-500 mt-1">Track messaging generation pipeline jobs (auto-refreshes every 5s)</p>
        </div>
        <button
          onClick={loadJobs}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {['queued', 'running', 'completed', 'failed'].map((status) => (
          <div key={status} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <p className="text-2xl font-bold text-gray-900">
              {jobs.filter((j) => j.status === status).length}
            </p>
            <p className="text-sm text-gray-500 capitalize">{status}</p>
          </div>
        ))}
      </div>

      {/* Jobs List */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        {jobs.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="text-lg font-medium">No jobs found</p>
            <p className="text-sm mt-1">Jobs appear here when pain points are processed through the messaging pipeline.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {jobs.map((job) => (
              <div key={job.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0 mr-4">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-sm font-medium text-gray-900 truncate">{job.painPointTitle}</h3>
                      {statusBadge(job.status)}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span>ID: {job.id.slice(0, 8)}...</span>
                      {job.assetTypes && (
                        <span>Types: {job.assetTypes.join(', ')}</span>
                      )}
                      <span>Created: {new Date(job.createdAt).toLocaleString()}</span>
                      <span>Duration: {formatDuration(job.startedAt, job.completedAt)}</span>
                    </div>
                  </div>
                  {job.status === 'failed' && (
                    <button
                      onClick={() => handleRetry(job.id)}
                      disabled={retryingId === job.id}
                      className="px-3 py-1.5 bg-orange-50 text-orange-600 rounded-md text-xs font-medium hover:bg-orange-100 disabled:opacity-50 transition-colors flex-shrink-0"
                    >
                      {retryingId === job.id ? 'Retrying...' : 'Retry'}
                    </button>
                  )}
                </div>

                {/* Progress */}
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-500">
                      {job.currentStep || (job.status === 'completed' ? 'Done' : 'Waiting...')}
                    </span>
                    <span className="text-xs text-gray-400">{job.progress}%</span>
                  </div>
                  {progressBar(job.progress, job.status)}
                </div>

                {/* Error Message */}
                {job.error && (
                  <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-600 font-mono">
                    {job.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
