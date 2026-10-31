// Unset → same origin (the static UI is served by the backend). `next dev`
// sets it to http://localhost:8080 via .env.local.
import type {
  CaptionWord, Clip, ConnectionKind, Connections, ConnectionTest, GenCreateBody, GenPlan, GenPlanRow, GenProject, GenProjectDetail, GenAsset, GenEvent, GenerateStatus, PipelineOptions, PublishDraft, SocialAccount, SocialPost,
} from '@/types';

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

  /** ``range`` limits the import to part of the source ("1:25", "85", "13m25s"). */
  async importVideo(url?: string, localPath?: string, range?: { startTime?: string; endTime?: string }) {
    return this.request('/api/import', {
      method: 'POST',
      body: JSON.stringify({ url, localPath, ...range }),
    });
  }

  async startProcessing(videoId: string, options?: PipelineOptions) {
    return this.request('/api/process', {
      method: 'POST',
      body: JSON.stringify({ videoId, options }),
    });
  }

  async getOptions() {
    return this.request<{ styles: string[]; reframeModes: string[]; defaults: Required<PipelineOptions> }>('/api/options');
  }

  async listMusic() {
    return this.request<{ tracks: string[] }>('/api/music');
  }

  async getClipCaptions(clipId: string) {
    return this.request<{ words: CaptionWord[]; edited: boolean }>(`/api/clips/${clipId}/captions`);
  }

  async rerenderClip(clipId: string, body: {
    startTime?: number; endTime?: number; options?: PipelineOptions; captionWords?: CaptionWord[] | null;
  }) {
    return this.request<{ clip: Clip }>(`/api/clips/${clipId}/rerender`, {
      method: 'POST',
      body: JSON.stringify(body),
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

  async discoverAuto(goal = '', maxResults = 10) {
    return this.request('/api/discover/auto', {
      method: 'POST',
      body: JSON.stringify({ goal, maxResults }),
    });
  }

  async discoverAutoStatus(runId: string) {
    return this.request(`/api/discover/auto/${runId}`);
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
      /** ISO-8601 timestamp when the clip was posted (required). */
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

  /** Logged results for posted clips, newest post first. */
  async listFeedback() {
    return this.request('/api/feedback');
  }

  // ---- connections (LLM, Jev, Tebar) ----

  async getSettings() {
    return this.request<Connections>('/api/settings');
  }

  /** A value saves the field; null clears it (back to the server's env value). */
  async updateSettings(kind: ConnectionKind, patch: Record<string, string | boolean | null>) {
    return this.request<Connections>(`/api/settings/${kind}`, { method: 'PUT', body: JSON.stringify(patch) });
  }

  async testConnection(kind: ConnectionKind) {
    return this.request<ConnectionTest>(`/api/settings/${kind}/test`, { method: 'POST' });
  }

  async getGenerateStatus() {
    return this.request<GenerateStatus>('/api/generate/status');
  }

  // ---- Generate ----

  async listGenerateProjects() {
    return this.request<{ projects: GenProject[] }>('/api/generate/projects');
  }

  async createGenerateProject(body: GenCreateBody) {
    return this.request<{ project: GenProject }>('/api/generate/projects', { method: 'POST', body: JSON.stringify(body) });
  }

  async getGenerateProject(id: string) {
    return this.request<GenProjectDetail>(`/api/generate/projects/${id}`);
  }

  async deleteGenerateProject(id: string) {
    return this.request<{ deleted: boolean }>(`/api/generate/projects/${id}`, { method: 'DELETE' });
  }

  async retryGenerateProject(id: string) {
    return this.request<{ project: GenProject }>(`/api/generate/projects/${id}/retry`, { method: 'POST' });
  }

  async newStorylines(id: string, note?: string) {
    return this.request<{ project: GenProject }>(`/api/generate/projects/${id}/storylines`, { method: 'POST', body: JSON.stringify({ note }) });
  }

  async pickStoryline(id: string, index: number, note?: string) {
    return this.request<{ project: GenProject }>(`/api/generate/projects/${id}/storylines/${index}/pick`, { method: 'POST', body: JSON.stringify({ note }) });
  }

  async saveGeneratePlan(id: string, plan: GenPlan) {
    return this.request<{ plan: GenPlanRow }>(`/api/generate/projects/${id}/plan`, { method: 'PUT', body: JSON.stringify({ plan }) });
  }

  async reviseGeneratePlan(id: string, request: string) {
    return this.request<{ plan: GenPlanRow; changeSummary: string }>(`/api/generate/projects/${id}/plan/revise`, { method: 'POST', body: JSON.stringify({ request }) });
  }

  async approveGeneratePlan(id: string, planId: string) {
    return this.request<{ project: GenProject }>(`/api/generate/projects/${id}/plan/approve`, { method: 'POST', body: JSON.stringify({ planId }) });
  }

  /** Multipart: the browser sets the content type (and its boundary). */
  async uploadGenerateAsset(id: string, file: File, kind: string, shotId?: string) {
    const form = new FormData();
    form.set('file', file);
    form.set('kind', kind);
    if (shotId) form.set('shotId', shotId);
    return this.request<{ asset: GenAsset }>(`/api/generate/projects/${id}/assets`, { method: 'POST', body: form, headers: {} });
  }

  async deleteGenerateAsset(assetId: string) {
    return this.request<{ deleted: boolean }>(`/api/generate/assets/${assetId}`, { method: 'DELETE' });
  }

  async getGenerateEvents(id: string, limit = 100) {
    return this.request<{ events: GenEvent[] }>(`/api/generate/projects/${id}/events?limit=${limit}`);
  }

  // ---- publishing (Tebar) ----

  async socialAccounts() {
    return this.request<{ enabled: boolean; accounts: SocialAccount[] }>('/api/social/accounts');
  }

  async publishDraft(clipId: string, accountIds: string[]) {
    return this.request<PublishDraft>(`/api/clips/${clipId}/publish/draft`, { method: 'POST', body: JSON.stringify({ accountIds }) });
  }

  async publish(clipId: string, body: {
    targets: Array<{
      accountId: string; content: string; title?: string; madeForKids?: boolean; privacyLevel?: string; postMode?: 'direct' | 'draft';
    }>;
    scheduledAt?: string; confirmReview?: boolean; override?: boolean;
  }) {
    return this.request<{ post: SocialPost }>(`/api/clips/${clipId}/publish`, { method: 'POST', body: JSON.stringify(body) });
  }

  async clipPosts(clipId: string) {
    return this.request<{ posts: SocialPost[] }>(`/api/clips/${clipId}/posts`);
  }

  async refreshPost(postId: string) {
    return this.request<{ post: SocialPost }>(`/api/social/posts/${postId}/refresh`, { method: 'POST' });
  }

  /** Re-send a post that never reached Tebar; on FAILED/PARTIAL posts Tebar redoes only the failed accounts. */
  async retryPost(postId: string) {
    return this.request<{ post: SocialPost }>(`/api/social/posts/${postId}/retry`, { method: 'POST' });
  }

  /** Cancel a SCHEDULED post. */
  async cancelPost(postId: string) {
    return this.request<{ post: SocialPost }>(`/api/social/posts/${postId}/cancel`, { method: 'POST' });
  }

  async syncSocial() {
    return this.request<{ posts: number; clips: number; errors: string[] }>('/api/social/sync', { method: 'POST' });
  }

  /** ``version`` (e.g. clip.updatedAt) busts the browser cache after a re-render. */
  getPreviewUrl(clipId: string, version?: string | null) {
    return `${this.baseUrl}/api/clips/${clipId}/preview${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  }

  getExportUrl(clipId: string, version?: string | null) {
    return `${this.baseUrl}/api/clips/${clipId}/export${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  }
}
