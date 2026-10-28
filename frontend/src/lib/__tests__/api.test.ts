import { ApiClient } from '../api';

type Sent = { url: string; method: string; body: unknown; headers: unknown };
let sent: Sent[];
let reply: unknown;

beforeEach(() => {
  sent = [];
  reply = { status: 'ok', data: { ok: 1 } };
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(url), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers,
    });
    return { json: async () => reply } as Response;
  }) as unknown as typeof fetch;
});

describe('ApiClient', () => {
  const api = new ApiClient('http://localhost:0');

  it('builds preview / export URLs', () => {
    expect(api.getPreviewUrl('clip-123')).toBe('http://localhost:0/api/clips/clip-123/preview');
    expect(api.getExportUrl('clip-456')).toBe('http://localhost:0/api/clips/clip-456/export');
    expect(new ApiClient('http://custom:9999').getPreviewUrl('x')).toBe('http://custom:9999/api/clips/x/preview');
  });

  it('defaults to same-origin (empty base) when NEXT_PUBLIC_API_URL is unset', () => {
    expect(new ApiClient().getPreviewUrl('x')).toBe('/api/clips/x/preview');
  });

  it('unwraps the data envelope and sends JSON', async () => {
    expect(await api.listVideos()).toEqual({ ok: 1 });
    expect(sent[0]).toMatchObject({ url: 'http://localhost:0/api/videos', method: 'GET',
      headers: { 'Content-Type': 'application/json' } });
  });

  it('throws the server error message, or a generic one', async () => {
    reply = { status: 'error', error: 'Video not found' };
    await expect(api.listVideos()).rejects.toThrow('Video not found');
    reply = { status: 'error' };
    await expect(api.listVideos()).rejects.toThrow('API error');
  });

  it.each([
    ['importVideo', () => api.importVideo('u', 'p'), 'POST', '/api/import', { url: 'u', localPath: 'p' }],
    ['startProcessing', () => api.startProcessing('v'), 'POST', '/api/process', { videoId: 'v' }],
    ['getJob', () => api.getJob('j'), 'GET', '/api/jobs/j', undefined],
    ['listJobs', () => api.listJobs(), 'GET', '/api/jobs', undefined],
    ['listClips', () => api.listClips('v'), 'GET', '/api/videos/v/clips', undefined],
    ['getClip', () => api.getClip('c'), 'GET', '/api/clips/c', undefined],
    ['exportClips', () => api.exportClips(['a']), 'POST', '/api/clips/export', { clipIds: ['a'] }],
    ['deleteVideo', () => api.deleteVideo('v'), 'DELETE', '/api/videos/v', undefined],
    ['cancelJob', () => api.cancelJob('j'), 'POST', '/api/jobs/j/cancel', undefined],
    ['discoverSearch', () => api.discoverSearch('q'), 'POST', '/api/discover/search',
      { query: 'q', maxResults: 20, minDuration: 0, maxDuration: 0 }],
    ['discoverTrending', () => api.discoverTrending(), 'POST', '/api/discover/trending', { maxResults: 20, region: 'ID' }],
    ['discoverChannel', () => api.discoverChannel('c', 5, 1, 2), 'POST', '/api/discover/channel',
      { channelUrl: 'c', maxResults: 5, minDuration: 1, maxDuration: 2 }],
    ['discoverAuto', () => api.discoverAuto(), 'POST', '/api/discover/auto', { goal: '', maxResults: 10 }],
    ['discoverAutoStatus', () => api.discoverAutoStatus('r'), 'GET', '/api/discover/auto/r', undefined],
    ['listCandidates', () => api.listCandidates(), 'GET', '/api/discover/candidates', undefined],
    ['listCandidates(status)', () => api.listCandidates('A B'), 'GET', '/api/discover/candidates?status=A%20B', undefined],
    ['updateCandidateStatus', () => api.updateCandidateStatus('i', 'SKIPPED'), 'POST',
      '/api/discover/candidates/i/status', { status: 'SKIPPED' }],
    ['queueCandidates', () => api.queueCandidates(['i']), 'POST', '/api/discover/queue', { ids: ['i'] }],
    ['drainCandidateQueue', () => api.drainCandidateQueue(), 'POST', '/api/discover/queue/drain', undefined],
    ['submitFeedback', () => api.submitFeedback('c', { views: 1, likes: 2, comments: 3, shares: 4, saves: 5, postedAt: 't' }),
      'POST', '/api/clips/c/feedback', { views: 1, likes: 2, comments: 3, shares: 4, saves: 5, postedAt: 't' }],
    ['trainWeights', () => api.trainWeights(), 'POST', '/api/feedback/train', undefined],
    ['getWeightsStatus', () => api.getWeightsStatus(), 'GET', '/api/feedback/weights', undefined],
    ['getSettings', () => api.getSettings(), 'GET', '/api/settings', undefined],
    ['updateSettings', () => api.updateSettings('jev', { apiKey: 'k', url: null }), 'PUT', '/api/settings/jev', { apiKey: 'k', url: null }],
    ['testConnection', () => api.testConnection('llm'), 'POST', '/api/settings/llm/test', undefined],
    ['socialAccounts', () => api.socialAccounts(), 'GET', '/api/social/accounts', undefined],
    ['publishDraft', () => api.publishDraft('c', ['a']), 'POST', '/api/clips/c/publish/draft', { accountIds: ['a'] }],
    ['publish', () => api.publish('c', { targets: [] }), 'POST', '/api/clips/c/publish', { targets: [] }],
    ['clipPosts', () => api.clipPosts('c'), 'GET', '/api/clips/c/posts', undefined],
    ['refreshPost', () => api.refreshPost('p'), 'POST', '/api/social/posts/p/refresh', undefined],
    ['retryPost', () => api.retryPost('p'), 'POST', '/api/social/posts/p/retry', undefined],
    ['cancelPost', () => api.cancelPost('p'), 'POST', '/api/social/posts/p/cancel', undefined],
    ['syncSocial', () => api.syncSocial(), 'POST', '/api/social/sync', undefined],
  ] as const)('%s → %s %s', async (_name, call, method, path, body) => {
    await call();
    expect(sent[0]).toMatchObject({ method, url: `http://localhost:0${path}`, body });
  });
});
