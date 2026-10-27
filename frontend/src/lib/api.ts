// Unset → same origin (the static UI is served by the backend). `next dev`
// sets it to http://localhost:8080 via .env.local.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const json = await res.json();
    if (json.status === 'error') {
      throw new Error(json.error || 'API error');
    }
    return json.data as T;
  }

  async importVideo(url?: string, localPath?: string) {
    return this.request('/api/import', {
      method: 'POST',
      body: JSON.stringify({ url, localPath }),
    });
  }

  async startProcessing(videoId: string) {
    return this.request('/api/process', {
      method: 'POST',
      body: JSON.stringify({ videoId }),
    });
  }

  async getJob(jobId: string) {
    return this.request(`/api/jobs/${jobId}`);
  }

  async listJobs() {
    return this.request('/api/jobs');
  }

  async listClips(videoId: string) {
    return this.request(`/api/videos/${videoId}/clips`);
  }

  async getClip(clipId: string) {
    return this.request(`/api/clips/${clipId}`);
  }

  async exportClips(clipIds: string[]) {
    return this.request('/api/clips/export', {
      method: 'POST',
      body: JSON.stringify({ clipIds }),
    });
  }

  async listVideos() {
    return this.request('/api/videos');
  }

  async deleteVideo(videoId: string) {
    return this.request(`/api/videos/${videoId}`, { method: 'DELETE' });
  }

  async cancelJob(jobId: string) {
    return this.request(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  }

  async discoverSearch(query: string, maxResults = 20, minDuration = 0, maxDuration = 0) {
    return this.request('/api/discover/search', {
      method: 'POST',
      body: JSON.stringify({ query, maxResults, minDuration, maxDuration }),
    });
  }

  async discoverTrending(maxResults = 20, region = 'ID') {
    return this.request('/api/discover/trending', {
      method: 'POST',
      body: JSON.stringify({ maxResults, region }),
    });
  }

  async discoverChannel(channelUrl: string, maxResults = 20, minDuration = 0, maxDuration = 0) {
    return this.request('/api/discover/channel', {
      method: 'POST',
      body: JSON.stringify({ channelUrl, maxResults, minDuration, maxDuration }),
    });
  }

  async listCandidates(status?: string) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request(`/api/discover/candidates${qs}`);
  }

  async updateCandidateStatus(id: string, status: string) {
    return this.request(`/api/discover/candidates/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  }

  async queueCandidates(ids: string[]) {
    return this.request('/api/discover/queue', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }

  async drainCandidateQueue() {
    return this.request('/api/discover/queue/drain', { method: 'POST' });
  }

  async submitFeedback(
    clipId: string,
    metrics: {
      views: number; likes: number; comments: number; shares: number; saves: number;
      /** ISO-8601 timestamp when the clip was uploaded to TikTok (required). */
      postedAt: string;
    },
  ) {
    return this.request(`/api/clips/${clipId}/feedback`, {
      method: 'POST',
      body: JSON.stringify(metrics),
    });
  }

  async trainWeights() {
    return this.request('/api/feedback/train', { method: 'POST' });
  }

  async getWeightsStatus() {
    return this.request('/api/feedback/weights');
  }

  getPreviewUrl(clipId: string) {
    return `${this.baseUrl}/api/clips/${clipId}/preview`;
  }

  getExportUrl(clipId: string) {
    return `${this.baseUrl}/api/clips/${clipId}/export`;
  }
}
