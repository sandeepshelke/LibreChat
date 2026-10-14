import type { UIResource } from 'librechat-data-provider';
import { isMcpAppResource } from './mcpApps';

/** Only deployment-approved video-job Apps can replace a tool's visible result. */
export function getInlineVideoKey(
  resource: UIResource,
  servers: readonly string[] | undefined,
): string | undefined {
  if (
    !resource.serverName ||
    !servers?.includes(resource.serverName) ||
    !isMcpAppResource(resource) ||
    resource.isError ||
    !['generate_video', 'play_video'].includes(resource.toolName ?? '')
  ) {
    return;
  }
  const job = resource.structuredContent;
  if (
    typeof job?.videoId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(job.videoId) ||
    job.videoUri !== `videos://${job.videoId}` ||
    job.statusUri !== `video-jobs://${job.videoId}`
  ) {
    return;
  }
  return JSON.stringify(['video', resource.serverName, resource.serverBinding, job.videoId]);
}
