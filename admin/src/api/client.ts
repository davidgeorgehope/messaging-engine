const API_BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('token');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/admin/login';
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  // Dashboard
  getStats: () => request<any>('/admin/stats'),

  // Priorities
  getPriorities: () => request<any[]>('/admin/priorities'),
  createPriority: (data: any) => request<{ id: string }>('/admin/priorities', { method: 'POST', body: JSON.stringify(data) }),
  updatePriority: (id: string, data: any) => request<any>(`/admin/priorities/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Discovery
  getPainPoints: (params?: { status?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    return request<any[]>(`/admin/discovery/pain-points?${query}`);
  },
  approvePainPoint: (id: string) => request<any>(`/admin/discovery/pain-points/${id}/approve`, { method: 'POST' }),
  rejectPainPoint: (id: string, reason: string) =>
    request<any>(`/admin/discovery/pain-points/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getSchedules: () => request<any[]>('/admin/discovery/schedules'),
  triggerDiscovery: () => request<any>('/admin/discovery/trigger', { method: 'POST' }),

  // Jobs
  getJobs: (limit?: number) => request<any[]>(`/admin/jobs?limit=${limit || 50}`),
  getJob: (id: string) => request<any>(`/admin/jobs/${id}`),
  queueJob: (painPointId: string, assetTypes?: string[]) =>
    request<{ jobId: string }>('/admin/jobs/queue', { method: 'POST', body: JSON.stringify({ painPointId, assetTypes }) }),
  retryJob: (id: string) => request<any>(`/admin/jobs/${id}/retry`, { method: 'POST' }),

  // Messaging
  getMessagingAssets: (params?: { status?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', String(params.limit));
    return request<any[]>(`/admin/messaging?${query}`);
  },
  getMessagingAsset: (id: string) => request<any>(`/admin/messaging/${id}`),
  approveAsset: (id: string, data?: { approvedBy?: string; notes?: string }) =>
    request<any>(`/admin/messaging/${id}/approve`, { method: 'POST', body: JSON.stringify(data || {}) }),
  rejectAsset: (id: string, notes?: string) =>
    request<any>(`/admin/messaging/${id}/reject`, { method: 'POST', body: JSON.stringify({ notes }) }),
  selectVariant: (variantId: string) =>
    request<any>(`/admin/messaging/variants/${variantId}/select`, { method: 'POST' }),

  // Documents
  getDocuments: () => request<any[]>('/admin/documents'),
  createDocument: (data: any) => request<{ id: string }>('/admin/documents', { method: 'POST', body: JSON.stringify(data) }),
  updateDocument: (id: string, data: any) => request<any>(`/admin/documents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDocument: (id: string) => request<any>(`/admin/documents/${id}`, { method: 'DELETE' }),

  // Voice Profiles
  getVoiceProfiles: () => request<any[]>('/admin/voices'),
  getVoiceProfile: (id: string) => request<any>(`/admin/voices/${id}`),
  createVoiceProfile: (data: any) => request<{ id: string }>('/admin/voices', { method: 'POST', body: JSON.stringify(data) }),
  updateVoiceProfile: (id: string, data: any) => request<any>(`/admin/voices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Personas
  getPersonas: () => request<any[]>('/admin/personas'),
  createPersona: (data: any) => request<{ id: string }>('/admin/personas', { method: 'POST', body: JSON.stringify(data) }),
  updatePersona: (id: string, data: any) => request<any>(`/admin/personas/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Gaps
  getGaps: () => request<any[]>('/admin/gaps'),
  createGap: (data: any) => request<{ id: string }>('/admin/gaps', { method: 'POST', body: JSON.stringify(data) }),
  updateGap: (id: string, data: any) => request<any>(`/admin/gaps/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Settings
  getSettings: () => request<any[]>('/admin/settings'),
  updateSetting: (key: string, value: string) =>
    request<any>(`/admin/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
};
