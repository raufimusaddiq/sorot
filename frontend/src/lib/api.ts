// Unset → same origin (the static UI is served by the backend). `next dev`
// sets it to http://localhost:8080 via .env.local.
import type {
  CaptionWord, Clip, ConnectionKind, Connections, ConnectionTest, GenCreateBody, GenPlan, GenPlanRow, GenProject, GenProjectDetail, GenAsset, GenEstimate, GenEvent, GenExport, GenFact, GenIdea, GenRecipe, GenRecipeItem, GenStepSpec, GenFixBody, GenFixResult, GenKitPart, GenLevel, GenModels, GenVerdict, GenVersion, GenerateStatus, PipelineOptions, PublishDraft, SocialAccount, SocialPost, KenariAccount, KenariModel, KenariVoiceModel,
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

  /** Kenari's live model catalog, for the onboarding picker — public, no key needed. */
  async getKenariModels() {
    return this.request<{ models: KenariModel[]; warning?: string }>('/api/settings/llm/kenari-models');
  }

  /** Validate a candidate LLM connection (not yet saved) with one small real call. */
  async probeLlm(candidate: { baseUrl?: string; model: string; apiKey: string }) {
    return this.request<ConnectionTest>('/api/settings/llm/probe', { method: 'POST', body: JSON.stringify(candidate) });
  }

  /** The saved Kenari connection's balance, plan quota and usage — null when not connected to Kenari. */
  async getKenariAccount() {
    return this.request<{ account: KenariAccount | null; warning?: string }>('/api/settings/llm/kenari-account');
  }

  /** Kenari's image-generation models, for the image onboarding picker. */
  async getKenariImageModels() {
    return this.request<{ models: KenariModel[]; warning?: string }>('/api/settings/image/kenari-models');
  }

  /** Kenari's text-to-speech models and their voices, for the voice onboarding picker. */
  async getKenariVoiceModels() {
    return this.request<{ models: KenariVoiceModel[]; warning?: string }>('/api/settings/voice/kenari-models');
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

  async getGenerateEstimate(id: string) {
    return this.request<GenEstimate>(`/api/generate/projects/${id}/estimate`);
  }

  async startGenerateBuild(id: string) {
    return this.request<{ version: GenVersion }>(`/api/generate/projects/${id}/versions`, { method: 'POST' });
  }

  async getGenerateVersion(id: string) {
    return this.request<{ version: GenVersion; verdicts: GenVerdict[] }>(`/api/generate/versions/${id}`);
  }

  async cancelGenerateVersion(id: string) {
    return this.request<{ version: GenVersion }>(`/api/generate/versions/${id}/cancel`, { method: 'POST' });
  }

  async retryGenerateVersion(id: string) {
    return this.request<{ version: GenVersion }>(`/api/generate/versions/${id}/retry`, { method: 'POST' });
  }

  async acceptGenerateVersion(id: string) {
    return this.request<{ project: GenProject }>(`/api/generate/versions/${id}/accept`, { method: 'POST' });
  }

  async fixGenerateVersion(id: string, body: GenFixBody) {
    return this.request<GenFixResult>(`/api/generate/versions/${id}/fix`, { method: 'POST', body: JSON.stringify(body) });
  }

  async restoreGenerateVersion(id: string) {
    return this.request<{ project: GenProject }>(`/api/generate/versions/${id}/restore`, { method: 'POST' });
  }

  async listGenerateIdeas() {
    return this.request<{ ideas: GenIdea[] }>('/api/generate/ideas');
  }

  async addGenerateIdea(body: { slug: string; brief: string }) {
    return this.request<{ idea: GenIdea }>('/api/generate/ideas', { method: 'POST', body: JSON.stringify(body) });
  }

  async deleteGenerateIdea(id: string) {
    return this.request<{ deleted: boolean }>(`/api/generate/ideas/${id}`, { method: 'DELETE' });
  }

  /** One unattended run: the recipe's next new idea, or the named one (started or resumed). */
  async runGenerateIdea(body: { recipeId?: string; ideaId?: string }) {
    return this.request<{ project: GenProject }>('/api/generate/run', { method: 'POST', body: JSON.stringify(body) });
  }

  async listGenerateFacts(projectId: string) {
    return this.request<{ facts: GenFact[] }>(`/api/generate/projects/${projectId}/facts`);
  }

  async addGenerateFact(projectId: string, body: { claim: string; value?: string; sourceUrl: string }) {
    return this.request<{ fact: GenFact }>(`/api/generate/projects/${projectId}/facts`, { method: 'POST', body: JSON.stringify(body) });
  }

  async updateGenerateFact(id: string, body: { claim?: string; value?: string; sourceUrl?: string }) {
    return this.request<{ fact: GenFact }>(`/api/generate/facts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }

  async deleteGenerateFact(id: string) {
    return this.request<{ deleted: boolean }>(`/api/generate/facts/${id}`, { method: 'DELETE' });
  }

  async verifyGenerateFacts(projectId: string) {
    return this.request<{ facts: GenFact[] }>(`/api/generate/projects/${projectId}/facts/verify`, { method: 'POST' });
  }

  async getGenerateSteps() {
    return this.request<{ steps: GenStepSpec[] }>('/api/generate/steps');
  }

  async listGenerateRecipes() {
    return this.request<{ recipes: GenRecipeItem[] }>('/api/generate/recipes');
  }

  async validateGenerateRecipe(recipe: GenRecipe) {
    return this.request<{ ok: boolean; errors: string[]; warnings: string[] }>('/api/generate/recipes/validate', { method: 'POST', body: JSON.stringify({ recipe }) });
  }

  async copyGenerateRecipe(fromId: string, id: string, name: string) {
    return this.request<{ recipe: { id: string } }>('/api/generate/recipes', { method: 'POST', body: JSON.stringify({ fromId, id, name }) });
  }

  async saveGenerateRecipe(id: string, recipe: GenRecipe) {
    return this.request<{ recipe: { id: string } }>(`/api/generate/recipes/${id}`, { method: 'PUT', body: JSON.stringify({ recipe }) });
  }

  async deleteGenerateRecipe(id: string) {
    return this.request<{ deleted: boolean }>(`/api/generate/recipes/${id}`, { method: 'DELETE' });
  }

  async importGenerateRecipe(recipe: GenRecipe) {
    return this.request<{ recipe: { id: string } }>('/api/generate/recipes/import', { method: 'POST', body: JSON.stringify({ recipe }) });
  }

  generateRecipeExportUrl(id: string) {
    return `${this.baseUrl}/api/generate/recipes/${id}/export`;
  }

  async exportGenerateVersion(versionId: string, body: { title?: string; description?: string } = {}) {
    return this.request<{ export: GenExport }>(`/api/generate/versions/${versionId}/export`, { method: 'POST', body: JSON.stringify(body) });
  }

  async generateExports() {
    return this.request<{ exports: GenExport[] }>('/api/generate/exports');
  }

  /** An exported video, for a <video> element or (download) a link. */
  generateExportUrl(exportId: string, download = false) {
    return `${this.baseUrl}/api/generate/exports/${exportId}/file${download ? '?download=1' : ''}`;
  }

  /** The rendered video of a version, for a <video> element. */
  generateDraftUrl(versionId: string) {
    return `${this.baseUrl}/api/generate/versions/${versionId}/draft`;
  }

  // ---- the kit and director levels ----

  async kitParts() {
    return this.request<{ parts: GenKitPart[] }>('/api/generate/kit');
  }

  async addKitPart(file: File) {
    const form = new FormData();
    form.set('file', file);
    return this.request<{ part: GenKitPart }>('/api/generate/kit', { method: 'POST', body: form, headers: {} });
  }

  async removeKitPart(name: string) {
    return this.request<{ deleted: boolean }>(`/api/generate/kit/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  kitPartExportUrl(name: string) {
    return `${this.baseUrl}/api/generate/kit/${encodeURIComponent(name)}/export`;
  }

  async generateModels() {
    return this.request<GenModels>('/api/generate/models');
  }

  async calibrateModel() {
    return this.request<{ run: GenModels['calibration'] }>('/api/generate/models/calibrate', { method: 'POST', body: '{}' });
  }

  async pinModel(model: string, level: GenLevel | null) {
    return this.request<{ model: GenModels['models'][number] }>(`/api/generate/models/${encodeURIComponent(model)}/level`, { method: 'PUT', body: JSON.stringify({ level }) });
  }

  async getGenerateEvents(id: string, limit = 100) {
    return this.request<{ events: GenEvent[] }>(`/api/generate/projects/${id}/events?limit=${limit}`);
  }

  // ---- publishing (Tebar) ----

  async socialAccounts() {
    return this.request<{ enabled: boolean; accounts: SocialAccount[] }>('/api/social/accounts');
  }

  /** Where a clip's or a generated export's publishing routes live. */
  private subjectPath(id: string, kind: 'clip' | 'generated') {
    return kind === 'clip' ? `/api/clips/${id}` : `/api/generate/exports/${id}`;
  }

  async publishDraft(clipId: string, accountIds: string[], kind: 'clip' | 'generated' = 'clip') {
    return this.request<PublishDraft>(`${this.subjectPath(clipId, kind)}/publish/draft`, { method: 'POST', body: JSON.stringify({ accountIds }) });
  }

  async publish(clipId: string, body: {
    targets: Array<{
      accountId: string; content: string; title?: string; madeForKids?: boolean; privacyLevel?: string; postMode?: 'direct' | 'draft';
    }>;
    scheduledAt?: string; confirmReview?: boolean; override?: boolean;
  }, kind: 'clip' | 'generated' = 'clip') {
    return this.request<{ post: SocialPost }>(`${this.subjectPath(clipId, kind)}/publish`, { method: 'POST', body: JSON.stringify(body) });
  }

  async clipPosts(clipId: string, kind: 'clip' | 'generated' = 'clip') {
    return this.request<{ posts: SocialPost[] }>(`${this.subjectPath(clipId, kind)}/posts`);
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
